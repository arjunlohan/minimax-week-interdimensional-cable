import { MissingApiKeyError, resolveGmiKey } from "@/app/lib/api-keys";

/**
 * GMI Cloud has two API surfaces and one key:
 *  - an OpenAI-compatible LLM endpoint (MiniMax-M3), driven through the Vercel AI SDK
 *  - a request queue for media models (MiniMax-H3, Speech 2.8, Music 3.0, voice clone)
 *
 * This module holds what both share: the key, the base URLs, and a fetch wrapper
 * that retries rate limits and unwraps GMI's nested error diagnostics.
 */

export const GMI_LLM_BASE_URL = "https://api.gmi-serving.com/v1";
export const GMI_QUEUE_BASE_URL = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";

/** The key for the current scope (visitor's or server's), or a clear failure. */
export function requireGmiKey(): string {
  const key = resolveGmiKey();
  if (!key) {
    throw new MissingApiKeyError();
  }
  return key;
}

export class GmiApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;

  constructor(message: string, status: number, body: unknown, path: string) {
    super(message);
    this.name = "GmiApiError";
    this.status = status;
    this.body = body;
    this.path = path;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

/**
 * GMI's edge reports a generic banner in `error.message` and nests the backend
 * engine's reason in `error.details` (sometimes as a JSON string). Surface the
 * most specific message available.
 */
export function unwrapGmiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 500);
  }
  if (!body || typeof body !== "object") {
    return fallback;
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  // Billing and auth failures arrive as a bare string: {"error": "Insufficient credits..."}.
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const details = err.details;
    if (typeof details === "string" && details.trim()) {
      try {
        const parsed = JSON.parse(details) as { error?: { message?: string }; message?: string };
        const nested = parsed?.error?.message ?? parsed?.message;
        if (typeof nested === "string" && nested.trim()) {
          return nested.trim();
        }
      } catch {
        return details.trim();
      }
    }
    if (typeof err.message === "string" && err.message.trim()) {
      return err.message.trim();
    }
  }
  for (const key of ["message", "detail", "msg", "error_message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface GmiFetchOptions extends Omit<RequestInit, "body"> {
  body?: string;
  /** Attempts after the first for 429s and 5xx responses (default 3). */
  retries?: number;
  /** Per-attempt timeout (default 60 s). */
  timeoutMs?: number;
}

/**
 * JSON fetch against the request-queue surface. Relative paths are resolved
 * against `GMI_QUEUE_BASE_URL`; absolute URLs pass through unchanged.
 */
export async function gmiFetchJson<T>(path: string, options: GmiFetchOptions = {}): Promise<T> {
  const { retries = 3, timeoutMs = 60_000, headers, ...rest } = options;
  const url = path.startsWith("http") ? path : `${GMI_QUEUE_BASE_URL}${path}`;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: {
          "Authorization": `Bearer ${requireGmiKey()}`,
          "Content-Type": "application/json",
          ...(headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network failures and timeouts are worth one more try; they are not a verdict.
      if (attempt < retries) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      throw new GmiApiError(
        `GMI Cloud request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
        path,
      );
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (response.ok) {
      return body as T;
    }

    const message = unwrapGmiErrorMessage(body, `GMI Cloud request failed with status ${response.status}`);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs = response.status === 429 ?
          (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000 * (attempt + 1)) :
        3_000 * (attempt + 1);
      console.warn(`[gmi] ${response.status} from ${path}: ${message}. Retrying in ${Math.round(backoffMs / 1000)}s (${attempt + 1}/${retries})`);
      await sleep(backoffMs);
      continue;
    }

    throw new GmiApiError(message, response.status, body, path);
  }
}
