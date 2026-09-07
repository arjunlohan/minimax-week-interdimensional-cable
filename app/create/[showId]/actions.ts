"use server";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/app/lib/env";
import { generationDispatch, workerPresence } from "@/app/lib/render-worker";
import * as schema from "@/db/schema";
import type { GeneratedShow, ShowTemplate } from "@/db/schema";

const pool = new Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool, { schema });

export interface ShowWithTemplate {
  show: GeneratedShow;
  template: ShowTemplate;
}

export async function getShowWithTemplateAction(showId: string): Promise<ShowWithTemplate | null> {
  try {
    const show = await db.query.generatedShows.findFirst({
      where: eq(schema.generatedShows.id, showId),
    });

    if (!show)
      return null;

    const template = await db.query.showTemplates.findFirst({
      where: eq(schema.showTemplates.id, show.templateId),
    });

    if (!template)
      return null;

    return { show, template };
  } catch (error) {
    console.error("Failed to fetch show:", error);
    return null;
  }
}

export interface QueueState {
  /** True while a render worker has reported in recently. */
  workerOnline: boolean;
  /** Seconds since the last heartbeat, or null when no worker was ever seen. */
  workerSeenSecondsAgo: number | null;
}

export async function pollShowStatusAction(showId: string): Promise<{
  status: string;
  error?: string;
  muxPlaybackId?: string;
  /** Present while the show waits for the render worker. */
  queue?: QueueState;
}> {
  try {
    const show = await db.query.generatedShows.findFirst({
      where: eq(schema.generatedShows.id, showId),
      columns: {
        status: true,
        error: true,
        muxPlaybackId: true,
      },
    });

    if (!show) {
      console.warn("[pollShowStatus] Show not found:", showId);
      return { status: "failed", error: "Show not found" };
    }

    console.log("[pollShowStatus] showId:", showId, "status:", show.status, show.error ? `error: ${show.error}` : "");

    let queue: QueueState | undefined;
    if (show.status === "pending" && generationDispatch() === "queue") {
      const presence = await workerPresence();
      queue = { workerOnline: presence.online, workerSeenSecondsAgo: presence.secondsAgo };
    }

    return {
      status: show.status,
      error: show.error ?? undefined,
      muxPlaybackId: show.muxPlaybackId ?? undefined,
      queue,
    };
  } catch (error) {
    console.error("[pollShowStatus] Failed:", error);
    return { status: "failed", error: "Failed to check status" };
  }
}
