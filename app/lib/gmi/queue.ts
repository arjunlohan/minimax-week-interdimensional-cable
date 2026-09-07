import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gmiFetchJson, unwrapGmiErrorMessage } from "./client";

/**
 * GMI Cloud request queue: the surface every media model shares.
 *
 *   POST /requests            { model, payload }   -> { request_id, status, ... }
 *   GET  /requests/{id}                            -> { status, outcome, ... }
 *
 * Speech and music return `success` from the POST itself; video goes through
 * queued -> dispatched -> processing and has to be polled.
 */

export type GmiRequestStatus =
  | "created" |
  "queued" |
  "dispatched" |
  "processing" |
  "success" |
  "failed" |
  "cancelled";

export interface GmiMediaUrl {
  id?: string;
  url: string;
  type?: string;
  format?: string;
}

export interface GmiOutcome {
  video_url?: string;
  thumbnail_image_url?: string;
  audio_url?: string;
  duration_ms?: number;
  sample_rate?: number;
  channels?: number;
  bitrate?: number;
  status?: string;
  error?: unknown;
  message?: string;
  media_urls?: GmiMediaUrl[];
  medias?: GmiMediaUrl[];
  [key: string]: unknown;
}

export interface GmiRequestRecord {
  request_id: string;
  model: string;
  status: GmiRequestStatus | string;
  payload?: Record<string, unknown>;
  outcome?: GmiOutcome | null;
  error?: unknown;
  error_message?: string;
  created_at?: number;
  updated_at?: number;
  queued_at?: number;
  [key: string]: unknown;
}

const TERMINAL: ReadonlySet<string> = new Set(["success", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status.toLowerCase());
}

export class GmiRequestFailedError extends Error {
  readonly requestId: string;
  readonly model: string;
  readonly status: string;
  readonly record: GmiRequestRecord;

  constructor(record: GmiRequestRecord, reason: string) {
    super(`GMI Cloud ${record.model} request ${record.request_id} ${record.status}: ${reason}`);
    this.name = "GmiRequestFailedError";
    this.requestId = record.request_id;
    this.model = record.model;
    this.status = String(record.status);
    this.record = record;
  }
}

/** A request the model refused on content grounds, with the reasons it gave. */
export class GmiContentFilterError extends GmiRequestFailedError {
  readonly reasons: string[];

  constructor(record: GmiRequestRecord, reason: string) {
    super(record, reason);
    this.name = "GmiContentFilterError";
    this.reasons = [reason];
  }
}

const CONTENT_FILTER_PATTERN = /sensitiv|moderat|policy|safety|prohibit|violat|nsfw|inappropriate|risk control|not allowed|blocked|celebrity|public figure/i;

/**
 * GMI reports some rate limits as a terminal "failed" record rather than a 429,
 * e.g. "Music generation failed: rate limit exceeded(RPM)". Those are worth
 * waiting out and resubmitting; a content refusal is not.
 */
const RATE_LIMIT_PATTERN = /rate limit|rate-limit|ratelimit|\bRPM\b|\bRPH\b|too many requests|quota/i;

export function isRateLimitFailure(record: GmiRequestRecord): boolean {
  return RATE_LIMIT_PATTERN.test(describeFailure(record));
}

/** The most useful failure reason a failed record carries. */
export function describeFailure(record: GmiRequestRecord): string {
  const candidates: unknown[] = [
    record.error_message,
    record.error,
    record.outcome?.error,
    record.outcome?.message,
    record.outcome?.status,
    record.outcome?.error_message,
    record.outcome?.fail_reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      const unwrapped = unwrapGmiErrorMessage(candidate, "");
      if (unwrapped) {
        return unwrapped;
      }
      try {
        return JSON.stringify(candidate).slice(0, 500);
      } catch {
        // fall through
      }
    }
  }
  return `no reason reported (status ${record.status})`;
}

function failureFor(record: GmiRequestRecord): GmiRequestFailedError {
  const reason = describeFailure(record);
  return CONTENT_FILTER_PATTERN.test(reason) ?
      new GmiContentFilterError(record, reason) :
      new GmiRequestFailedError(record, reason);
}

export async function submitRequest(model: string, payload: Record<string, unknown>): Promise<GmiRequestRecord> {
  const record = await gmiFetchJson<GmiRequestRecord>("/requests", {
    method: "POST",
    body: JSON.stringify({ model, payload }),
    timeoutMs: 180_000,
  });
  if (!record || typeof record.request_id !== "string") {
    throw new Error(`GMI Cloud ${model} submission returned no request_id: ${JSON.stringify(record).slice(0, 300)}`);
  }
  return record;
}

export async function getRequest(requestId: string): Promise<GmiRequestRecord> {
  return gmiFetchJson<GmiRequestRecord>(`/requests/${encodeURIComponent(requestId)}`, { method: "GET" });
}

export interface WaitOptions {
  /** Poll interval (default 5 s). */
  pollMs?: number;
  /** Give up after this long (default 15 min). */
  timeoutMs?: number;
  onPoll?: (record: GmiRequestRecord, elapsedMs: number) => void;
}

/** Polls until the request reaches a terminal state; resolves only on success. */
export async function waitForRequest(requestId: string, options: WaitOptions = {}): Promise<GmiRequestRecord> {
  const { pollMs = 5_000, timeoutMs = 15 * 60_000, onPoll } = options;
  const startedAt = Date.now();

  for (;;) {
    const record = await getRequest(requestId);
    const elapsed = Date.now() - startedAt;
    onPoll?.(record, elapsed);

    const status = String(record.status).toLowerCase();
    if (status === "success") {
      return record;
    }
    if (isTerminalStatus(status)) {
      throw failureFor(record);
    }
    if (elapsed > timeoutMs) {
      throw new Error(`GMI Cloud request ${requestId} still ${record.status} after ${Math.round(elapsed / 1000)}s`);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** Submit, then wait if the model did not answer synchronously. */
export async function runQueued(
  model: string,
  payload: Record<string, unknown>,
  options: WaitOptions & {
    onSubmit?: (record: GmiRequestRecord) => void | Promise<void>;
    /** Resubmissions after a rate-limited failure (default 4, waiting 20 s, 40 s, 60 s, 60 s). */
    rateLimitRetries?: number;
  } = {},
): Promise<GmiRequestRecord> {
  const { rateLimitRetries = 4 } = options;

  for (let attempt = 0; ; attempt++) {
    const submitted = await submitRequest(model, payload);

    const status = String(submitted.status).toLowerCase();
    if (isTerminalStatus(status) && status !== "success" && isRateLimitFailure(submitted) && attempt < rateLimitRetries) {
      const waitMs = Math.min(60_000, 20_000 * (attempt + 1));
      console.warn(`[gmi:queue] ${model} rate limited (${describeFailure(submitted)}); resubmitting in ${waitMs / 1000}s (${attempt + 1}/${rateLimitRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    await options.onSubmit?.(submitted);

    if (status === "success" && submitted.outcome) {
      return submitted;
    }
    if (isTerminalStatus(status) && status !== "success") {
      throw failureFor(submitted);
    }
    return waitForRequest(submitted.request_id, options);
  }
}

/** The first media URL in a successful record, whichever field the model used. */
export function firstMediaUrl(record: GmiRequestRecord, kind: "video" | "audio" = "video"): string {
  const outcome = record.outcome ?? {};
  const direct = kind === "video" ? outcome.video_url : outcome.audio_url;
  if (typeof direct === "string" && direct) {
    return direct;
  }
  const listed = [...(outcome.media_urls ?? []), ...(outcome.medias ?? [])].find(m => typeof m?.url === "string" && m.url);
  if (listed) {
    return listed.url;
  }
  throw new Error(`GMI Cloud ${record.model} request ${record.request_id} succeeded but returned no ${kind} URL: ${JSON.stringify(outcome).slice(0, 300)}`);
}

export function tmpDir(): string {
  const dir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpPath(prefix: string, extension: string): string {
  return path.join(tmpDir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extension.replace(/^\./, "")}`);
}

/** Downloads a result URL to disk. Result URLs are public, so no auth header. */
export async function downloadToFile(url: string, destination: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`Download returned an empty file for ${url}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return destination;
}

export async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
