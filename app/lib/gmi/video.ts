/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";

import { env } from "@/app/lib/env";
import { probeMedia } from "@/app/lib/media";

import { downloadToFile, firstMediaUrl, runQueued, tmpPath } from "./queue";
import type { GmiRequestRecord } from "./queue";
import { assertH3Budget, H3_MODEL_ID, recordH3Request, updateH3RequestStatus } from "./spend";
import { uploadFileToGmi } from "./upload";

export { GmiContentFilterError, GmiRequestFailedError } from "./queue";

/**
 * MiniMax-H3 on the GMI Cloud request queue.
 *
 * Payload (per docs.gmicloud.ai/model-quickstarts/video/minimax-h3):
 *   prompt, resolution ("768P" | "2K"), duration (4..15 s), ratio,
 *   first_frame_image / last_frame_image (URLs),
 *   reference_images (<= 9) / reference_videos (<= 3) / reference_audios (<= 3, 2..15 s each).
 * Frame-based inputs and reference-media inputs cannot be mixed in one request.
 */

export type H3Resolution = "768P" | "2K";
export type H3Ratio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9";

export const H3_MIN_DURATION = 4;
export const H3_MAX_DURATION = 15;

export interface H3ClipRequest {
  prompt: string;
  durationSeconds: number;
  resolution?: H3Resolution;
  ratio?: H3Ratio;
  /** Public URLs of portraits the characters should match (reference mode). */
  referenceImageUrls?: string[];
  /** Public URLs of spoken lines the character should perform (reference mode). */
  referenceAudioUrls?: string[];
  /** Public URL of the frame the clip must start on (frame mode). */
  firstFrameUrl?: string;
  /** Public URL of the frame the clip must end on (frame mode). */
  lastFrameUrl?: string;
  /** Show this request is billed against, for the per-run cap. */
  showId?: string | null;
  outputPath?: string;
  onPoll?: (record: GmiRequestRecord, elapsedMs: number) => void;
}

export interface H3ClipResult {
  localPath: string;
  /** Alias kept for callers that stored the remote URL before. */
  videoUrl: string;
  remoteUrl: string;
  thumbnailUrl?: string;
  requestId: string;
  /** Measured from the file, not the request. */
  durationSeconds: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
  generationMs: number;
}

export function defaultResolution(): H3Resolution {
  return env.H3_RESOLUTION === "2K" ? "2K" : "768P";
}

export function clampDuration(seconds: number): number {
  const rounded = Math.ceil(Number.isFinite(seconds) ? seconds : 8);
  return Math.min(H3_MAX_DURATION, Math.max(H3_MIN_DURATION, rounded));
}

/** Builds the request-queue payload and enforces H3's input rules up front. */
export function buildH3Payload(request: H3ClipRequest): Record<string, unknown> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error("MiniMax-H3 needs a non-empty prompt");
  }
  if (prompt.length > 7000) {
    throw new Error(`MiniMax-H3 prompt is ${prompt.length} characters; the limit is 7000`);
  }

  const referenceImages = (request.referenceImageUrls ?? []).filter(Boolean);
  const referenceAudios = (request.referenceAudioUrls ?? []).filter(Boolean);
  const usesReferences = referenceImages.length > 0 || referenceAudios.length > 0;
  const usesFrames = Boolean(request.firstFrameUrl || request.lastFrameUrl);
  if (usesReferences && usesFrames) {
    throw new Error("MiniMax-H3 cannot combine first/last frame inputs with reference images or audio in one request; pick one mode per clip");
  }
  if (referenceImages.length > 9) {
    throw new Error(`MiniMax-H3 accepts at most 9 reference images, got ${referenceImages.length}`);
  }
  if (referenceAudios.length > 3) {
    throw new Error(`MiniMax-H3 accepts at most 3 reference audio files, got ${referenceAudios.length}`);
  }

  const payload: Record<string, unknown> = {
    prompt,
    resolution: request.resolution ?? defaultResolution(),
    duration: clampDuration(request.durationSeconds),
  };
  // Image-driven requests take their aspect from the image; text-to-video must state it.
  if (!usesFrames) {
    payload.ratio = request.ratio ?? "16:9";
  }
  if (request.firstFrameUrl) {
    payload.first_frame_image = request.firstFrameUrl;
  }
  if (request.lastFrameUrl) {
    payload.last_frame_image = request.lastFrameUrl;
  }
  if (referenceImages.length > 0) {
    payload.reference_images = referenceImages;
  }
  if (referenceAudios.length > 0) {
    payload.reference_audios = referenceAudios;
  }
  return payload;
}

/**
 * Generates one clip: budget check, submit, poll, download, probe.
 * Content refusals surface as `GmiContentFilterError` so the caller can revise
 * the line and retry; everything else is a hard failure.
 */
export async function generateH3Clip(request: H3ClipRequest): Promise<H3ClipResult> {
  const payload = buildH3Payload(request);
  await assertH3Budget(request.showId);

  const startedAt = Date.now();
  console.log(`[gmi:h3] Submitting ${payload.duration}s clip at ${payload.resolution} (${request.referenceImageUrls?.length ?? 0} ref images, ${request.referenceAudioUrls?.length ?? 0} ref audio, frames: ${Boolean(request.firstFrameUrl || request.lastFrameUrl)})`);

  let requestId = "";
  let record: GmiRequestRecord;
  try {
    record = await runQueued(H3_MODEL_ID, payload, {
      pollMs: 5_000,
      timeoutMs: 20 * 60_000,
      onSubmit: async (submitted) => {
        requestId = submitted.request_id;
        await recordH3Request({ showId: request.showId, requestId, status: String(submitted.status) });
      },
      onPoll: (polled, elapsedMs) => {
        if (Math.round(elapsedMs / 1000) % 30 === 0) {
          console.log(`[gmi:h3] ${polled.request_id} ${polled.status} after ${Math.round(elapsedMs / 1000)}s`);
        }
        request.onPoll?.(polled, elapsedMs);
      },
    });
  } catch (err) {
    if (requestId) {
      await updateH3RequestStatus(requestId, "failed").catch(() => undefined);
    }
    throw err;
  }

  const remoteUrl = firstMediaUrl(record, "video");
  const localPath = request.outputPath ?? tmpPath("h3-clip", "mp4");
  await downloadToFile(remoteUrl, localPath);
  await updateH3RequestStatus(record.request_id, "success").catch(() => undefined);

  const probe = await probeMedia(localPath);
  const generationMs = Date.now() - startedAt;
  console.log(`[gmi:h3] Clip ready in ${Math.round(generationMs / 1000)}s: ${localPath} (${probe.durationSeconds?.toFixed(1) ?? "?"}s, audio: ${probe.hasAudio}, ${probe.width ?? "?"}x${probe.height ?? "?"})`);

  return {
    localPath,
    videoUrl: localPath,
    remoteUrl,
    thumbnailUrl: typeof record.outcome?.thumbnail_image_url === "string" ? record.outcome.thumbnail_image_url : undefined,
    requestId: record.request_id,
    durationSeconds: probe.durationSeconds ?? Number(payload.duration),
    hasAudio: probe.hasAudio,
    width: probe.width,
    height: probe.height,
    generationMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference portraits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a template's `referenceImageUrl` ("/templates/dual-anchor-desk.jpg")
 * to a file under public/ and uploads it. Uploads are content-addressed and
 * cached, so every clip of a show shares one URL.
 */
export async function referencePortraitUrls(referenceImageUrl: string | null | undefined): Promise<string[]> {
  if (!referenceImageUrl) {
    return [];
  }
  if (/^https?:\/\//i.test(referenceImageUrl)) {
    return [referenceImageUrl];
  }
  const relative = referenceImageUrl.replace(/^\/+/, "");
  const candidates = [
    path.join(process.cwd(), "public", relative),
    path.join(process.cwd(), relative),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    console.warn(`[gmi:h3] Reference image ${referenceImageUrl} not found on disk; generating without a portrait`);
    return [];
  }
  return [await uploadFileToGmi(found)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips network and performer names that trip likeness filters. Parody host
 * names are already fictional; this catches template notes that mention the
 * shows they riff on.
 */
export function sanitizeVisualPrompt(notes: string): string {
  return notes
    .replace(/\bHBO\b/gi, "premium cable")
    .replace(/\bNBC\b/gi, "broadcast network")
    .replace(/\bSNL\b/gi, "sketch comedy show")
    .replace(/\bSaturday Night Live\b/gi, "sketch comedy show")
    .replace(/\bLast Week Tonight\b/gi, "weekly investigative comedy show")
    .replace(/\bLate Night\b/gi, "late-night show")
    .replace(/\bWeekend Update\b/gi, "news desk comedy segment")
    .replace(/\bColin Jost\b/gi, "Colin")
    .replace(/\bMichael Che\b/gi, "Michael")
    .replace(/\bJohn Oliver\b/gi, "John")
    .replace(/\bSeth Meyers\b/gi, "Seth")
    .replace(/\bphotorealistic identical clone\b/gi, "face-consistent stylized character");
}

export interface ClipPromptInput {
  /** The line spoken in this clip. */
  text: string;
  speaker?: string;
  /** A visual direction from the head writer, used verbatim when present. */
  visualPrompt?: string;
  actingDirection?: string;
}

export interface ClipPromptContext {
  hosts: Array<{ name: string; personality?: string; position?: string }>;
  showType?: string | null;
  notes?: string | null;
  /** True when portraits are attached, so the prompt can ask for consistency. */
  hasReferencePortrait?: boolean;
  /** True when the line's audio is attached, so the prompt can ask the host to perform it. */
  hasReferenceAudio?: boolean;
}

/**
 * The prompt for one talk-show clip. H3 renders dialogue natively, so the
 * spoken line is spelled out; camera tags keep the framing stable across clips.
 */
export function buildClipPrompt(segment: ClipPromptInput, context: ClipPromptContext): string {
  const host = context.hosts.find(h => h.name === segment.speaker) ?? context.hosts[0] ?? { name: "Host" };
  const showType = context.showType ?? "monologue";
  const parts: string[] = [];

  if (segment.visualPrompt && segment.visualPrompt.trim().length >= 10) {
    parts.push(sanitizeVisualPrompt(segment.visualPrompt.trim()));
  } else {
    parts.push("A professional late-night talk show segment, single continuous take. [static]");
    if (showType === "conversation") {
      parts.push("Two hosts sit behind a news desk with a large graphic screen behind them, studio lighting, broadcast television production quality.");
      if (host.position === "left") {
        parts.push("The host on the LEFT is speaking and gesturing; the other listens and reacts.");
      } else if (host.position === "right") {
        parts.push("The host on the RIGHT is speaking and gesturing; the other listens and reacts.");
      }
    } else {
      parts.push("A single host behind a desk delivering a monologue to camera, a colorful graphic behind them, studio lighting, broadcast television production quality.");
    }
    if (context.notes) {
      parts.push(`Style: ${sanitizeVisualPrompt(context.notes)}.`);
    }
  }

  const delivery = segment.actingDirection?.trim();
  const line = segment.text.trim().replace(/\s+/g, " ");
  if (line) {
    parts.push(`${host.name} says${delivery ? ` (${sanitizeVisualPrompt(delivery)})` : ""}: "${line}"`);
  }
  if (context.hasReferenceAudio) {
    parts.push("The host performs exactly the attached spoken line, lips in sync with it, natural late-night comedic timing.");
  } else {
    parts.push("Natural late-night comedic timing; the host is animated, expressive and looks at camera.");
  }
  if (context.hasReferencePortrait) {
    parts.push("Keep the host's appearance, wardrobe, desk and studio exactly consistent with the reference image.");
  }

  return sanitizeVisualPrompt(parts.join(" ")).slice(0, 7000);
}
