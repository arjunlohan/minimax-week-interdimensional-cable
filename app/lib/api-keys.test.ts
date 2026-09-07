import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable so individual tests can flip REQUIRE_USER_API_KEYS and the secret.
const mockEnv: Record<string, string | undefined> = {
  GMI_CLOUD_APIKEY: "server-owned-gmi-key-aaaaaaaaaaaaaaaaaaaaaaaa",
  KEY_ENCRYPTION_SECRET: "test-secret",
  REQUIRE_USER_API_KEYS: undefined,
  DATABASE_URL: "postgresql://localhost:5432/test",
};

vi.mock("./env", () => ({ get env() {
  return mockEnv;
} }));
vi.mock("@/app/lib/env", () => ({ get env() {
  return mockEnv;
} }));

const {
  decryptApiKeys,
  encryptApiKeys,
  looksLikeGmiKey,
  maskKey,
  requiresUserApiKeys,
  resolveGmiKey,
  withUserApiKeys,
} = await import("./api-keys");

const USER_KEYS = {
  gmiKey: "visitor-supplied-gmi-key-bbbbbbbbbbbbbbbbbbbbbbb",
};

beforeEach(() => {
  mockEnv.KEY_ENCRYPTION_SECRET = "test-secret";
  mockEnv.REQUIRE_USER_API_KEYS = undefined;
  mockEnv.GMI_CLOUD_APIKEY = "server-owned-gmi-key-aaaaaaaaaaaaaaaaaaaaaaaa";
});

describe("at-rest encryption", () => {
  it("round-trips the key", () => {
    expect(decryptApiKeys(encryptApiKeys(USER_KEYS))).toEqual(USER_KEYS);
  });

  it("never leaves the key readable in the ciphertext", () => {
    const blob = encryptApiKeys(USER_KEYS);
    expect(blob).not.toContain(USER_KEYS.gmiKey);
    expect(blob).not.toContain("visitor-supplied");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptApiKeys(USER_KEYS)).not.toEqual(encryptApiKeys(USER_KEYS));
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const [iv, tag] = encryptApiKeys(USER_KEYS).split(":");
    const tampered = [iv, tag, Buffer.from("swapped").toString("base64url")].join(":");
    expect(decryptApiKeys(tampered)).toBeUndefined();
  });

  it("cannot be decrypted with a different secret", () => {
    const blob = encryptApiKeys(USER_KEYS);
    mockEnv.KEY_ENCRYPTION_SECRET = "some-other-secret";
    expect(decryptApiKeys(blob)).toBeUndefined();
  });

  it("treats empty or malformed payloads as absent", () => {
    expect(decryptApiKeys(null)).toBeUndefined();
    expect(decryptApiKeys(undefined)).toBeUndefined();
    expect(decryptApiKeys("")).toBeUndefined();
    expect(decryptApiKeys("not-a-payload")).toBeUndefined();
  });

  it("ignores legacy rows that carried keys of another shape", () => {
    // A row encrypted before the migration held keys of a different shape.
    const legacy = encryptApiKeys({ gmiKey: "" });
    expect(decryptApiKeys(legacy)).toBeUndefined();
  });
});

describe("key resolution", () => {
  it("falls back to the server key when no visitor key is in scope", () => {
    expect(resolveGmiKey()).toBe(mockEnv.GMI_CLOUD_APIKEY);
  });

  it("prefers the visitor's key over the server's", () => {
    const resolved = withUserApiKeys(USER_KEYS, () => resolveGmiKey());
    expect(resolved).toBe(USER_KEYS.gmiKey);
    expect(resolved).not.toBe(mockEnv.GMI_CLOUD_APIKEY);
  });

  it("does not leak the visitor's key outside its scope", () => {
    withUserApiKeys(USER_KEYS, () => resolveGmiKey());
    expect(resolveGmiKey()).toBe(mockEnv.GMI_CLOUD_APIKEY);
  });

  it("refuses the server key when the deployment requires visitor keys", () => {
    mockEnv.REQUIRE_USER_API_KEYS = "true";
    expect(requiresUserApiKeys()).toBe(true);
    // This is the whole point: a stranger cannot spend the owner's credits.
    expect(resolveGmiKey()).toBeUndefined();
  });

  it("still serves the visitor's own key when they supply one", () => {
    mockEnv.REQUIRE_USER_API_KEYS = "true";
    expect(withUserApiKeys(USER_KEYS, () => resolveGmiKey())).toBe(USER_KEYS.gmiKey);
  });

  it("keeps concurrent runs isolated from each other", async () => {
    const a = { gmiKey: "run-a-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const b = { gmiKey: "run-b-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

    // Deliberately interleaved: B resolves while A is still suspended.
    const [ra, rb] = await Promise.all([
      withUserApiKeys(a, async () => {
        await new Promise(r => setTimeout(r, 30));
        return resolveGmiKey();
      }),
      withUserApiKeys(b, async () => {
        await new Promise(r => setTimeout(r, 5));
        return resolveGmiKey();
      }),
    ]);

    expect(ra).toBe(a.gmiKey);
    expect(rb).toBe(b.gmiKey);
  });
});

describe("presentation and validation", () => {
  it("masks a key without revealing a usable portion", () => {
    const masked = maskKey(USER_KEYS.gmiKey);
    expect(masked).toContain("…");
    expect(masked).not.toContain(USER_KEYS.gmiKey.slice(8));
    expect(masked.length).toBeLessThan(USER_KEYS.gmiKey.length);
  });

  it("accepts an opaque token and rejects the common paste mistakes", () => {
    expect(looksLikeGmiKey(USER_KEYS.gmiKey)).toBe(true);
    expect(looksLikeGmiKey("  gmi_live_0123456789abcdef0123456789  ")).toBe(true);
    expect(looksLikeGmiKey("hunter2")).toBe(false);
    expect(looksLikeGmiKey("")).toBe(false);
    // Whitespace inside means two things were pasted, or a line broke.
    expect(looksLikeGmiKey("gmi_live_0123456789 abcdef0123456789")).toBe(false);
  });
});
