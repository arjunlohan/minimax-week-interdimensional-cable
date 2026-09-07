/* eslint-disable no-console */
import fs from "node:fs";

import { downloadToBuffer, firstMediaUrl, runQueued, tmpPath } from "./queue";

import type { Buffer } from "node:buffer";

/**
 * MiniMax Music 3.0 on the GMI Cloud request queue. Synchronous (30 to 60 s).
 * Lyrics carry structure tags ([Intro] [Verse] [Chorus] [Bridge] [Outro] [Hook] [Inst]);
 * the prompt describes genre, mood and instrumentation.
 */

export const MUSIC_MODEL_ID = "minimax-music-3.0";

export interface MusicRequest {
  /** 1..3500 characters. */
  lyrics: string;
  /** 0..2000 characters of style direction. */
  prompt?: string;
  format?: "mp3" | "wav";
  sampleRate?: 16000 | 24000 | 32000 | 44100;
  bitrate?: 32000 | 64000 | 128000 | 256000;
}

export interface MusicResult {
  localPath: string;
  audio: Buffer;
  remoteUrl: string;
  requestId: string;
  durationMs: number;
  format: "mp3" | "wav";
}

export function buildMusicPayload(request: MusicRequest): Record<string, unknown> {
  const lyrics = request.lyrics.trim();
  if (!lyrics) {
    throw new Error("Music 3.0 needs lyrics");
  }
  if (lyrics.length > 3500) {
    throw new Error(`Music 3.0 lyrics are ${lyrics.length} characters; the limit is 3500`);
  }
  const prompt = request.prompt?.trim();
  if (prompt && prompt.length > 2000) {
    throw new Error(`Music 3.0 style prompt is ${prompt.length} characters; the limit is 2000`);
  }
  return {
    lyrics,
    ...(prompt ? { prompt } : {}),
    sample_rate: request.sampleRate ?? 44100,
    bitrate: request.bitrate ?? 256000,
    format: request.format ?? "mp3",
  };
}

export async function generateMusic(request: MusicRequest): Promise<MusicResult> {
  const payload = buildMusicPayload(request);
  const format = request.format ?? "mp3";
  const record = await runQueued(MUSIC_MODEL_ID, payload, { pollMs: 5_000, timeoutMs: 10 * 60_000 });
  const remoteUrl = firstMediaUrl(record, "audio");
  const audio = await downloadToBuffer(remoteUrl);
  const localPath = tmpPath("music", format);
  fs.writeFileSync(localPath, audio);
  const durationMs = typeof record.outcome?.duration_ms === "number" ? record.outcome.duration_ms : 0;
  console.log(`[gmi:music] ${payload.lyrics ? String(payload.lyrics).length : 0} chars of lyrics -> ${audio.length} bytes, ${durationMs} ms: ${localPath}`);
  return { localPath, audio, remoteUrl, requestId: record.request_id, durationMs, format };
}
