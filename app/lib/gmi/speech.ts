/* eslint-disable no-console */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { audioToWav, probeMedia } from "@/app/lib/media";

import { downloadToBuffer, firstMediaUrl, runQueued, tmpDir, tmpPath } from "./queue";

import type { Buffer } from "node:buffer";

/**
 * MiniMax Speech 2.8 HD on the GMI Cloud request queue. Synchronous: the POST
 * returns the finished audio. One voice per request, which is why the show
 * pipeline synthesizes dialogue a turn at a time.
 */

export const SPEECH_MODEL_ID = "minimax-tts-speech-2.8-hd";
export const VOICE_CLONE_MODEL_ID = "minimax-audio-voice-clone-speech-2.8-hd";

export type SpeechEmotion = "auto" | "calm" | "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised";

export const SPEECH_EMOTIONS: readonly SpeechEmotion[] = ["auto", "calm", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];

export interface SpeechRequest {
  text: string;
  voiceId: string;
  emotion?: SpeechEmotion;
  /** 0.5 .. 2.0 */
  speed?: number;
  /** -12 .. 12 semitones */
  pitch?: number;
  /** 0 .. 10 */
  vol?: number;
  /** "auto" or a language name/code the model should favour. */
  languageBoost?: string;
  format?: "mp3" | "flac";
  sampleRate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100;
  bitrate?: 32000 | 64000 | 128000 | 256000;
}

export interface SpeechResult {
  audio: Buffer;
  format: "mp3" | "flac";
  remoteUrl: string;
  requestId: string;
  /** Reported by the model when available, otherwise measured. */
  durationMs: number;
}

export function buildSpeechPayload(request: SpeechRequest): Record<string, unknown> {
  const text = request.text.trim();
  if (!text) {
    throw new Error("Speech 2.8 needs non-empty text");
  }
  const payload: Record<string, unknown> = {
    text,
    voice_id: request.voiceId,
    format: request.format ?? "mp3",
    audio_sample_rate: String(request.sampleRate ?? 44100),
    bitrate: String(request.bitrate ?? 128000),
    channel: "1",
  };
  if (request.emotion && request.emotion !== "auto") {
    payload.emotion = request.emotion;
  }
  if (request.speed !== undefined) {
    payload.speed = Math.min(2, Math.max(0.5, Number(request.speed.toFixed(1))));
  }
  if (request.pitch !== undefined) {
    payload.pitch = Math.min(12, Math.max(-12, Math.round(request.pitch)));
  }
  if (request.vol !== undefined) {
    payload.vol = Math.min(10, Math.max(0, Number(request.vol.toFixed(1))));
  }
  if (request.languageBoost) {
    payload.language_boost = request.languageBoost;
  }
  return payload;
}

/**
 * Finished lines are kept on disk, keyed by the exact payload, so a durable
 * step that is retried after one slow request does not pay the queue again for
 * the lines it already has. GMI's speech queue has been observed to take
 * anywhere from 20 s to over 5 min per line.
 */
const SPEECH_QUEUE_TIMEOUT_MS = 15 * 60_000;

function speechCachePaths(payload: Record<string, unknown>, format: string): { audio: string; meta: string } {
  const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const dir = path.join(tmpDir(), "speech-cache");
  fs.mkdirSync(dir, { recursive: true });
  return { audio: path.join(dir, `${key}.${format}`), meta: path.join(dir, `${key}.json`) };
}

interface CachedSpeechMeta {
  remoteUrl: string;
  requestId: string;
  durationMs: number;
}

function readSpeechCache(payload: Record<string, unknown>, format: "mp3" | "flac"): SpeechResult | null {
  const paths = speechCachePaths(payload, format);
  if (!fs.existsSync(paths.audio) || !fs.existsSync(paths.meta)) {
    return null;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(paths.meta, "utf8")) as CachedSpeechMeta;
    const audio = fs.readFileSync(paths.audio);
    if (audio.length === 0 || !meta.durationMs) {
      return null;
    }
    return { audio, format, remoteUrl: meta.remoteUrl, requestId: meta.requestId, durationMs: meta.durationMs };
  } catch {
    return null;
  }
}

function writeSpeechCache(payload: Record<string, unknown>, result: SpeechResult): void {
  try {
    const paths = speechCachePaths(payload, result.format);
    fs.writeFileSync(paths.audio, result.audio);
    const meta: CachedSpeechMeta = { remoteUrl: result.remoteUrl, requestId: result.requestId, durationMs: result.durationMs };
    fs.writeFileSync(paths.meta, JSON.stringify(meta));
  } catch (err) {
    console.warn("[gmi:speech] Could not cache a line:", err instanceof Error ? err.message : String(err));
  }
}

export async function synthesizeSpeech(request: SpeechRequest): Promise<SpeechResult> {
  const payload = buildSpeechPayload(request);
  const format = (request.format ?? "mp3");

  const cached = readSpeechCache(payload, format);
  if (cached) {
    console.log(`[gmi:speech] cache hit for ${request.voiceId}: ${text_preview(request.text)} (${cached.durationMs} ms)`);
    return cached;
  }

  const record = await runQueued(SPEECH_MODEL_ID, payload, { pollMs: 2_000, timeoutMs: SPEECH_QUEUE_TIMEOUT_MS });
  const remoteUrl = firstMediaUrl(record, "audio");
  const audio = await downloadToBuffer(remoteUrl);

  let durationMs = typeof record.outcome?.duration_ms === "number" ? record.outcome.duration_ms : 0;
  if (!durationMs) {
    const scratch = tmpPath("tts-probe", format);
    fs.writeFileSync(scratch, audio);
    try {
      const probe = await probeMedia(scratch);
      durationMs = Math.round((probe.durationSeconds ?? 0) * 1000);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }

  console.log(`[gmi:speech] ${request.voiceId}${request.emotion ? ` (${request.emotion})` : ""}: ${text_preview(request.text)} -> ${audio.length} bytes, ${durationMs} ms`);
  const result: SpeechResult = { audio, format, remoteUrl, requestId: record.request_id, durationMs };
  writeSpeechCache(payload, result);
  return result;
}

/**
 * Speech as 24 kHz 16-bit mono WAV, the format the rest of the audio pipeline
 * concatenates and measures. Conversion runs through ffmpeg.
 */
export async function synthesizeSpeechWav(request: SpeechRequest): Promise<{ wav: Buffer; durationMs: number; requestId: string }> {
  const result = await synthesizeSpeech(request);
  const wav = await audioToWav(result.audio, result.format, { sampleRate: 24000, channels: 1 });
  return { wav, durationMs: result.durationMs, requestId: result.requestId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice cloning
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceCloneRequest {
  text: string;
  /** Public URL of the sample to clone (mp3, m4a or wav). */
  sourceAudioUrl: string;
  /** 8..256 chars, letters, digits and underscores. Returned for reuse. */
  voiceId?: string;
  /** Under 8 s, with its transcript, to steer style. */
  promptAudioUrl?: string;
  promptText?: string;
  noiseReduction?: boolean;
  volumeNormalization?: boolean;
}

export async function cloneVoiceAndSpeak(request: VoiceCloneRequest): Promise<SpeechResult & { voiceId?: string }> {
  const payload: Record<string, unknown> = {
    text: request.text.trim(),
    source_audio: request.sourceAudioUrl,
  };
  if (request.voiceId) {
    payload.voice_id = request.voiceId;
  }
  if (request.promptAudioUrl && request.promptText) {
    payload.prompt_audio = request.promptAudioUrl;
    payload.prompt_text = request.promptText;
  }
  if (request.noiseReduction) {
    payload.need_noise_reduction = true;
  }
  if (request.volumeNormalization) {
    payload.need_volumn_normalization = true;
  }

  const record = await runQueued(VOICE_CLONE_MODEL_ID, payload, { pollMs: 2_000, timeoutMs: 5 * 60_000 });
  const remoteUrl = firstMediaUrl(record, "audio");
  const audio = await downloadToBuffer(remoteUrl);
  const outcome = record.outcome ?? {};
  const returnedVoice = typeof outcome.voice_id === "string" ? outcome.voice_id : request.voiceId;
  return {
    audio,
    format: "mp3",
    remoteUrl,
    requestId: record.request_id,
    durationMs: typeof outcome.duration_ms === "number" ? outcome.duration_ms : 0,
    voiceId: returnedVoice,
  };
}

function text_preview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `"${t.slice(0, 57)}..."` : `"${t}"`;
}
