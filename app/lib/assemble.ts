/* eslint-disable no-console */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { probeMedia } from "./media";
import { ffmpegBinary } from "./stitch";

const execFileAsync = promisify(execFile);

/**
 * Episode assembly with ffmpeg.
 *
 * A finished video episode is: a title card with the Music 3.0 theme under it,
 * the MiniMax-H3 clips in order, and an end card with the credits song. The
 * sources differ in codec, size and audio layout, so everything goes through
 * one filter graph and the concat *filter* (not the demuxer, which needs
 * identical streams). The graph is built by a pure function so the argument
 * construction is testable without running ffmpeg.
 *
 * A finished audio episode is: theme (trimmed, faded) + the voiced episode +
 * credits (trimmed, faded), as one WAV the upload step already accepts.
 */

export const ENGINE_LINE = "MiniMax-H3 · Speech 2.8 HD · Music 3.0 on GMI Cloud";
export const CREDITS_LINE = "Written by MiniMax-M3, voiced by Speech 2.8 HD, rendered by MiniMax-H3, scored by Music 3.0, on GMI Cloud";

export const TITLE_CARD_SECONDS = { min: 6, max: 8, default: 7 } as const;
export const END_CARD_SECONDS = { min: 12, max: 15, default: 13 } as const;
export const AUDIO_INTRO_SECONDS = 8;
export const AUDIO_OUTRO_SECONDS = 15;

export const DEFAULT_FPS = 24;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const AUDIO_SAMPLE_RATE = 48000;

export const DEFAULT_FONT_PATH = path.join(process.cwd(), "public", "fonts", "Syne-Bold.ttf");

const CARD_BACKGROUND = "black";
const TEXT_COLOR = "white";
const MUTED_TEXT_COLOR = "0xB8B8B8";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EpisodeClipInput {
  path: string;
  /** Measured length of the clip. Drives the transcript offsets. */
  durationSeconds: number;
  /** Probed when omitted. A silent clip gets a silent track so concat stays aligned. */
  hasAudio?: boolean;
}

export interface EpisodeAssemblyInput {
  clips: EpisodeClipInput[];
  showName: string;
  episodeTitle: string;
  /** First sung line of the credits, shown on the end card. */
  creditsLine?: string | null;
  themeMusicPath?: string | null;
  creditsMusicPath?: string | null;
  titleCardSeconds?: number;
  endCardSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  outputPath?: string;
}

export interface EpisodeLayout {
  titleCardSeconds: number;
  /** Start of each clip in the finished file, in order. */
  clipOffsets: number[];
  clipDurations: number[];
  endCardSeconds: number;
  totalSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** False when the cards were rendered without text (no font or no drawtext). */
  cardText: boolean;
}

export interface TextFile {
  path: string;
  content: string;
}

export interface EpisodeAssemblyPlan {
  /** Complete ffmpeg argument list, binary excluded. */
  args: string[];
  filterGraph: string;
  layout: EpisodeLayout;
  /** drawtext reads its text from files, which sidesteps filter-graph escaping of titles. */
  textFiles: TextFile[];
  outputPath: string;
}

export interface EpisodePlanOptions {
  /** Font to draw the cards with, or null to render plain cards. */
  fontPath: string | null;
  /** Where text files and the default output go. */
  workDir: string;
}

export interface AudioAssemblyInput {
  /** The voiced episode (WAV). */
  episodePath: string;
  themeMusicPath?: string | null;
  creditsMusicPath?: string | null;
  introSeconds?: number;
  outroSeconds?: number;
  outputPath?: string;
}

export interface AudioLayout {
  introSeconds: number;
  /** Where the spoken episode starts in the finished file. */
  episodeOffsetSeconds: number;
  outroSeconds: number;
}

export interface AudioAssemblyPlan {
  args: string[];
  filterGraph: string;
  layout: AudioLayout;
  outputPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Escapes a value for use inside a filter option (`key=value`). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\':,;[\]]/g, ch => `\\${ch}`);
}

/** Greedy word wrap. Long single words are kept whole. */
export function wrapLines(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

export function clampSeconds(value: number | undefined, range: { min: number; max: number; default: number }): number {
  if (value === undefined || !Number.isFinite(value)) {
    return range.default;
  }
  return Math.min(range.max, Math.max(range.min, value));
}

function evenPixels(value: number | undefined, fallback: number): number {
  const n = Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : fallback;
  return n % 2 === 0 ? n : n + 1;
}

function fixed(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`;

/**
 * Trims, fades and pads a music input to exactly `seconds`. Music 3.0 returns
 * a whole song, so the cut and the fade are what make it a bumper.
 */
function musicBed(inputIndex: number, seconds: number, label: string, fadeOut: number): string {
  const fadeIn = 0.4;
  const fadeOutStart = Math.max(0, seconds - fadeOut);
  return `[${inputIndex}:a]atrim=0:${fixed(seconds)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=${fixed(fadeIn)},afade=t=out:st=${fixed(fadeOutStart)}:d=${fixed(fadeOut)},` +
    `apad=whole_dur=${fixed(seconds)},${AUDIO_FORMAT}[${label}]`;
}

function silence(seconds: number, label: string): string {
  return `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo:d=${fixed(seconds)},${AUDIO_FORMAT}[${label}]`;
}

interface CardLine {
  text: string;
  /** Font size as a fraction of the frame height. */
  size: number;
  /** Baseline centre as a fraction of the frame height. */
  y: number;
  color?: string;
}

function drawtext(fontPath: string, textFile: string, line: CardLine, height: number): string {
  const fontSize = Math.max(12, Math.round(height * line.size));
  return `drawtext=fontfile=${escapeFilterValue(fontPath)}:textfile=${escapeFilterValue(textFile)}:expansion=none` +
    `:fontcolor=${line.color ?? TEXT_COLOR}:fontsize=${fontSize}:x=(w-tw)/2:y=${fixed(line.y)}*h-th/2`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video episode plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the ffmpeg invocation for a video episode. Pure: nothing is read or
 * written, so tests can assert on the graph.
 */
export function buildEpisodeAssemblyPlan(input: EpisodeAssemblyInput, options: EpisodePlanOptions): EpisodeAssemblyPlan {
  if (input.clips.length === 0) {
    throw new Error("Cannot assemble an episode with no clips");
  }
  for (const [i, clip] of input.clips.entries()) {
    if (!clip.path) {
      throw new Error(`Clip ${i} has no file path`);
    }
    if (!Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) {
      throw new Error(`Clip ${i} has no measured duration`);
    }
  }

  const width = evenPixels(input.width, DEFAULT_WIDTH);
  const height = evenPixels(input.height, DEFAULT_HEIGHT);
  const fps = Number.isFinite(input.fps) && (input.fps as number) > 0 ? (input.fps as number) : DEFAULT_FPS;
  const titleSeconds = clampSeconds(input.titleCardSeconds, TITLE_CARD_SECONDS);
  const endSeconds = clampSeconds(input.endCardSeconds, END_CARD_SECONDS);
  const outputPath = input.outputPath ?? path.join(options.workDir, `episode-${Date.now()}.mp4`);
  const cardText = Boolean(options.fontPath);

  // Inputs: clips first, then whichever music files exist.
  const inputs: string[] = input.clips.map(c => c.path);
  const themeIndex = input.themeMusicPath ? inputs.push(input.themeMusicPath) - 1 : null;
  const creditsIndex = input.creditsMusicPath ? inputs.push(input.creditsMusicPath) - 1 : null;

  const textFiles: TextFile[] = [];
  const chains: string[] = [];

  const card = (name: string, seconds: number, lines: CardLine[], outLabel: string) => {
    const filters = [`color=c=${CARD_BACKGROUND}:s=${width}x${height}:r=${fps}:d=${fixed(seconds)}`, "format=yuv420p"];
    if (options.fontPath) {
      for (const [k, line] of lines.entries()) {
        const file = path.join(options.workDir, `${name}-${k}.txt`);
        textFiles.push({ path: file, content: line.text });
        filters.push(drawtext(options.fontPath, file, line, height));
      }
    }
    chains.push(`${filters.join(",")}[${outLabel}]`);
  };

  // Title card: show name, episode title, the engines in small type.
  const titleLines: CardLine[] = [];
  const nameLines = wrapLines(input.showName, 22);
  nameLines.forEach((text, k) => titleLines.push({ text, size: 0.1, y: 0.34 + (k - (nameLines.length - 1) / 2) * 0.12 }));
  const episodeLines = wrapLines(input.episodeTitle, 44);
  episodeLines.forEach((text, k) => titleLines.push({ text, size: 0.045, y: 0.56 + k * 0.065 }));
  titleLines.push({ text: ENGINE_LINE, size: 0.026, y: 0.9, color: MUTED_TEXT_COLOR });
  card("title", titleSeconds, titleLines, "tv");
  chains.push(themeIndex === null ? silence(titleSeconds, "ta") : musicBed(themeIndex, titleSeconds, "ta", 1.5));

  // Clips: one common size and frame rate, audio at 48 kHz stereo, padded to the picture.
  input.clips.forEach((clip, i) => {
    chains.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${CARD_BACKGROUND},setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );
    if (clip.hasAudio === false) {
      chains.push(silence(clip.durationSeconds, `a${i}`));
    } else {
      chains.push(`[${i}:a]${AUDIO_FORMAT},asetpts=PTS-STARTPTS,apad=whole_dur=${fixed(clip.durationSeconds)},atrim=0:${fixed(clip.durationSeconds)}[a${i}]`);
    }
  });

  // End card: the credit roll and the first sung line of the credits.
  const endLines: CardLine[] = [];
  const creditLines = wrapLines(CREDITS_LINE, 40);
  creditLines.forEach((text, k) => endLines.push({ text, size: 0.04, y: 0.3 + k * 0.06 }));
  const lyric = input.creditsLine?.trim();
  if (lyric) {
    const lyricLines = wrapLines(`“${lyric}”`, 48);
    lyricLines.forEach((text, k) => endLines.push({ text, size: 0.034, y: 0.72 + k * 0.05, color: MUTED_TEXT_COLOR }));
  }
  card("end", endSeconds, endLines, "ev");
  chains.push(creditsIndex === null ? silence(endSeconds, "ea") : musicBed(creditsIndex, endSeconds, "ea", 2.5));

  const segmentLabels = ["[tv][ta]", ...input.clips.map((_, i) => `[v${i}][a${i}]`), "[ev][ea]"].join("");
  chains.push(`${segmentLabels}concat=n=${input.clips.length + 2}:v=1:a=1[outv][outa]`);
  const filterGraph = chains.join(";");

  const clipOffsets: number[] = [];
  let cursor = titleSeconds;
  for (const clip of input.clips) {
    clipOffsets.push(Number(cursor.toFixed(3)));
    cursor += clip.durationSeconds;
  }
  const layout: EpisodeLayout = {
    titleCardSeconds: titleSeconds,
    clipOffsets,
    clipDurations: input.clips.map(c => Number(c.durationSeconds.toFixed(3))),
    endCardSeconds: endSeconds,
    totalSeconds: Number((cursor + endSeconds).toFixed(3)),
    width,
    height,
    fps,
    cardText,
  };

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs.flatMap(file => ["-i", file]),
    "-filter_complex",
    filterGraph,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-movflags",
    "+faststart",
    outputPath,
  ];

  return { args, filterGraph, layout, textFiles, outputPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio episode plan
// ─────────────────────────────────────────────────────────────────────────────

export function buildAudioAssemblyPlan(input: AudioAssemblyInput, workDir: string): AudioAssemblyPlan {
  if (!input.episodePath) {
    throw new Error("Cannot assemble an audio episode without the voiced episode file");
  }
  const introSeconds = input.themeMusicPath ? (input.introSeconds ?? AUDIO_INTRO_SECONDS) : 0;
  const outroSeconds = input.creditsMusicPath ? (input.outroSeconds ?? AUDIO_OUTRO_SECONDS) : 0;
  const outputPath = input.outputPath ?? path.join(workDir, `episode-${Date.now()}.wav`);

  const inputs = [input.episodePath];
  const themeIndex = input.themeMusicPath ? inputs.push(input.themeMusicPath) - 1 : null;
  const creditsIndex = input.creditsMusicPath ? inputs.push(input.creditsMusicPath) - 1 : null;

  const chains: string[] = [];
  const order: string[] = [];
  if (themeIndex !== null) {
    chains.push(musicBed(themeIndex, introSeconds, "intro", 1.5));
    order.push("[intro]");
  }
  chains.push(`[0:a]${AUDIO_FORMAT},asetpts=PTS-STARTPTS[episode]`);
  order.push("[episode]");
  if (creditsIndex !== null) {
    chains.push(musicBed(creditsIndex, outroSeconds, "outro", 3));
    order.push("[outro]");
  }
  chains.push(`${order.join("")}concat=n=${order.length}:v=0:a=1[out]`);
  const filterGraph = chains.join(";");

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs.flatMap(file => ["-i", file]),
    "-filter_complex",
    filterGraph,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    "2",
    outputPath,
  ];

  return {
    args,
    filterGraph,
    layout: { introSeconds, episodeOffsetSeconds: introSeconds, outroSeconds },
    outputPath,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runners
// ─────────────────────────────────────────────────────────────────────────────

function workDir(): string {
  const dir = path.join(os.tmpdir(), "interdimensional-cable");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let drawtextProbe: Promise<boolean> | null = null;

/** Whether this ffmpeg build carries the drawtext filter (needs libfreetype). */
export function drawtextAvailable(): Promise<boolean> {
  if (!drawtextProbe) {
    drawtextProbe = execFileAsync(ffmpegBinary(), ["-hide_banner", "-filters"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
      .then(({ stdout }) => /\bdrawtext\b/.test(stdout))
      .catch(() => false);
  }
  return drawtextProbe;
}

/** Test seam. */
export function _resetDrawtextProbe(): void {
  drawtextProbe = null;
}

/**
 * The font the cards are drawn with, or null when text has to be skipped.
 * Skipping is logged: a card without a title is a degraded episode, not a
 * silent success.
 */
export async function resolveCardFont(fontPath = DEFAULT_FONT_PATH): Promise<string | null> {
  if (!fs.existsSync(fontPath)) {
    console.warn(`[assemble] Card font not found at ${fontPath}; rendering title and end cards without text`);
    return null;
  }
  if (!(await drawtextAvailable())) {
    console.warn("[assemble] This ffmpeg build has no drawtext filter; rendering title and end cards without text");
    return null;
  }
  return fontPath;
}

export interface AssembledEpisode {
  outputPath: string;
  layout: EpisodeLayout;
  assemblyMs: number;
}

/** Renders the finished video episode. */
export async function assembleEpisode(input: EpisodeAssemblyInput, fontPath?: string): Promise<AssembledEpisode> {
  const startedAt = Date.now();
  const dir = workDir();

  // Probe what the planner was not told: audio presence and the common frame size.
  const clips: EpisodeClipInput[] = [];
  let width = input.width;
  let height = input.height;
  for (const clip of input.clips) {
    if (clip.hasAudio === undefined || (!width && !height)) {
      const probe = await probeMedia(clip.path);
      clips.push({ ...clip, hasAudio: clip.hasAudio ?? probe.hasAudio });
      if (!width && !height && probe.width && probe.height) {
        width = probe.width;
        height = probe.height;
      }
    } else {
      clips.push(clip);
    }
  }

  const font = await resolveCardFont(fontPath);
  const plan = buildEpisodeAssemblyPlan({ ...input, clips, width, height }, { fontPath: font, workDir: dir });

  for (const file of plan.textFiles) {
    fs.writeFileSync(file.path, file.content, "utf8");
  }
  console.log(`[assemble] Rendering ${clips.length} clips into ${plan.layout.totalSeconds}s at ${plan.layout.width}x${plan.layout.height} (title ${plan.layout.titleCardSeconds}s, end card ${plan.layout.endCardSeconds}s, text: ${plan.layout.cardText})`);
  try {
    await execFileAsync(ffmpegBinary(), plan.args, { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`ffmpeg failed to assemble the episode: ${(e.stderr || e.message || String(err)).trim().slice(0, 800)}`);
  } finally {
    for (const file of plan.textFiles) {
      fs.rmSync(file.path, { force: true });
    }
  }
  if (!fs.existsSync(plan.outputPath)) {
    throw new Error(`ffmpeg reported success but ${plan.outputPath} does not exist`);
  }
  const assemblyMs = Date.now() - startedAt;
  console.log(`[assemble] Episode ready in ${Math.round(assemblyMs / 1000)}s: ${plan.outputPath}`);
  return { outputPath: plan.outputPath, layout: plan.layout, assemblyMs };
}

export interface AssembledAudioEpisode {
  outputPath: string;
  layout: AudioLayout;
  assemblyMs: number;
}

/** Renders the finished audio episode as one WAV. */
export async function assembleAudioEpisode(input: AudioAssemblyInput): Promise<AssembledAudioEpisode> {
  const startedAt = Date.now();
  const plan = buildAudioAssemblyPlan(input, workDir());
  console.log(`[assemble] Rendering audio episode (intro ${plan.layout.introSeconds}s, outro ${plan.layout.outroSeconds}s)`);
  try {
    await execFileAsync(ffmpegBinary(), plan.args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`ffmpeg failed to assemble the audio episode: ${(e.stderr || e.message || String(err)).trim().slice(0, 800)}`);
  }
  if (!fs.existsSync(plan.outputPath)) {
    throw new Error(`ffmpeg reported success but ${plan.outputPath} does not exist`);
  }
  const assemblyMs = Date.now() - startedAt;
  console.log(`[assemble] Audio episode ready in ${Math.round(assemblyMs / 1000)}s: ${plan.outputPath}`);
  return { outputPath: plan.outputPath, layout: plan.layout, assemblyMs };
}
