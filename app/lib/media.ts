import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ffmpegBinary } from "./stitch";

import type { Buffer } from "node:buffer";

const execFileAsync = promisify(execFile);

/**
 * ffmpeg helpers the MiniMax pipeline needs beyond concatenation: probing what
 * a model returned, converting speech to the WAV the audio path expects, and
 * putting a spoken line onto a silent clip.
 *
 * ffmpeg-static ships no ffprobe, so probing parses `ffmpeg -i` itself.
 */

function scratchDir(): string {
  const dir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function scratchPath(prefix: string, extension: string): string {
  return path.join(scratchDir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extension}`);
}

export interface MediaProbe {
  durationSeconds: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  raw: string;
}

/** Runs `ffmpeg -i` and reads the stream summary it prints. */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot probe missing file ${filePath}`);
  }
  let output = "";
  try {
    await execFileAsync(ffmpegBinary(), ["-hide_banner", "-i", filePath], { timeout: 30_000 });
  } catch (err) {
    // ffmpeg exits non-zero when no output is requested; the summary is on stderr.
    const e = err as { stderr?: string; stdout?: string };
    output = `${e.stderr ?? ""}${e.stdout ?? ""}`;
  }

  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSeconds = durationMatch ?
    Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) :
    null;
  const videoLine = output.split("\n").find(line => /Stream #\d+:\d.*Video:/.test(line));
  const hasAudio = /Stream #\d+:\d.*Audio:/.test(output);
  const sizeMatch = videoLine?.match(/(\d{2,5})x(\d{2,5})/);
  const fpsMatch = videoLine?.match(/(\d+(?:\.\d+)?)\s*fps/);

  return {
    durationSeconds,
    hasVideo: Boolean(videoLine),
    hasAudio,
    width: sizeMatch ? Number(sizeMatch[1]) : undefined,
    height: sizeMatch ? Number(sizeMatch[2]) : undefined,
    fps: fpsMatch ? Number(fpsMatch[1]) : undefined,
    raw: output,
  };
}

export interface WavOptions {
  sampleRate?: number;
  channels?: number;
}

/** Decodes any audio file to 16-bit PCM WAV. */
export async function convertToWav(inputPath: string, outputPath?: string, options: WavOptions = {}): Promise<string> {
  const output = outputPath ?? scratchPath("wav", "wav");
  await execFileAsync(ffmpegBinary(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    String(options.channels ?? 1),
    "-ar",
    String(options.sampleRate ?? 24000),
    "-c:a",
    "pcm_s16le",
    // A canonical 44-byte header: no LIST/INFO chunk, so header-walking callers
    // and byte-offset PCM concatenation both stay simple.
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    output,
  ], { timeout: 120_000 });
  return output;
}

/** Same as `convertToWav`, for bytes already in memory. */
export async function audioToWav(bytes: Buffer, extension: string, options: WavOptions = {}): Promise<Buffer> {
  const input = scratchPath("audio-in", extension.replace(/^\./, ""));
  fs.writeFileSync(input, bytes);
  const output = scratchPath("audio-out", "wav");
  try {
    await convertToWav(input, output, options);
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

/**
 * Replaces (or adds) the audio track of a clip with a spoken line. Video is
 * copied untouched; the result ends when the shorter input ends, so pad the
 * audio first if the picture must run its full length.
 */
export async function replaceAudioTrack(videoPath: string, audioPath: string, outputPath?: string): Promise<string> {
  const output = outputPath ?? scratchPath("dubbed", "mp4");
  await execFileAsync(ffmpegBinary(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "128k",
    "-shortest",
    output,
  ], { timeout: 300_000 });
  return output;
}

/** Pads or trims an audio file to an exact length (seconds). */
export async function fitAudioToDuration(audioPath: string, seconds: number, outputPath?: string): Promise<string> {
  const output = outputPath ?? scratchPath("fitted", "wav");
  await execFileAsync(ffmpegBinary(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    audioPath,
    "-af",
    `apad,atrim=0:${seconds.toFixed(3)}`,
    "-c:a",
    "pcm_s16le",
    output,
  ], { timeout: 120_000 });
  return output;
}

export { scratchPath as mediaScratchPath };
