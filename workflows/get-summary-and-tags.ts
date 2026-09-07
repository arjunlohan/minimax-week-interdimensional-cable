import { getWritable } from "workflow";
import { z } from "zod";

import { closeStream, sleepMs, writeToStream } from "./workflow-progress";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SummaryTone = "neutral" | "professional" | "playful";

export interface GetSummaryAndTagsOptions {
  /** Voice of the generated copy (defaults to "neutral"). */
  tone?: SummaryTone;
}

export interface GetSummaryAndTagsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Short headline for the talk. */
  title: string;
  /** Longer description of what the transcript covers. */
  description: string;
  /** Up to 10 keywords. */
  tags: string[];
  /** The plain-text transcript the summary was written from. */
  transcriptText: string;
  /** Where the transcript came from: the imported row or a Mux text track. */
  transcriptSource: "database" | "mux";
}

export type SummaryStepId = "prepare" | "generate" | "finalize";

export interface SummaryWorkflowResult {
  success: boolean;
  currentStep: SummaryStepId;
  completedSteps: SummaryStepId[];
  result?: GetSummaryAndTagsResult;
  error?: string;
}

interface SummaryProgressEvent {
  type: "current" | "completed";
  step: SummaryStepId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript and prompt helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_TAG_LIMIT = 10;

/** Roughly 100k tokens; M3 takes far more, but a talk never needs it. */
const MAX_TRANSCRIPT_CHARS = 400_000;

const SummarySchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).min(1).max(SUMMARY_TAG_LIMIT),
});

/**
 * Strips a WebVTT document down to its spoken text. A cue block is the timing
 * line plus the text under it; anything above the timing line is a cue
 * identifier, and blocks with no timing line (the WEBVTT header, NOTE, STYLE,
 * REGION) carry no speech. Inline voice and style tags are removed.
 */
export function vttToPlainText(vtt: string): string {
  const spoken: string[] = [];

  for (const block of vtt.split(/\r?\n\s*\n/)) {
    const lines = block.split(/\r?\n/).map(l => l.trim());
    const timingIndex = lines.findIndex(l => l.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }
    for (const line of lines.slice(timingIndex + 1)) {
      const text = line.replace(/<[^>]+>/g, "").trim();
      if (text) {
        spoken.push(text);
      }
    }
  }

  return spoken.join(" ").replace(/\s+/g, " ").trim();
}

const TONE_DIRECTIONS: Record<SummaryTone, string> = {
  neutral: "Write in a neutral, plain-spoken register: describe what the talk covers without selling it.",
  professional: "Write in a polished, professional register suitable for a conference programme or an executive briefing.",
  playful: "Write in a playful, lively register with wit and energy, while staying accurate to the transcript.",
};

export function buildSummaryPrompt(transcript: string, tone: SummaryTone): { system: string; prompt: string } {
  const system = `You write metadata for recorded talks from their transcripts.
${TONE_DIRECTIONS[tone]}
Everything you write must be supported by the transcript. Do not add facts, names, or claims the speaker did not make.`;

  const prompt = `Read the transcript and return JSON with exactly these keys:
- "title": a specific headline of at most 12 words
- "summary": 2 to 4 sentences describing what the talk covers and its main argument
- "tags": ${SUMMARY_TAG_LIMIT} or fewer lowercase keywords or short phrases, most relevant first, no duplicates

TRANSCRIPT:
${transcript}`;

  return { system, prompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow
// ─────────────────────────────────────────────────────────────────────────────

export async function getSummaryAndTagsWorkflow(
  assetId: string,
  options?: GetSummaryAndTagsOptions,
): Promise<SummaryWorkflowResult> {
  "use workflow";

  const completedSteps: SummaryStepId[] = [];
  const progress = getWritable<SummaryProgressEvent>({ namespace: "progress" });

  try {
    await prepareSummaryStep(progress, assetId);
    completedSteps.push("prepare");

    const result = await generateSummaryAndTagsStep(progress, assetId, options);
    completedSteps.push("generate");

    await finalizeSummaryStep(progress);
    completedSteps.push("finalize");

    return {
      success: true,
      currentStep: "finalize",
      completedSteps,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Summary workflow failed";

    try {
      await closeStream(progress);
    } catch {
      // ignore - stream may already be closed or in an invalid state
    }

    return {
      success: false,
      currentStep: completedSteps.at(-1) ?? "prepare",
      completedSteps,
      error: message,
    };
  }
}

async function prepareSummaryStep(
  progress: WritableStream<SummaryProgressEvent>,
  assetId: string,
): Promise<void> {
  "use step";
  await writeToStream(progress, { type: "current", step: "prepare" });
  if (!assetId) {
    throw new Error("Missing required parameters for summary generation");
  }
  await sleepMs(250);
  await writeToStream(progress, { type: "completed", step: "prepare" });
}

/**
 * Finds the talk's transcript: the imported row first, then the asset's text
 * track on Mux. There is no third option; a talk with neither cannot be
 * summarised, and saying so beats writing metadata for a video nobody read.
 */
async function loadTranscript(assetId: string): Promise<{ text: string; source: "database" | "mux" }> {
  const { eq } = await import("drizzle-orm");
  const { db, videos } = await import("@/db");

  const [row] = await db
    .select({ transcriptVtt: videos.transcriptVtt })
    .from(videos)
    .where(eq(videos.muxAssetId, assetId))
    .limit(1);

  const stored = row?.transcriptVtt ? vttToPlainText(row.transcriptVtt) : "";
  if (stored) {
    return { text: stored, source: "database" };
  }

  const { findTextTrack, getPlaybackIdForAsset, getTranscript } = await import("@/app/lib/mux");
  const { asset, playbackId } = await getPlaybackIdForAsset(assetId);
  const track = findTextTrack(asset, "en") ?? findTextTrack(asset);
  if (!track?.id) {
    throw new Error(
      `Asset ${assetId} has no transcript: nothing is stored in the database and Mux has no ready text track. ` +
      "Run `npm run import-mux-assets` after enabling auto-generated subtitles on the asset, then try again.",
    );
  }

  const fetched = (await getTranscript(playbackId, track.id)).replace(/\s+/g, " ").trim();
  if (!fetched) {
    throw new Error(`Asset ${assetId} has a text track (${track.id}) but it returned no transcript text, so there is nothing to summarise.`);
  }
  return { text: fetched, source: "mux" };
}

async function generateSummaryAndTagsStep(
  progress: WritableStream<SummaryProgressEvent>,
  assetId: string,
  options?: GetSummaryAndTagsOptions,
): Promise<GetSummaryAndTagsResult> {
  "use step";
  await writeToStream(progress, { type: "current", step: "generate" });

  const tone: SummaryTone = options?.tone ?? "neutral";
  const transcript = await loadTranscript(assetId);
  const transcriptText = transcript.text.length > MAX_TRANSCRIPT_CHARS ?
    `${transcript.text.slice(0, MAX_TRANSCRIPT_CHARS)} [transcript truncated]` :
    transcript.text;

  const { generateJson } = await import("@/app/lib/gmi/text");
  const { system, prompt } = buildSummaryPrompt(transcriptText, tone);
  const generated = await generateJson({
    schema: SummarySchema,
    label: `summary-and-tags:${tone}`,
    system,
    prompt,
    temperature: tone === "playful" ? 0.8 : 0.4,
    maxOutputTokens: 2048,
  });

  const tags = [...new Set(generated.tags.map(t => t.toLowerCase()))].slice(0, SUMMARY_TAG_LIMIT);

  await writeToStream(progress, { type: "completed", step: "generate" });
  return {
    assetId,
    title: generated.title,
    description: generated.summary,
    tags,
    transcriptText,
    transcriptSource: transcript.source,
  };
}

async function finalizeSummaryStep(progress: WritableStream<SummaryProgressEvent>): Promise<void> {
  "use step";
  await writeToStream(progress, { type: "current", step: "finalize" });
  await sleepMs(150);
  await writeToStream(progress, { type: "completed", step: "finalize" });
  await closeStream(progress);
}
