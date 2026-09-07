import { and, desc, eq, sql } from "drizzle-orm";

import { db, featureMetrics } from "@/db";

import { env } from "./env";

/**
 * Where a new show gets rendered.
 *
 * "workflow": the create action starts the Vercel workflow in-process (local
 * development, or a host whose functions may run for as long as a step needs).
 *
 * "queue": the create action only inserts the row. A render worker
 * (scripts/render-worker.ts) running on a machine without a function timeout
 * polls the same database, claims pending shows and runs the pipeline there,
 * writing the same status column the progress page already polls. Vercel stops
 * a function at 300 s while one Speech 2.8 line can wait five minutes in GMI's
 * queue, so on Vercel this is the only way a long episode finishes.
 */
export type GenerationDispatch = "workflow" | "queue";

export function generationDispatch(): GenerationDispatch {
  return env.GENERATION_DISPATCH === "queue" ? "queue" : "workflow";
}

/** feature_metrics row family the worker heartbeats into. */
export const RENDER_WORKER_FEATURE = "render-worker";

/** A worker that has not been heard from for this long is offline. */
export const RENDER_WORKER_STALE_MS = 90_000;

export interface WorkerPresence {
  online: boolean;
  /** Seconds since the last heartbeat, or null when no worker was ever seen. */
  secondsAgo: number | null;
}

/** Records that a worker is alive: one row per worker, refreshed in place. */
export async function recordWorkerHeartbeat(workerId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const updated = await db
    .update(featureMetrics)
    .set({ createdAt: sql`now()`, metadata })
    .where(and(eq(featureMetrics.feature, RENDER_WORKER_FEATURE), eq(featureMetrics.identifier, workerId)))
    .returning({ id: featureMetrics.id });
  if (updated.length === 0) {
    await db.insert(featureMetrics).values({ feature: RENDER_WORKER_FEATURE, identifier: workerId, metadata });
  }
}

/** Whether any render worker has reported in recently. */
export async function workerPresence(): Promise<WorkerPresence> {
  const [latest] = await db
    .select({ createdAt: featureMetrics.createdAt })
    .from(featureMetrics)
    .where(eq(featureMetrics.feature, RENDER_WORKER_FEATURE))
    .orderBy(desc(featureMetrics.createdAt))
    .limit(1);
  if (!latest?.createdAt) {
    return { online: false, secondsAgo: null };
  }
  const ageMs = Date.now() - latest.createdAt.getTime();
  return { online: ageMs < RENDER_WORKER_STALE_MS, secondsAgo: Math.max(0, Math.round(ageMs / 1000)) };
}
