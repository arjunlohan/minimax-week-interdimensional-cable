"use server";

import { asc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  encryptApiKeys,
  looksLikeGmiKey,
  MissingApiKeyError,
  requiresUserApiKeys,
} from "@/app/lib/api-keys";
import { env } from "@/app/lib/env";
import { recordMemorySignal, topicToKey } from "@/app/lib/memory-bank";
import * as schema from "@/db/schema";
import type { ShowTemplate } from "@/db/schema";

import { durationOptionsFor, isValidDuration } from "./constants";
import type { ShowFormat } from "./constants";

const pool = new Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool, { schema });

// ─────────────────────────────────────────────────────────────────────────────
// Get Templates
// ─────────────────────────────────────────────────────────────────────────────

/** Templates ranked at or above this are legacy rows hidden from the picker. */
const LEGACY_TEMPLATE_RANK = 100;

export async function getTemplatesAction(): Promise<ShowTemplate[]> {
  try {
    // Rows ranked 100 and above are legacy templates kept only so episodes made
    // before the rebuild keep their format; they are not offered for new shows.
    const templates = await db
      .select()
      .from(schema.showTemplates)
      .where(lt(schema.showTemplates.displayOrder, LEGACY_TEMPLATE_RANK))
      .orderBy(asc(schema.showTemplates.displayOrder), asc(schema.showTemplates.createdAt));

    return templates;
  } catch (error) {
    console.error("Failed to fetch templates:", error);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Show
// ─────────────────────────────────────────────────────────────────────────────

interface CreateShowInput {
  templateId: string;
  topic: string;
  topicType: string;
  /** Decides the pipeline: MiniMax-H3 clips, or a Speech 2.8 HD episode with no video. */
  format: ShowFormat;
  /** Must be one of the format's duration options; video and audio scales differ. */
  durationSeconds: number;
  familiarity: string;
  /** Video only. Ignored for audio, which has no clips to chain. */
  useFrameChaining?: boolean;
  /** Visitor-supplied GMI Cloud key. Required when REQUIRE_USER_API_KEYS is on. */
  gmiKey?: string;
}

interface CreateShowResult {
  showId?: string;
  error?: string;
}

const VALID_FORMATS: ShowFormat[] = ["video", "audio"];

export async function createShowAction(formData: CreateShowInput): Promise<CreateShowResult> {
  // Validate input
  if (!formData.templateId || formData.templateId.trim().length === 0) {
    return { error: "Please select a template." };
  }

  if (!formData.topic || formData.topic.trim().length === 0) {
    return { error: "Please enter a topic." };
  }

  const validTopicTypes = ["freetext", "news_link", "hacker_news"];
  if (!validTopicTypes.includes(formData.topicType)) {
    return { error: "Invalid topic type." };
  }

  if (!VALID_FORMATS.includes(formData.format)) {
    return { error: "Invalid format. Choose a video or an audio episode." };
  }

  if (!isValidDuration(formData.format, formData.durationSeconds)) {
    const allowed = durationOptionsFor(formData.format).map(o => o.label).join(", ");
    return { error: `Invalid duration for a ${formData.format} episode. Choose one of: ${allowed}.` };
  }

  const validFamiliarities = ["beginner", "familiar", "expert"];
  if (!validFamiliarities.includes(formData.familiarity)) {
    return { error: "Invalid familiarity level." };
  }

  // Model inference is the dominant running cost, so a public deployment makes
  // the visitor bring their own GMI Cloud key and GMI bills them directly.
  const gmiKey = formData.gmiKey?.trim() || undefined;
  if (requiresUserApiKeys() && !gmiKey) {
    return { error: new MissingApiKeyError().message };
  }
  if (gmiKey && !looksLikeGmiKey(gmiKey)) {
    return {
      error: "That does not look like a GMI Cloud API key: keys are at least 20 characters with no spaces. " +
        "Copy it again from console.gmicloud.ai (Settings, API keys).",
    };
  }

  // Frame chaining only means something when there are clips to chain.
  const useFrameChaining = formData.format === "video" && (formData.useFrameChaining ?? false);

  try {
    // Inside the try so a missing KEY_ENCRYPTION_SECRET reads as a clear error
    // on the form rather than an opaque server action failure.
    const encryptedApiKeys = gmiKey ? encryptApiKeys({ gmiKey }) : null;

    const [show] = await db
      .insert(schema.generatedShows)
      .values({
        templateId: formData.templateId,
        topic: formData.topic.trim(),
        topicType: formData.topicType,
        format: formData.format,
        durationSeconds: formData.durationSeconds,
        familiarity: formData.familiarity,
        useFrameChaining,
        status: "pending",
        encryptedApiKeys,
        // Without this the dramaturgy orchestrator skips the personalization
        // branch entirely, so the memory bank is recalled and displayed but
        // never reaches a generated episode.
        userId: "default_user",
      })
      .returning({ id: schema.generatedShows.id });

    // Learn from what was asked for. This is unambiguous signal handed to us
    // directly, so it needs no extraction call.
    void recordMemorySignal("default_user", {
      memoryType: "interest_topic",
      key: topicToKey(formData.topic),
      value: `Requested a show about "${formData.topic.trim()}"`,
      sourceShowId: show.id,
    });
    void recordMemorySignal("default_user", {
      memoryType: "custom_note",
      key: `format-${formData.format}`,
      value: `Prefers ${formData.format} episodes (${formData.durationSeconds}s), ${formData.familiarity} level`,
      sourceShowId: show.id,
    });

    // Start the generation workflow
    try {
      const workflowUrl = `${env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/workflows/generate-show`;
      console.log("[createShowAction] Starting workflow at:", workflowUrl, "showId:", show.id);

      const res = await fetch(workflowUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showId: show.id }),
      });
      const data = await res.json();
      console.log("[createShowAction] Workflow response:", res.status, JSON.stringify(data));

      if (data.runId) {
        await db
          .update(schema.generatedShows)
          .set({ workflowRunId: data.runId })
          .where(eq(schema.generatedShows.id, show.id));
        console.log("[createShowAction] Saved runId:", data.runId);
      } else if (data.error) {
        console.error("[createShowAction] Workflow returned error:", data.error);
      }
    } catch (err) {
      console.error("[createShowAction] Failed to start generation workflow:", err);
      // Show was created; the user can retry from the progress page
    }

    return { showId: show.id };
  } catch (error) {
    console.error("Failed to create show:", error);
    const message = error instanceof Error ? error.message : "Failed to create show.";
    return { error: message };
  }
}
