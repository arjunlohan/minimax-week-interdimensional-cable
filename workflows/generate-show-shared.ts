import type { GenerationStepId } from "@/app/create/[showId]/constants";
import type { AudioLayout, EpisodeLayout } from "@/app/lib/assemble";

/**
 * Pure, Node-free half of the show pipeline: the types every step shares, the
 * tuning constants, and the arithmetic helpers (timing, voices, lyrics).
 *
 * The workflow function bundles this module, so nothing here may import a
 * Node.js module; anything that touches disk, ffmpeg, the database or GMI Cloud
 * lives in generate-show-steps.ts and is reached through dynamic imports
 * inside "use step" functions.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateShowResult {
  success: boolean;
  currentStep: GenerationStepId;
  completedSteps: GenerationStepId[];
  error?: string;
}

export interface ProgressEvent {
  type: "current" | "completed";
  step: GenerationStepId;
}

export type ShowFormat = "video" | "audio";
export type AudioStrategy = "reference" | "native" | "overlay";
export type ClipAudioSource = "h3" | "tts-overlay";
/** How a clip's request was conditioned: portraits and line audio, a previous tail frame, or the prompt alone. */
export type ClipMode = "reference" | "frame" | "prompt";

export interface TranscriptSegment {
  speaker: string;
  text: string;
  startTime?: number;
  endTime?: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
  clipIndex?: number;
  visualPrompt?: string;
  actingDirection?: string;
  durationSeconds?: number;
  acousticTags?: string[];
  wordCount?: number;
  position?: string;
}

export interface Host {
  name: string;
  personality?: string;
  position?: string;
  ttsVoice?: string;
  voice?: string;
}

/** One spoken line, synthesized by Speech 2.8 HD and kept on disk for the clip step. */
export interface VoicedLine {
  segmentIndex: number;
  speaker: string;
  voiceId: string;
  emotion: string;
  text: string;
  /** mp3 on disk. */
  audioPath: string;
  /** Measured, in seconds. */
  durationSeconds: number;
  /** Public URL of the mp3, attached to the H3 request under the "reference" strategy. */
  referenceAudioUrl: string | null;
  requestId: string;
}

export interface ClipNote {
  clipIndex: number;
  mode: ClipMode;
  requestId: string;
  requestedSeconds: number;
  measuredDurationSeconds: number;
  generationMs: number;
  audioSource: ClipAudioSource;
  hadAudio: boolean;
  revisions: number;
}

export interface MusicNote {
  requestId: string;
  durationMs: number;
  prompt: string;
}

/** Free-form facts about the run, persisted on `generated_shows.engine_notes`. */
export interface EngineNotes {
  engines?: { text: string; speech: string; video?: string; music: string; platform: string };
  format?: ShowFormat;
  research?: { source: string; topicContent?: string; extractedChars?: number };
  script?: {
    title: string;
    showType?: string;
    archetype?: string;
    totalDurationSeconds?: number;
    tableReadAvgScore?: number;
    dramaturgyMs?: number;
  };
  voices?: {
    assignments: Record<string, string>;
    lines: Array<{ segmentIndex: number; speaker: string; voiceId: string; emotion: string; durationSeconds: number; referenceAudio: boolean }>;
  };
  audioStrategy?: AudioStrategy;
  resolution?: string;
  frameChaining?: boolean;
  referencePortrait?: boolean;
  clips?: ClipNote[];
  music?: { theme: MusicNote; credits: MusicNote };
  layout?: EpisodeLayout | AudioLayout;
  assemblyMs?: number;
}

export interface VoicesStepResult {
  format: ShowFormat;
  /** Video only. */
  lines?: VoicedLine[];
}

export interface MusicStepResult {
  themePath: string;
  creditsPath: string;
  themeDurationMs: number;
  creditsDurationMs: number;
  themeLyrics: string;
  creditsLyrics: string;
}

export interface ShowPlan {
  format: ShowFormat;
  useFrameChaining: boolean;
  durationSeconds: number;
}

export const ENGINES = {
  text: "MiniMax-M3",
  speech: "MiniMax Speech 2.8 HD",
  video: "MiniMax-H3",
  music: "MiniMax Music 3.0",
  platform: "GMI Cloud",
} as const;

export const MAX_CONTENT_REVISIONS = 2;
export const MAX_TRANSIENT_RETRIES = 1;
/** MiniMax-H3 accepts reference audio of 2 to 15 seconds. */
export const REFERENCE_AUDIO_MS = { min: 2_000, max: 15_000 };
/** Breathing room after the line so H3 does not cut the last word. */
export const CLIP_TAIL_SECONDS = 0.75;
export const H3_MIN_SECONDS = 4;
export const H3_MAX_SECONDS = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/** The show's format column decides the path. Duration never does. */
export function resolveShowFormat(show: { format?: string | null } | null | undefined): ShowFormat {
  return show?.format === "audio" ? "audio" : "video";
}

export function audioStrategyFrom(value: string | undefined | null): AudioStrategy {
  return value === "native" || value === "overlay" ? value : "reference";
}

/** Requested H3 length for a spoken line: the line plus a tail, inside H3's 4 to 15 s window. */
export function clipSecondsForLine(lineSeconds: number): number {
  const seconds = Number.isFinite(lineSeconds) && lineSeconds > 0 ? lineSeconds : 8;
  return Math.min(H3_MAX_SECONDS, Math.max(H3_MIN_SECONDS, Math.ceil(seconds + CLIP_TAIL_SECONDS)));
}

export function referenceAudioUsable(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= REFERENCE_AUDIO_MS.min && durationMs <= REFERENCE_AUDIO_MS.max;
}

/**
 * Whether a rendered clip's audio is replaced with its Speech 2.8 line.
 *
 * A silent clip always is. "overlay" always is. Under "reference", a clip that
 * could not carry the line as reference audio (a chained clip, a line outside
 * H3's 2 to 15 s window) would otherwise speak in H3's own voice and break the
 * cast, so it is overlaid too.
 */
export function needsTtsOverlay(input: { strategy: AudioStrategy; hasAudio: boolean; referenceAudioAttached: boolean }): boolean {
  if (!input.hasAudio || input.strategy === "overlay") {
    return true;
  }
  return input.strategy === "reference" && !input.referenceAudioAttached;
}

/** Lays measured durations end to end from `offsetSeconds`. */
export function timeSegmentsFromDurations<T extends TranscriptSegment>(segments: T[], durations: number[], offsetSeconds = 0): T[] {
  if (durations.length !== segments.length) {
    throw new Error(`Cannot time ${segments.length} segments from ${durations.length} durations`);
  }
  let cursor = offsetSeconds;
  return segments.map((segment, i) => {
    const start = cursor;
    const end = cursor + durations[i];
    cursor = end;
    return {
      ...segment,
      startTimeSeconds: Number(start.toFixed(3)),
      endTimeSeconds: Number(end.toFixed(3)),
      durationSeconds: Number(durations[i].toFixed(3)),
    };
  });
}

/** Distributes a measured total across segments by word count, the fallback when per-turn timings are missing. */
export function apportionSegmentsByWords<T extends TranscriptSegment>(segments: T[], totalSeconds: number, offsetSeconds = 0): T[] {
  const weights = segments.map(s => Math.max(1, (s.text ?? "").trim().split(/\s+/).filter(Boolean).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cursor = offsetSeconds;
  return segments.map((segment, i) => {
    const share = (weights[i] / totalWeight) * totalSeconds;
    const start = cursor;
    // Pin the final boundary to the true end so rounding cannot leave a gap.
    const end = i === segments.length - 1 ? offsetSeconds + totalSeconds : cursor + share;
    cursor = end;
    return {
      ...segment,
      startTimeSeconds: Number(start.toFixed(3)),
      endTimeSeconds: Number(end.toFixed(3)),
      durationSeconds: Number((end - start).toFixed(3)),
    };
  });
}

/** Shifts already-timed segments, for a bumper placed in front of them. */
export function offsetSegments<T extends TranscriptSegment>(segments: T[], offsetSeconds: number): T[] {
  if (!offsetSeconds) {
    return segments;
  }
  return segments.map(segment => ({
    ...segment,
    startTimeSeconds: Number(((segment.startTimeSeconds ?? 0) + offsetSeconds).toFixed(3)),
    endTimeSeconds: Number(((segment.endTimeSeconds ?? (segment.startTimeSeconds ?? 0) + (segment.durationSeconds ?? 0)) + offsetSeconds).toFixed(3)),
  }));
}

/** Host name -> MiniMax voice id. Existing assignments win so retries keep the cast. */
export function assignVoices(
  existing: unknown,
  hosts: Host[],
  voiceForHost: (host: Host, index: number) => string,
): Record<string, string> {
  const assignments: Record<string, string> = {};
  if (existing && typeof existing === "object") {
    for (const [name, voiceId] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof voiceId === "string" && voiceId) {
        assignments[name] = voiceId;
      }
    }
  }
  hosts.forEach((host, i) => {
    if (!assignments[host.name]) {
      assignments[host.name] = voiceForHost(host, i);
    }
  });
  return assignments;
}

/** Music 3.0 wants structure tags; wrap lyrics that came back without any. */
export function ensureLyricTags(lyrics: string, open: string, close: string): string {
  const trimmed = lyrics.trim();
  if (/\[[A-Z]+\]/i.test(trimmed)) {
    return trimmed;
  }
  return `${open}\n${trimmed}\n${close}`;
}

/** The first sung line of a lyric sheet, tags and quotes stripped. */
export function firstLyricLine(lyrics: string | null | undefined): string | null {
  for (const raw of (lyrics ?? "").split("\n")) {
    const line = raw.replace(/\[[^\]]*\]/g, "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (line) {
      return line;
    }
  }
  return null;
}

export function transcriptFromSegments(segments: TranscriptSegment[]): string {
  return segments.map(s => `[${s.speaker}]: ${s.text}`).join("\n\n");
}

/** Thrown when Mux has no capacity; surfaced to the user verbatim. */
export class StorageFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageFullError";
  }
}

/**
 * Maps with at most `limit` items in flight, preserving order. GMI's speech
 * queue can hold a line for minutes, so lines are voiced a few at a time
 * rather than one after another.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
