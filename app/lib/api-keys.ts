import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { env } from "./env";

/**
 * Bring-your-own-key support.
 *
 * Model inference is the overwhelming majority of this product's running cost,
 * so a public deployment cannot spend the owner's GMI Cloud credits on
 * strangers. Visitors supply their own key and GMI Cloud bills them directly.
 *
 * The key is scoped with AsyncLocalStorage rather than threaded through every
 * function signature: every GMI client only needs to prefer the context key
 * over the environment key.
 *
 * Durable workflow steps do not share one async context (a run can span several
 * invocations), so a run's key is also encrypted onto its show row and the
 * context is re-established at the top of each step.
 */

export interface UserApiKeys {
  /** GMI Cloud API key. Drives every MiniMax model call. */
  gmiKey: string;
}

const keyStore = new AsyncLocalStorage<UserApiKeys>();

/** Runs `fn` with these keys visible to every client factory beneath it. */
export function withUserApiKeys<T>(keys: UserApiKeys, fn: () => T): T {
  return keyStore.run(keys, fn);
}

/** The caller-supplied keys for the current async scope, if any. */
export function getUserApiKeys(): UserApiKeys | undefined {
  return keyStore.getStore();
}

/**
 * True when this deployment refuses to spend the owner's own credits.
 *
 * Left off by default so local development keeps working from `.env.local`;
 * set `REQUIRE_USER_API_KEYS=true` on any public deployment.
 */
export function requiresUserApiKeys(): boolean {
  return env.REQUIRE_USER_API_KEYS === "true";
}

/**
 * The GMI Cloud key to use right now: the caller's if present, otherwise the
 * server's, unless this deployment has opted out of using the server's.
 */
export function resolveGmiKey(): string | undefined {
  const supplied = keyStore.getStore()?.gmiKey;
  if (supplied) {
    return supplied;
  }
  if (requiresUserApiKeys()) {
    return undefined;
  }
  return env.GMI_CLOUD_APIKEY;
}

/** Thrown when generation is attempted with no usable key. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No GMI Cloud API key is available. Add GMI_CLOUD_APIKEY to the server environment, " +
      "or supply your own key in Settings: it is used only for your own generations and billed to your GMI Cloud account.",
    );
    this.name = "MissingApiKeyError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// At-rest encryption
// ─────────────────────────────────────────────────────────────────────────────
//
// A run's key must outlive a single request, so it sits on the show row until
// the run ends. Encrypting it means a database dump alone does not leak a
// visitor's credentials.

const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer {
  const secret = env.KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "KEY_ENCRYPTION_SECRET is required when REQUIRE_USER_API_KEYS is enabled. " +
      "Generate one with: openssl rand -base64 32",
    );
  }
  // Normalises any passphrase to the 32 bytes AES-256 needs.
  return createHash("sha256").update(secret).digest();
}

/** Encrypts keys for storage. Returns `iv:tag:ciphertext`, all base64url. */
export function encryptApiKeys(keys: UserApiKeys): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const plaintext = JSON.stringify(keys);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(b => b.toString("base64url")).join(":");
}

/** Reverses `encryptApiKeys`. Returns undefined for anything unreadable. */
export function decryptApiKeys(payload: string | null | undefined): UserApiKeys | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const [ivPart, tagPart, dataPart] = payload.split(":");
    if (!ivPart || !tagPart || !dataPart) {
      return undefined;
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<UserApiKeys>;
    return typeof parsed.gmiKey === "string" && parsed.gmiKey.length > 0 ? { gmiKey: parsed.gmiKey } : undefined;
  } catch {
    // Wrong secret, tampering, or a legacy row. Never surface the reason.
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape check only. GMI Cloud keys are opaque tokens, so this catches pasted
 * whitespace and truncated copies rather than asserting a prefix.
 */
export function looksLikeGmiKey(key: string): boolean {
  const k = key.trim();
  return k.length >= 20 && !/\s/.test(k);
}

/** Redacts a key for display: keeps enough to recognise, never enough to use. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) {
    return "•".repeat(k.length);
  }
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
