"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TARGET_LANGUAGES } from "@/app/media/[slug]/localization/constants";
import type { TargetLanguage } from "@/app/media/[slug]/localization/constants";
import { usePlayer } from "@/app/media/[slug]/player/use-player";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DubbingPanelProps {
  transcript: string;
  hosts: Array<{ name: string }>;
  /**
   * Per-turn breakdown, used to dub multi-host shows: MiniMax Speech 2.8 HD
   * voices one speaker per request, so a two-anchor desk or a four-seat panel
   * is voiced a turn at a time, each host in its own voice.
   */
  segments?: Array<{ speaker: string; text: string }>;
}

type DubStatus = "idle" | "generating" | "dubbed" | "error";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function DubbingPanel({ transcript, hosts, segments }: DubbingPanelProps) {
  const { playerRef } = usePlayer();
  const [selectedLang, setSelectedLang] = useState<TargetLanguage>(TARGET_LANGUAGES[0]);
  const [status, setStatus] = useState<DubStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dubbedLang, setDubbedLang] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const cleanupAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const syncAudioToPlayer = useCallback(() => {
    const player = playerRef.current;
    const audio = audioRef.current;
    if (!player || !audio)
      return () => {};

    const onPlay = () => {
      audio.currentTime = player.currentTime;
      void audio.play();
    };
    const onPause = () => audio.pause();
    const onSeeked = () => {
      audio.currentTime = player.currentTime;
    };

    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("seeked", onSeeked);

    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("seeked", onSeeked);
    };
  }, [playerRef]);

  const generateDub = useCallback(async () => {
    setStatus("generating");
    setError(null);
    cleanupAudio();

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          hosts,
          segments,
          targetLang: selectedLang.code,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `TTS failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      const audio = audioRef.current!;
      audio.src = url;
      audio.load();

      const player = playerRef.current;
      if (player) {
        player.muted = true;
        audio.currentTime = player.currentTime;
        if (!player.paused) {
          void audio.play();
        }
      }

      setDubbedLang(selectedLang.name);
      setStatus("dubbed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dubbing failed");
      setStatus("error");
    }
  }, [transcript, hosts, segments, selectedLang, playerRef, cleanupAudio]);

  const restoreOriginal = useCallback(() => {
    cleanupAudio();
    const player = playerRef.current;
    if (player) {
      player.muted = false;
    }
    setDubbedLang(null);
    setStatus("idle");
  }, [playerRef, cleanupAudio]);

  // Set up sync listeners when dubbed
  useEffect(() => {
    if (status !== "dubbed")
      return;
    const cleanup = syncAudioToPlayer();
    return cleanup;
  }, [status, syncAudioToPlayer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();
      const player = playerRef.current;
      if (player)
        player.muted = false;
    };
  }, [cleanupAudio, playerRef]);

  return (
    <div className="card-flat overflow-hidden">
      <div
        className="panel-brutal-header bg-background-dark px-4 py-3 text-white"
        style={{ fontFamily: "var(--font-space-mono)" }}
      >
        <span className="text-[14px] font-bold uppercase tracking-[0.2em]">
          Audio Dubbing
        </span>
      </div>

      <div className="space-y-3 p-4">
        <p
          className="text-[10px] text-foreground-muted"
          style={{ fontFamily: "var(--font-space-mono)" }}
        >
          Powered by MiniMax Speech 2.8 HD · dub the show audio into another language
        </p>

        {/* Language selector */}
        <div className="space-y-1">
          <label
            className="text-[10px] font-bold uppercase tracking-wider text-foreground-muted"
            style={{ fontFamily: "var(--font-space-mono)" }}
          >
            Target Language
          </label>
          <select
            value={selectedLang.code}
            onChange={(e) => {
              const lang = TARGET_LANGUAGES.find(l => l.code === e.target.value);
              if (lang)
                setSelectedLang(lang);
            }}
            disabled={status === "generating"}
            className="w-full appearance-none border-2 border-border bg-surface px-3 py-2 pr-8 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            style={{ fontFamily: "var(--font-space-mono)" }}
          >
            {TARGET_LANGUAGES.map(lang => (
              <option key={lang.code} value={lang.code}>
                {lang.flag}
                {" "}
                {lang.name.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {/* Dub / Restore buttons */}
        {status === "dubbed" ?
            (
              <div className="space-y-2">
                <div
                  className="flex items-center gap-2 border-2 border-green-600 bg-green-50 px-3 py-2"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  <span className="text-xs font-bold text-green-800">
                    Audio dubbed to
                    {" "}
                    {dubbedLang}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={restoreOriginal}
                  className="flex w-full items-center justify-center border-3 border-border bg-background-dark px-4 py-3 font-bold uppercase tracking-wider text-white transition-all hover:brightness-125"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  <span className="text-xs">Restore Original Audio</span>
                </button>
              </div>
            ) :
            (
              <button
                type="button"
                onClick={generateDub}
                disabled={status === "generating"}
                className="flex w-full items-center justify-center gap-2 border-3 border-border bg-accent px-4 py-3 font-bold uppercase tracking-wider text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                {status === "generating" ?
                    (
                      <>
                        <Spinner />
                        <span className="text-xs">
                          Generating
                          {selectedLang.name}
                          {" "}
                          dub...
                        </span>
                      </>
                    ) :
                    (
                      <span className="text-xs">
                        Dub Audio →
                        {" "}
                        {selectedLang.name.toUpperCase()}
                      </span>
                    )}
              </button>
            )}

        {/* Error */}
        {status === "error" && error && (
          <div className="border-2 border-red-500 bg-red-50 p-3">
            <p className="text-xs font-bold text-red-700">{error}</p>
            <button
              type="button"
              onClick={generateDub}
              className="mt-1 text-[10px] text-red-600 underline"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Hidden audio element for synced playback */}
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" />
    </svg>
  );
}
