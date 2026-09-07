/* eslint-disable no-console, node/no-process-env */
/**
 * The render worker: renders shows that the deployed site only queued.
 *
 * A Vercel function stops at 300 s, and one Speech 2.8 line can wait five
 * minutes in GMI's queue, so with GENERATION_DISPATCH=queue the site inserts
 * the show and leaves it pending. This process, on a machine with no timeout,
 * polls the same database, claims each pending show and starts the pipeline on
 * the local dev server, which must point at the same database:
 *
 *   npm run dev:hosted      # next dev with DATABASE_URL = VERCEL_DATABASE_URL
 *   npm run worker          # this script, beside it
 *
 * Every loop writes a heartbeat the progress page reads, so a visitor sees
 * "queued for the render worker" or "render worker offline" instead of a
 * spinner that never ends. Shows render one at a time: Speech 2.8 and Music
 * 3.0 already run several requests per show, and the queues rate-limit.
 */
import os from "node:os";

import dotenv from "dotenv";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../db/schema";

dotenv.config({ path: ".env.local" });

const DATABASE_URL = process.env.VERCEL_DATABASE_URL || process.env.DATABASE_URL;
const DEV_SERVER = process.env.RENDER_WORKER_DEV_SERVER || "http://localhost:3000";
const POLL_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const WORKER_ID = `${os.hostname()}:${process.pid}`;
const RENDER_WORKER_FEATURE = "render-worker";
const ACTIVE_STATUSES = ["researching", "scripting", "voicing", "generating", "scoring", "stitching", "uploading"];
const STARTED_AT = Date.now();

if (!DATABASE_URL) {
  console.error("Set VERCEL_DATABASE_URL (or DATABASE_URL) in .env.local: the worker must poll the database the site writes to.");
  process.exit(2);
}
if (/localhost|127\.0\.0\.1/.test(DATABASE_URL)) {
  console.warn("[worker] Polling a local database. The deployed site writes to the hosted one; set VERCEL_DATABASE_URL to serve it.");
}

// Hosted poolers drop idle connections; without a handler that ends the
// process. Release idle clients early and log the rest, the next query
// simply opens a fresh connection.
const pool = new Pool({ connectionString: DATABASE_URL, max: 2, idleTimeoutMillis: 20_000, keepAlive: true });
pool.on("error", (err) => {
  console.warn("[worker] idle database connection dropped:", err.message);
});
const db = drizzle(pool, { schema });
let lastHeartbeat = 0;

async function heartbeat(): Promise<void> {
  if (Date.now() - lastHeartbeat < HEARTBEAT_MS) {
    return;
  }
  const metadata = { devServer: DEV_SERVER, startedAt: new Date(STARTED_AT).toISOString() };
  const updated = await db
    .update(schema.featureMetrics)
    .set({ createdAt: sql`now()`, metadata })
    .where(and(eq(schema.featureMetrics.feature, RENDER_WORKER_FEATURE), eq(schema.featureMetrics.identifier, WORKER_ID)))
    .returning({ id: schema.featureMetrics.id });
  if (updated.length === 0) {
    await db.insert(schema.featureMetrics).values({ feature: RENDER_WORKER_FEATURE, identifier: WORKER_ID, metadata });
  }
  lastHeartbeat = Date.now();
}

/** True while a show started in the last two hours is still moving through the pipeline. */
async function somethingIsRendering(): Promise<boolean> {
  const [active] = await db
    .select({ id: schema.generatedShows.id })
    .from(schema.generatedShows)
    .where(and(
      inArray(schema.generatedShows.status, ACTIVE_STATUSES),
      gt(schema.generatedShows.createdAt, new Date(Date.now() - 2 * 60 * 60_000)),
    ))
    .limit(1);
  return Boolean(active);
}

/** Claims the oldest pending show of the last day, or returns null. */
async function claimNext(): Promise<{ id: string; topic: string } | null> {
  const [candidate] = await db
    .select({ id: schema.generatedShows.id, topic: schema.generatedShows.topic })
    .from(schema.generatedShows)
    .where(and(
      eq(schema.generatedShows.status, "pending"),
      isNull(schema.generatedShows.workflowRunId),
      gt(schema.generatedShows.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
    ))
    .orderBy(asc(schema.generatedShows.createdAt))
    .limit(1);
  if (!candidate) {
    return null;
  }
  // The claim is the atomic part: two workers cannot both win the same row.
  const claimed = await db
    .update(schema.generatedShows)
    .set({ workflowRunId: `claimed:${WORKER_ID}` })
    .where(and(eq(schema.generatedShows.id, candidate.id), isNull(schema.generatedShows.workflowRunId)))
    .returning({ id: schema.generatedShows.id });
  return claimed.length > 0 ? candidate : null;
}

async function release(showId: string): Promise<void> {
  await db.update(schema.generatedShows).set({ workflowRunId: null }).where(eq(schema.generatedShows.id, showId));
}

async function startOnDevServer(showId: string): Promise<string> {
  const response = await fetch(`${DEV_SERVER}/api/workflows/generate-show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showId }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({})) as { runId?: string; error?: string };
  if (!response.ok || !body.runId) {
    throw new Error(body.error || `dev server answered ${response.status}`);
  }
  return body.runId;
}

async function tick(): Promise<void> {
  await heartbeat();
  if (await somethingIsRendering()) {
    return;
  }
  const show = await claimNext();
  if (!show) {
    return;
  }
  console.log(`[worker] Claimed ${show.id.slice(0, 8)}: "${show.topic}"`);
  try {
    const runId = await startOnDevServer(show.id);
    await db.update(schema.generatedShows).set({ workflowRunId: runId }).where(eq(schema.generatedShows.id, show.id));
    console.log(`[worker] Started run ${runId} for ${show.id.slice(0, 8)} on ${DEV_SERVER}`);
  } catch (err) {
    await release(show.id);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Could not start ${show.id.slice(0, 8)} (${message}). Is the dev server up? Run: npm run dev:hosted`);
  }
}

async function main(): Promise<void> {
  console.log(`[worker] ${WORKER_ID} polling every ${POLL_MS / 1000}s, starting shows on ${DEV_SERVER}`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      // drizzle wraps driver errors; the cause says whether it was a dropped
      // connection, a timeout or something that needs a look.
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      console.error("[worker] tick failed:", (err instanceof Error ? err.message : String(err)).slice(0, 120) + cause);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

process.on("SIGINT", () => {
  console.log("\n[worker] stopping");
  pool.end().finally(() => process.exit(0));
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
