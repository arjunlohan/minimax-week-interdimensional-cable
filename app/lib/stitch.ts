/* eslint-disable no-console */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Buffer } from "node:buffer";

const execFileAsync = promisify(execFile);

/**
 * Absolute paths a system ffmpeg is typically installed at.
 *
 * Resolution cannot lean on bare `"ffmpeg"` and the PATH: the workflow step
 * runtime inherits a minimal `/usr/bin:/bin:/usr/sbin:/sbin`, which contains
 * no Homebrew prefix, so the spawn would fail with ENOENT on a machine that
 * demonstrably has ffmpeg installed.
 */
const SYSTEM_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg", // Homebrew, Apple silicon
  "/usr/local/bin/ffmpeg", // Homebrew, Intel; common Linux install
  "/usr/bin/ffmpeg", // distro package
];

/**
 * Path to the ffmpeg binary.
 *
 * Serverless hosts have no system ffmpeg, so the bundled static build is
 * preferred and a system install is the fallback for local development.
 *
 * The bundled path is existence-checked rather than trusted: the workflow step
 * runtime rewrites module paths into a sandbox prefix, so `require` there
 * returns a path the binary was never unpacked to. Trusting it produced an
 * ENOENT on the stitch step for every locally-run video generation.
 */
const FFMPEG = (() => {
  let bundled: string | null = null;
  try {
    // eslint-disable-next-line ts/no-require-imports
    bundled = require("ffmpeg-static") as string | null;
  } catch {
    bundled = null;
  }

  if (bundled && fs.existsSync(bundled)) {
    return bundled;
  }

  const system = SYSTEM_FFMPEG_PATHS.find(candidate => fs.existsSync(candidate));
  if (system) {
    return system;
  }

  // Nothing found on disk. Fall back to the PATH lookup so a non-standard
  // install still works, and so the failure names ffmpeg rather than a path.
  return "ffmpeg";
})();

/** The ffmpeg binary the pipeline shells out to (bundled build, else a system install). */
export function ffmpegBinary(): string {
  return FFMPEG;
}

/**
 * Duration of a PCM WAV buffer, read from its header.
 *
 * Parsed directly rather than shelled out to ffprobe: ffmpeg-static ships only
 * ffmpeg, and the header already carries everything needed.
 *
 * Returns null when the buffer is not a WAV this can read, so callers can fall
 * back rather than record a wrong duration.
 */
export function wavDurationSeconds(buffer: Buffer): number | null {
  // "RIFF" .... "WAVE"
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let byteRate = 0;
  let offset = 12;

  // Walk the chunk list: fmt carries the byte rate, data carries the payload size.
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === "fmt " && offset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (id === "data") {
      if (byteRate <= 0) {
        return null;
      }
      // A streamed WAV can declare size 0; fall back to what is actually present.
      const dataSize = size > 0 ? Math.min(size, buffer.length - offset - 8) : buffer.length - offset - 8;
      return dataSize / byteRate;
    }

    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  return null;
}

/**
 * Concatenates video clips into a single output file using ffmpeg.
 * Uses the concat demuxer for fast, lossless concatenation when codecs match.
 *
 * @param clipPaths - Array of local file paths to video clips, in order
 * @param outputPath - Optional output path. Defaults to a temp file.
 * @returns Path to the stitched output video
 */
export async function stitchClips(
  clipPaths: string[],
  outputPath?: string,
): Promise<string> {
  console.log("[stitch] stitchClips called with", clipPaths.length, "clips");
  if (clipPaths.length === 0) {
    throw new Error("No clips to stitch");
  }

  // Single clip — just copy it
  if (clipPaths.length === 1) {
    const dest = outputPath ?? generateOutputPath();
    fs.copyFileSync(clipPaths[0], dest);
    return dest;
  }

  const tmpDir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write concat list file
  const listPath = path.join(tmpDir, `concat-${Date.now()}.txt`);
  const listContent = clipPaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, listContent);

  const output = outputPath ?? generateOutputPath();

  try {
    // First try lossless concat (fast, works when codecs match)
    console.log("[stitch] Attempting lossless concat to:", output);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      output,
    ], { timeout: 120_000 });
  } catch (concatErr) {
    // Fallback: re-encode if codecs don't match
    console.warn("[stitch] Lossless concat failed, falling back to re-encode:", concatErr);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-b:a",
      "128k",
      output,
    ], { timeout: 300_000 });
  }

  // Clean up list file
  try {
    fs.unlinkSync(listPath);
  } catch {
    // ignore
  }

  return output;
}

function generateOutputPath(): string {
  const tmpDir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, `stitched-${Date.now()}.mp4`);
}

/**
 * Extracts a single frame from a video at the given timestamp using FFmpeg.
 *
 * @param videoPath - Path to the source video
 * @param timeSeconds - Timestamp in seconds to extract the frame from
 * @returns Path to the extracted PNG frame
 */
export async function extractFrame(
  videoPath: string,
  timeSeconds: number,
): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `frame-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);

  console.log("[stitch] Extracting frame at", timeSeconds, "s from:", videoPath);
  await execFileAsync(FFMPEG, [
    "-y",
    "-ss",
    String(timeSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-f",
    "image2",
    outputPath,
  ], { timeout: 30_000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Frame extraction failed — output not found: ${outputPath}`);
  }

  console.log("[stitch] Frame extracted:", outputPath, `(${(fs.statSync(outputPath).size / 1024).toFixed(0)} KB)`);
  return outputPath;
}

/**
 * Cleans up temporary video files.
 */
export function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p))
        fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
