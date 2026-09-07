"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Bring-your-own-key entry.
 *
 * Model inference is the dominant running cost, so a public deployment asks the
 * visitor for their own GMI Cloud key and GMI bills them directly. One key
 * drives every model in the pipeline (MiniMax-M3, MiniMax-H3, Speech 2.8 HD,
 * Music 3.0). The key stays in this browser; it is sent to the server only to
 * run the visitor's own generation, stored encrypted for the lifetime of that
 * run, and wiped when the run finishes.
 */

const STORAGE_KEY = "ic:gmi-api-key";

export interface StoredKeys {
  gmiKey: string;
}

/** Reads the saved key. Returns null whenever storage is unavailable or empty. */
export function readStoredKeys(): StoredKeys | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredKeys>;
    return typeof parsed.gmiKey === "string" && parsed.gmiKey.length > 0 ? { gmiKey: parsed.gmiKey } : null;
  } catch {
    // Private windows, cleared site data, or storage disabled entirely.
    return null;
  }
}

function writeStoredKeys(keys: StoredKeys | null): void {
  try {
    if (keys) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Nothing useful to do; the caller still holds the value in memory.
  }
}

/**
 * Mirrors `looksLikeGmiKey` in app/lib/api-keys.ts, which cannot be imported
 * here because that module pulls in Node-only crypto. GMI Cloud keys are opaque
 * tokens, so this catches pasted whitespace and truncated copies rather than
 * asserting a prefix.
 */
function looksLikeGmiKey(key: string): boolean {
  const k = key.trim();
  return k.length >= 20 && !/\s/.test(k);
}

function mask(key: string): string {
  const k = key.trim();
  return k.length <= 12 ? "•".repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

interface ApiKeyPanelProps {
  /** True when this deployment refuses to fall back to the server's own key. */
  required: boolean;
  onChange?: (keys: StoredKeys | null) => void;
}

export function ApiKeyPanel({ required, onChange }: ApiKeyPanelProps) {
  const [keys, setKeys] = useState<StoredKeys | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readStoredKeys();
    setKeys(stored);
    setHydrated(true);
    onChange?.(stored);
    if (!stored && required) {
      setEditing(true);
    }
    // Runs once on mount; onChange identity is not a meaningful dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(() => {
    const gmiKey = input.trim();
    if (!looksLikeGmiKey(gmiKey)) {
      setError("GMI Cloud keys are at least 20 characters with no spaces. Check for a truncated paste.");
      return;
    }
    const next = { gmiKey };
    writeStoredKeys(next);
    setKeys(next);
    setEditing(false);
    setError(null);
    setInput("");
    onChange?.(next);
  }, [input, onChange]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const clear = useCallback(() => {
    writeStoredKeys(null);
    setKeys(null);
    onChange?.(null);
    setEditing(true);
  }, [onChange]);

  // Avoid rendering a "no key" state during hydration when one is in fact saved.
  if (!hydrated) {
    return null;
  }

  if (keys && !editing) {
    return (
      <div className="card-brutal flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <span
          className="badge"
          style={{ fontFamily: "var(--font-space-mono)", background: "var(--surface-elevated)" }}
        >
          GMI Cloud key saved
        </span>
        <code className="text-sm" style={{ fontFamily: "var(--font-space-mono)" }}>
          {mask(keys.gmiKey)}
        </code>
        <button
          type="button"
          onClick={clear}
          className="ml-auto border-2 border-border px-3 py-1 text-xs font-bold uppercase tracking-wider transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_var(--border)]"
          style={{ fontFamily: "var(--font-space-mono)" }}
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="card-brutal flex flex-col gap-4 p-5">
      <div>
        <h3 className="text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
          {required ? "Add your GMI Cloud API key to generate" : "Use your own GMI Cloud API key (optional)"}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-foreground-muted">
          Generation runs on your key and GMI Cloud bills your account directly. The key is
          stored in this browser, sent only to run your own show, held encrypted while
          that run is in flight, and deleted when it finishes. It is never logged and
          never shared.
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span
          className="text-xs font-bold uppercase tracking-[0.15em] text-foreground-muted"
          style={{ fontFamily: "var(--font-space-mono)" }}
        >
          GMI Cloud API key
        </span>
        <input
          type="password"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Paste your GMI Cloud key"
          autoComplete="off"
          spellCheck={false}
          className="border-3 border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:shadow-[3px_3px_0_var(--accent)]"
          style={{ fontFamily: "var(--font-space-mono)" }}
        />
        <span className="text-xs text-foreground-muted">
          Create one at
          {" "}
          <a
            href="https://console.gmicloud.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            console.gmicloud.ai
          </a>
          , Settings, API keys. Used only for your own generations and billed to your GMI Cloud account.
          One key covers MiniMax-M3, MiniMax-H3, Speech 2.8 HD and Music 3.0.
        </span>
      </label>

      {error ?
          (
            <p className="border-3 border-border bg-surface-elevated px-3 py-2 text-sm font-bold">
              {error}
            </p>
          ) :
        null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!input.trim()}
          className="btn-action disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save key
        </button>
        {keys ?
            (
              <button
                type="button"
                onClick={handleCancel}
                className="text-sm font-bold underline"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                Cancel
              </button>
            ) :
          null}
      </div>
    </div>
  );
}
