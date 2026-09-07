import { eq, sql } from "drizzle-orm";

import { env } from "@/app/lib/env";
import { db, gmiSpend } from "@/db";

/**
 * Spend guard for MiniMax-H3, the only paid model in the pipeline.
 *
 * Every H3 submission is written to `gmi_spend` before it is sent, so a crash
 * after submission still counts. Two caps, both refusing rather than degrading:
 * a per-show cap (a runaway retry loop cannot burn the budget on one episode)
 * and an all-time cap for this database (the hackathon top-up).
 */

export const H3_MODEL_ID = "MiniMax-H3";
export const H3_COST_CENTS = 13;

export const DEFAULT_H3_MAX_REQUESTS_PER_RUN = 14;
export const DEFAULT_H3_SESSION_CAP_USD = 8;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function h3RunCap(): number {
  const parsed = Number(env.H3_MAX_REQUESTS_PER_RUN);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_H3_MAX_REQUESTS_PER_RUN;
}

export function h3SessionCapUsd(): number {
  const parsed = Number(env.H3_SESSION_CAP_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_H3_SESSION_CAP_USD;
}

export interface SpendSummary {
  requests: number;
  cents: number;
  usd: number;
  capUsd: number;
  remainingRequests: number;
}

export async function getH3SpendSummary(): Promise<SpendSummary> {
  const [row] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${gmiSpend.costCents}), 0)::int`,
    })
    .from(gmiSpend)
    .where(eq(gmiSpend.model, H3_MODEL_ID));
  const cents = row?.cents ?? 0;
  const capUsd = h3SessionCapUsd();
  return {
    requests: row?.requests ?? 0,
    cents,
    usd: cents / 100,
    capUsd,
    remainingRequests: Math.max(0, Math.floor((capUsd * 100 - cents) / H3_COST_CENTS)),
  };
}

export async function countH3RequestsForShow(showId: string): Promise<number> {
  const [row] = await db
    .select({ requests: sql<number>`count(*)::int` })
    .from(gmiSpend)
    .where(sql`${gmiSpend.model} = ${H3_MODEL_ID} and ${gmiSpend.showId} = ${showId}`);
  return row?.requests ?? 0;
}

/**
 * Throws before a request that would breach either cap. Call this immediately
 * before `recordH3Request`; the pair is not atomic, which is acceptable because
 * clips are generated sequentially.
 */
export async function assertH3Budget(showId?: string | null): Promise<void> {
  const summary = await getH3SpendSummary();
  if (summary.cents + H3_COST_CENTS > summary.capUsd * 100) {
    throw new BudgetExceededError(
      `MiniMax-H3 session cap reached: $${summary.usd.toFixed(2)} of $${summary.capUsd.toFixed(2)} spent across ${summary.requests} requests. ` +
      "Raise H3_SESSION_CAP_USD after topping up GMI Cloud, or generate an audio episode instead.",
    );
  }
  if (showId) {
    const used = await countH3RequestsForShow(showId);
    const cap = h3RunCap();
    if (used >= cap) {
      throw new BudgetExceededError(
        `This show has already issued ${used} MiniMax-H3 requests, the per-run cap (H3_MAX_REQUESTS_PER_RUN=${cap}). ` +
        "Shorten the episode or raise the cap.",
      );
    }
  }
}

export async function recordH3Request(input: { showId?: string | null; requestId: string; status?: string }): Promise<void> {
  await db.insert(gmiSpend).values({
    showId: input.showId ?? null,
    model: H3_MODEL_ID,
    requestId: input.requestId,
    costCents: H3_COST_CENTS,
    status: input.status ?? "submitted",
  });
}

export async function updateH3RequestStatus(requestId: string, status: string): Promise<void> {
  await db.update(gmiSpend).set({ status }).where(eq(gmiSpend.requestId, requestId));
}
