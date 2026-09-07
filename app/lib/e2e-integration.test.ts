import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetExceededError } from "@/app/lib/gmi/spend";
import { GmiContentFilterError } from "@/app/lib/gmi/video";
import * as schema from "@/db/schema";
import { generateShowWorkflow } from "@/workflows/generate-show";
import type { EngineNotes, ProgressEvent, TranscriptSegment } from "@/workflows/generate-show";

/**
 * End-to-end: the durable show workflow from research to Mux, on MiniMax
 * models through GMI Cloud. Every external boundary (the models, the DB, Mux,
 * ffmpeg assembly, the network) is mocked at the module seam; the workflow's
 * own orchestration, persistence, timing and failure handling run for real.
 */

const mocks = vi.hoisted(() => ({
  env: {
    DATABASE_URL: "postgresql://localhost:5432/test",
    MUX_TOKEN_ID: "mux-id",
    MUX_TOKEN_SECRET: "mux-secret",
    H3_RESOLUTION: undefined as string | undefined,
    H3_AUDIO_STRATEGY: undefined as string | undefined,
  },
  state: {
    show: {} as Record<string, any>,
    template: {} as Record<string, any>,
    clips: [] as Array<Record<string, any>>,
    updates: [] as Array<{ table: string; values: Record<string, any> }>,
  },
  progress: [] as ProgressEvent[],
  tmpDir: "",
  tmpCounter: 0,
  runPass1Research: vi.fn(),
  runDramaturgyPipeline: vi.fn(),
  generateH3Clip: vi.fn(),
  referencePortraitUrls: vi.fn(),
  synthesizeSpeech: vi.fn(),
  uploadToGmi: vi.fn(),
  generateJson: vi.fn(),
  generateText: vi.fn(),
  generateMusic: vi.fn(),
  emotionForSegment: vi.fn(),
  voiceForHost: vi.fn(),
  generateTtsPerTurn: vi.fn(),
  extractFrame: vi.fn(),
  cleanupTempFiles: vi.fn(),
  fitAudioToDuration: vi.fn(),
  replaceAudioTrack: vi.fn(),
  assembleEpisode: vi.fn(),
  assembleAudioEpisode: vi.fn(),
  getMuxCapacity: vi.fn(),
  createDirectUpload: vi.fn(),
  waitForUploadAssetId: vi.fn(),
  waitForAssetReady: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/app/lib/env", () => ({ env: mocks.env }));

vi.mock("workflow", () => ({
  getWritable: () => new WritableStream<ProgressEvent>({ write: (event) => {
    mocks.progress.push(event);
  } }),
}));

vi.mock("pg", () => ({
  Pool: class {
    end = vi.fn();
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: (col: unknown, val: unknown) => ({ __eq: true, col, val }) };
});

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => createFakeDb(),
}));

vi.mock("@/app/lib/dramaturgy/pass1-research", () => ({ runPass1Research: mocks.runPass1Research }));
vi.mock("@/app/lib/dramaturgy/orchestrator", () => ({ runDramaturgyPipeline: mocks.runDramaturgyPipeline }));

vi.mock("@/app/lib/gmi/video", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/gmi/video")>();
  return { ...actual, generateH3Clip: mocks.generateH3Clip, referencePortraitUrls: mocks.referencePortraitUrls };
});
vi.mock("@/app/lib/gmi/speech", () => ({ synthesizeSpeech: mocks.synthesizeSpeech }));
vi.mock("@/app/lib/gmi/upload", () => ({ uploadToGmi: mocks.uploadToGmi }));
vi.mock("@/app/lib/gmi/text", () => ({ generateJson: mocks.generateJson, generateText: mocks.generateText }));
vi.mock("@/app/lib/gmi/music", () => ({ generateMusic: mocks.generateMusic }));
vi.mock("@/app/lib/gmi/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/gmi/queue")>();
  return { ...actual, tmpPath: (prefix: string, ext: string) => path.join(mocks.tmpDir, `${prefix}-${mocks.tmpCounter++}.${ext}`) };
});

vi.mock("@/app/lib/tts", () => ({
  voiceForHost: mocks.voiceForHost,
  emotionForSegment: mocks.emotionForSegment,
  generateTtsPerTurn: mocks.generateTtsPerTurn,
}));

vi.mock("@/app/lib/stitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/stitch")>();
  return { ...actual, extractFrame: mocks.extractFrame, cleanupTempFiles: mocks.cleanupTempFiles };
});

vi.mock("@/app/lib/media", () => ({
  probeMedia: vi.fn(),
  fitAudioToDuration: mocks.fitAudioToDuration,
  replaceAudioTrack: mocks.replaceAudioTrack,
}));

vi.mock("@/app/lib/assemble", () => ({
  assembleEpisode: mocks.assembleEpisode,
  assembleAudioEpisode: mocks.assembleAudioEpisode,
}));

vi.mock("@/app/lib/mux", () => ({
  getMuxCapacity: mocks.getMuxCapacity,
  createDirectUpload: mocks.createDirectUpload,
  waitForUploadAssetId: mocks.waitForUploadAssetId,
  waitForAssetReady: mocks.waitForAssetReady,
}));

function createFakeDb() {
  const { state } = mocks;
  const tableName = (table: unknown) =>
    table === schema.videoClips ? "videoClips" : table === schema.showTemplates ? "showTemplates" : "generatedShows";
  const rowsFor = (table: unknown) =>
    table === schema.videoClips ? state.clips : table === schema.showTemplates ? [state.template] : [state.show];
  const matches = (table: any, cond: any) => (row: Record<string, any>) => {
    if (!cond || !cond.__eq) {
      return true;
    }
    const key = Object.keys(table).find(k => table[k] === cond.col);
    return key ? row[key] === cond.val : true;
  };
  return {
    query: {
      generatedShows: { findFirst: async () => state.show },
      showTemplates: { findFirst: async () => state.template },
      videoClips: { findMany: async () => [...state.clips].sort((a, b) => a.clipIndex - b.clipIndex) },
    },
    update: (table: any) => ({
      set: (values: Record<string, any>) => ({
        where: async (cond: any) => {
          for (const row of rowsFor(table).filter(matches(table, cond))) {
            Object.assign(row, values);
          }
          state.updates.push({ table: tableName(table), values });
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (rows: Record<string, any> | Array<Record<string, any>>) => {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          rowsFor(table).push({ id: `${tableName(table)}-${rowsFor(table).length}`, ...row });
        }
      },
    }),
    delete: (table: any) => ({
      where: async (cond: any) => {
        const rows = rowsFor(table);
        const keep = rows.filter(row => !matches(table, cond)(row));
        rows.splice(0, rows.length, ...keep);
      },
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DESK_HOSTS = [{ name: "John Olive", personality: "Witty British host", position: "center" }];
const PANEL_HOSTS = [
  { name: "Joe Brogan", personality: "Curious, laid-back, he wonders aloud", position: "left" },
  { name: "Duncan Trussed", personality: "Mystic co-host, she riffs", position: "right" },
];

const SCRIPT_SEGMENTS: TranscriptSegment[] = [
  { clipIndex: 0, speaker: "John Olive", text: "Tonight: toasters have unionized.", visualPrompt: "The host at the desk, a toaster graphic behind him.", actingDirection: "deadpan", startTimeSeconds: 0, endTimeSeconds: 10, durationSeconds: 10 },
  { clipIndex: 1, speaker: "John Olive", text: "Their first demand is a four-slot work week.", visualPrompt: "", actingDirection: "outraged", startTimeSeconds: 10, endTimeSeconds: 20, durationSeconds: 10 },
  { clipIndex: 2, speaker: "John Olive", text: "Management responded with a bagel.", visualPrompt: "", startTimeSeconds: 20, endTimeSeconds: 30, durationSeconds: 10 },
];

const PODCAST_SEGMENTS: TranscriptSegment[] = [
  { clipIndex: 0, speaker: "Joe Brogan", text: "So, toasters. Are they conscious?", visualPrompt: "", startTimeSeconds: 0, endTimeSeconds: 8, durationSeconds: 8 },
  { clipIndex: 1, speaker: "Duncan Trussed", text: "Bread is a portal, Joe.", visualPrompt: "", actingDirection: "whispering", startTimeSeconds: 8, endTimeSeconds: 16, durationSeconds: 8 },
  { clipIndex: 2, speaker: "Joe Brogan", text: "That is wild.", visualPrompt: "", startTimeSeconds: 16, endTimeSeconds: 24, durationSeconds: 8 },
];

const BRIEF = { topic: "Sentient toasters", groundedFacts: [{ fact: "Toasters exist" }], premiseAngles: [{ angle: "labour" }], selectedAngle: { escalationLadder: [] } };

function wavOf(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 24000 * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function h3Result(i: number, overrides: Record<string, unknown> = {}) {
  const localPath = path.join(mocks.tmpDir, `h3-clip-${i}.mp4`);
  fs.writeFileSync(localPath, `clip-${i}`);
  return {
    localPath,
    videoUrl: localPath,
    remoteUrl: `https://gmi.example/clips/${i}.mp4`,
    thumbnailUrl: `https://gmi.example/clips/${i}.jpg`,
    requestId: `h3-${i}`,
    durationSeconds: [9.4, 11.05, 8.2][i] ?? 9,
    hasAudio: true,
    width: 1366,
    height: 768,
    generationMs: 60_000 + i,
    ...overrides,
  };
}

function record(id: string): { request_id: string; model: string; status: string } {
  return { request_id: id, model: "MiniMax-H3", status: "failed" };
}

function statuses(): string[] {
  return mocks.state.updates.filter(u => u.table === "generatedShows" && u.values.status).map(u => u.values.status);
}

function steps(events: ProgressEvent[]): string[] {
  return events.map(e => `${e.type}:${e.step}`);
}

function resetState(showOverrides: Record<string, any> = {}, templateOverrides: Record<string, any> = {}) {
  mocks.state.show = {
    id: "show-1",
    templateId: "template-1",
    topic: "Sentient toasters",
    topicType: "freetext",
    durationSeconds: 90,
    format: "video",
    familiarity: "familiar",
    status: "pending",
    language: "en",
    useFrameChaining: false,
    voiceAssignments: null,
    transcriptSegments: null,
    transcript: null,
    researchContext: null,
    themeLyrics: null,
    creditsLyrics: null,
    musicPrompt: null,
    engineNotes: null,
    localRenderPath: null,
    encryptedApiKeys: null,
    muxAssetId: null,
    muxPlaybackId: null,
    userId: "user-1",
    error: null,
    ...showOverrides,
  };
  mocks.state.template = {
    id: "template-1",
    name: "John Oliver Like",
    showType: "monologue",
    referenceImageUrl: "/templates/investigative-desk.jpg",
    hosts: DESK_HOSTS,
    notes: "HBO style investigative desk",
    ...templateOverrides,
  };
  mocks.state.clips = [];
  mocks.state.updates = [];
  mocks.progress = [];
}

function installHappyPath(segments: TranscriptSegment[], title = "The Toaster Union") {
  mocks.runPass1Research.mockResolvedValue({ brief: BRIEF });
  mocks.runDramaturgyPipeline.mockResolvedValue({
    finalScript: {
      title,
      showType: mocks.state.template.showType,
      archetype: segments === PODCAST_SEGMENTS ? "conversational_podcast" : "writers_room_desk",
      totalDurationSeconds: segments.length * 10,
      segments,
      transcriptPlainText: segments.map(s => `${s.speaker}: ${s.text}`).join("\n"),
    },
    researchBrief: BRIEF,
    executionMetrics: { totalDurationMs: 12_345, tableReadAvgScore: 8.2 },
  });
  mocks.referencePortraitUrls.mockResolvedValue(["https://gmi.example/portrait.jpg"]);
  mocks.emotionForSegment.mockImplementation((direction?: string) => (direction === "outraged" ? "angry" : "auto"));
  mocks.voiceForHost.mockImplementation((host: { name: string }) => (host.name === "Duncan Trussed" ? "English_Graceful_Lady" : "English_magnetic_voiced_man"));
  mocks.synthesizeSpeech.mockImplementation(async ({ text }: { text: string }) => ({
    audio: Buffer.from(`speech:${text}`),
    format: "mp3",
    remoteUrl: "https://gmi.example/speech.mp3",
    requestId: `speech-${mocks.tmpCounter++}`,
    durationMs: 8_200,
  }));
  mocks.uploadToGmi.mockImplementation(async (_bytes: Buffer, type: string) => `https://gmi.example/upload-${mocks.tmpCounter++}.${type}`);
  mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1));
  mocks.generateTtsPerTurn.mockResolvedValue({ wav: wavOf(17.5), durations: [6.25, 8.5, 2.75] });
  mocks.generateJson.mockResolvedValue({
    theme: { lyrics: "[Intro]\nJohn Oliver Like, live tonight\n[Hook]\nToasters in the spotlight", style: "Late-night big band" },
    credits: { lyrics: "[Verse]\nThree jokes we told tonight\n[Outro]\nGood night", style: "Swing outro" },
  });
  mocks.generateMusic.mockImplementation(async ({ lyrics }: { lyrics: string }) => {
    const localPath = path.join(mocks.tmpDir, `music-${mocks.tmpCounter++}.mp3`);
    fs.writeFileSync(localPath, lyrics);
    return { localPath, audio: Buffer.from(lyrics), remoteUrl: "https://gmi.example/music.mp3", requestId: `music-${mocks.tmpCounter}`, durationMs: 30_000, format: "mp3" };
  });
  mocks.fitAudioToDuration.mockImplementation(async (audioPath: string) => `${audioPath}.fitted.wav`);
  mocks.replaceAudioTrack.mockImplementation(async (videoPath: string) => {
    const dubbed = `${videoPath}.dubbed.mp4`;
    fs.writeFileSync(dubbed, "dubbed");
    return dubbed;
  });
  mocks.extractFrame.mockImplementation(async (videoPath: string, t: number) => {
    const frame = path.join(mocks.tmpDir, `${path.basename(videoPath)}-at-${t}.png`);
    fs.writeFileSync(frame, "png");
    return frame;
  });
  mocks.assembleEpisode.mockImplementation(async (input: { clips: Array<{ durationSeconds: number }> }) => {
    const outputPath = path.join(mocks.tmpDir, "episode.mp4");
    fs.writeFileSync(outputPath, "assembled-episode");
    const offsets: number[] = [];
    let cursor = 7;
    for (const clip of input.clips) {
      offsets.push(cursor);
      cursor += clip.durationSeconds;
    }
    return {
      outputPath,
      layout: { titleCardSeconds: 7, clipOffsets: offsets, clipDurations: input.clips.map(c => c.durationSeconds), endCardSeconds: 13, totalSeconds: cursor + 13, width: 1366, height: 768, fps: 24, cardText: true },
      assemblyMs: 4_000,
    };
  });
  mocks.assembleAudioEpisode.mockImplementation(async () => {
    const outputPath = path.join(mocks.tmpDir, "podcast.wav");
    fs.writeFileSync(outputPath, "assembled-podcast");
    return { outputPath, layout: { introSeconds: 8, episodeOffsetSeconds: 8, outroSeconds: 15 }, assemblyMs: 900 };
  });
  mocks.getMuxCapacity.mockResolvedValue({ used: 3, limit: 10, available: 7, hasRoom: true });
  mocks.createDirectUpload.mockResolvedValue({ uploadId: "upload-1", uploadUrl: "https://mux.example/upload/1", assetId: "" });
  mocks.waitForUploadAssetId.mockResolvedValue("asset-1");
  mocks.waitForAssetReady.mockResolvedValue({ playback_ids: [{ id: "playback-1" }] });
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith("https://mux.example/")) {
      return { ok: true, status: 200, text: async () => "" };
    }
    throw new Error(`Unexpected fetch of ${url}`);
  });
}

beforeEach(() => {
  mocks.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-show-"));
  mocks.tmpCounter = 0;
  mocks.env.H3_AUDIO_STRATEGY = undefined;
  mocks.env.H3_RESOLUTION = undefined;
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) {
      (value as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(mocks.tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("e2e: a video episode on MiniMax-H3, Speech 2.8 HD, Music 3.0 and M3", () => {
  it("runs research, script, voices, generate-clips, music, stitch, upload and lands the show on Mux", async () => {
    installHappyPath(SCRIPT_SEGMENTS);

    const result = await generateShowWorkflow("show-1");

    expect(result).toEqual({
      success: true,
      currentStep: "upload",
      completedSteps: ["research", "script", "voices", "generate-clips", "music", "stitch", "upload"],
    });
    expect(steps(mocks.progress)).toEqual([
      "current:research",
      "completed:research",
      "current:script",
      "completed:script",
      "current:voices",
      "completed:voices",
      "current:generate-clips",
      "completed:generate-clips",
      "current:music",
      "completed:music",
      "current:stitch",
      "completed:stitch",
      "current:upload",
      "completed:upload",
    ]);
    expect(statuses()).toEqual(["researching", "scripting", "voicing", "generating", "scoring", "stitching", "uploading", "ready"]);

    // The writers' room got the format and the show's own fields.
    expect(mocks.runPass1Research).toHaveBeenCalledTimes(1);
    expect(mocks.runDramaturgyPipeline).toHaveBeenCalledWith(expect.objectContaining({
      showId: "show-1",
      topic: "Sentient toasters",
      topicType: "freetext",
      templateId: "template-1",
      skillIdOrSlug: "John Oliver Like",
      durationSeconds: 90,
      familiarity: "familiar",
      userId: "user-1",
      language: "en",
      format: "video",
    }));

    // One Speech 2.8 line and one H3 clip per beat, in reference mode.
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(3);
    for (const call of mocks.generateH3Clip.mock.calls) {
      expect(call[0].referenceImageUrls).toEqual(["https://gmi.example/portrait.jpg"]);
      expect(call[0].referenceAudioUrls).toHaveLength(1);
      expect(call[0].firstFrameUrl).toBeUndefined();
    }
    expect(mocks.generateMusic).toHaveBeenCalledTimes(2);
    expect(mocks.assembleEpisode).toHaveBeenCalledTimes(1);
    expect(mocks.assembleAudioEpisode).not.toHaveBeenCalled();

    // Upload: the assembled mp4 went to Mux and the show is playable.
    expect(mocks.fetch).toHaveBeenCalledWith("https://mux.example/upload/1", expect.objectContaining({ method: "PUT", headers: { "Content-Type": "video/mp4" } }));
    const body = mocks.fetch.mock.calls.find(c => c[0] === "https://mux.example/upload/1")![1].body as Buffer;
    expect(body.toString()).toBe("assembled-episode");
    const show = mocks.state.show;
    expect(show.status).toBe("ready");
    expect(show.muxAssetId).toBe("asset-1");
    expect(show.muxPlaybackId).toBe("playback-1");
    expect(show.localRenderPath).toBeNull();
    expect(show.encryptedApiKeys).toBeNull();
    expect(show.error).toBeNull();
    expect(show.voiceAssignments).toEqual({ "John Olive": "English_magnetic_voiced_man" });
    expect(show.themeLyrics).toContain("[Hook]");
    expect(show.creditsLyrics).toContain("[Outro]");
    expect(show.musicPrompt).toBe("Theme: Late-night big band\n\nCredits: Swing outro");

    // Transcript timed from the measured clips, offset by the title card.
    expect(show.transcriptSegments.map((s: TranscriptSegment) => [s.startTimeSeconds, s.endTimeSeconds])).toEqual([[7, 16.4], [16.4, 27.45], [27.45, 35.65]]);

    // Per-clip persistence.
    const clips = mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex);
    expect(clips.map(c => [c.status, c.gmiRequestId, c.audioSource, c.measuredDurationSeconds])).toEqual([
      ["ready", "h3-0", "h3", 9.4],
      ["ready", "h3-1", "h3", 11.05],
      ["ready", "h3-2", "h3", 8.2],
    ]);

    // Engine notes carry everything the watch page needs to explain the run.
    const notes = show.engineNotes as EngineNotes;
    expect(notes.engines).toEqual({ text: "MiniMax-M3", speech: "MiniMax Speech 2.8 HD", video: "MiniMax-H3", music: "MiniMax Music 3.0", platform: "GMI Cloud" });
    expect(notes.format).toBe("video");
    expect(notes.research).toEqual({ source: "freetext" });
    expect(notes.script).toMatchObject({ title: "The Toaster Union", archetype: "writers_room_desk", tableReadAvgScore: 8.2, dramaturgyMs: 12_345 });
    expect(notes.voices?.assignments).toEqual({ "John Olive": "English_magnetic_voiced_man" });
    expect(notes.voices?.lines).toHaveLength(3);
    expect(notes.audioStrategy).toBe("reference");
    expect(notes.resolution).toBe("768P");
    expect(notes.frameChaining).toBe(false);
    expect(notes.referencePortrait).toBe(true);
    expect(notes.clips?.map(c => [c.clipIndex, c.mode, c.generationMs])).toEqual([[0, "reference", 60_000], [1, "reference", 60_001], [2, "reference", 60_002]]);
    expect(notes.music?.theme.durationMs).toBe(30_000);
    expect(notes.layout).toMatchObject({ titleCardSeconds: 7, clipOffsets: [7, 16.4, 27.45], endCardSeconds: 13 });
    expect(notes.assemblyMs).toBe(4_000);
  });

  it("with frame chaining, reports the anchor clip as the frame-chain step and chains the rest without references", async () => {
    resetState({ useFrameChaining: true });
    installHappyPath(SCRIPT_SEGMENTS);

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(true);
    expect(result.completedSteps).toEqual(["research", "script", "voices", "frame-chain", "generate-clips", "music", "stitch", "upload"]);
    expect(steps(mocks.progress).slice(4, 10)).toEqual([
      "current:voices",
      "completed:voices",
      "current:frame-chain",
      "completed:frame-chain",
      "current:generate-clips",
      "completed:generate-clips",
    ]);
    const calls = mocks.generateH3Clip.mock.calls.map(c => c[0]);
    expect(calls[0].referenceImageUrls).toEqual(["https://gmi.example/portrait.jpg"]);
    expect(calls[0].firstFrameUrl).toBeUndefined();
    expect(calls[1].firstFrameUrl).toMatch(/\.png$/);
    expect(calls[1].referenceImageUrls).toBeUndefined();
    expect(calls[1].referenceAudioUrls).toBeUndefined();
    expect(calls[2].firstFrameUrl).toMatch(/\.png$/);
    expect(mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex).map(c => c.audioSource)).toEqual(["h3", "tts-overlay", "tts-overlay"]);
    expect((mocks.state.show.engineNotes as EngineNotes).frameChaining).toBe(true);
  });

  it("reads a news link once, refuses unreadable pages, and hands the article text to both research and the writers' room", async () => {
    resetState({ topic: "https://news.example/toasters", topicType: "news_link" });
    installHappyPath(SCRIPT_SEGMENTS);
    const article = `<html><head><script>var x = 1;</script><style>.a{}</style></head><body><h1>Toasters unionize</h1><p>${"The toasters of the world have organised. ".repeat(20)}</p></body></html>`;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === "https://news.example/toasters") {
        return { ok: true, status: 200, text: async () => article };
      }
      return { ok: true, status: 200, text: async () => "" };
    });

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(true);
    const researchTopic = mocks.runPass1Research.mock.calls[0][0].topic as string;
    expect(researchTopic).toMatch(/^URL: https:\/\/news\.example\/toasters\n\nContent: Toasters unionize The toasters of the world/);
    expect(researchTopic).not.toContain("var x = 1");
    // The script step reads the same article rather than the bare URL.
    expect(mocks.runDramaturgyPipeline.mock.calls[0][0].topic).toBe(researchTopic);
    expect((mocks.state.show.engineNotes as EngineNotes).research).toMatchObject({ source: "news_link", extractedChars: expect.any(Number) });
    expect(mocks.fetch.mock.calls.filter(c => c[0] === "https://news.example/toasters")).toHaveLength(1);
  });
});

describe("e2e: an audio episode on Speech 2.8 HD, Music 3.0 and M3", () => {
  it("runs research, script, voices, music, stitch, upload with no MiniMax-H3 call and uploads a WAV", async () => {
    resetState({ format: "audio", durationSeconds: 180 }, { name: "Joe Rogan Like", showType: "conversation", hosts: PANEL_HOSTS, referenceImageUrl: "/templates/speculative-frontier.jpg", notes: "Long-form wonder podcast" });
    installHappyPath(PODCAST_SEGMENTS, "Bread Is a Portal");

    const result = await generateShowWorkflow("show-1");

    expect(result).toEqual({
      success: true,
      currentStep: "upload",
      completedSteps: ["research", "script", "voices", "music", "stitch", "upload"],
    });
    expect(steps(mocks.progress)).toEqual([
      "current:research",
      "completed:research",
      "current:script",
      "completed:script",
      "current:voices",
      "completed:voices",
      "current:music",
      "completed:music",
      "current:stitch",
      "completed:stitch",
      "current:upload",
      "completed:upload",
    ]);
    expect(statuses()).toEqual(["researching", "scripting", "voicing", "scoring", "stitching", "uploading", "ready"]);
    expect(mocks.runDramaturgyPipeline.mock.calls[0][0].format).toBe("audio");

    expect(mocks.generateH3Clip).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    expect(mocks.referencePortraitUrls).not.toHaveBeenCalled();
    expect(mocks.generateTtsPerTurn).toHaveBeenCalledTimes(1);
    expect(mocks.generateTtsPerTurn.mock.calls[0][1].map((h: any) => h.ttsVoice)).toEqual(["English_magnetic_voiced_man", "English_Graceful_Lady"]);
    expect(mocks.generateMusic).toHaveBeenCalledTimes(2);
    expect(mocks.generateJson.mock.calls[0][0].prompt).toContain("lo-fi or acoustic");
    expect(mocks.assembleAudioEpisode).toHaveBeenCalledTimes(1);
    expect(mocks.assembleEpisode).not.toHaveBeenCalled();
    expect(mocks.state.clips).toEqual([]);

    expect(mocks.fetch).toHaveBeenCalledWith("https://mux.example/upload/1", expect.objectContaining({ method: "PUT", headers: { "Content-Type": "audio/wav" } }));
    const show = mocks.state.show;
    expect(show.status).toBe("ready");
    expect(show.voiceAssignments).toEqual({ "Joe Brogan": "English_magnetic_voiced_man", "Duncan Trussed": "English_Graceful_Lady" });
    // Measured per turn, then shifted behind the 8 s theme.
    expect(show.transcriptSegments.map((s: TranscriptSegment) => [s.startTimeSeconds, s.endTimeSeconds])).toEqual([[8, 14.25], [14.25, 22.75], [22.75, 25.5]]);
    const notes = show.engineNotes as EngineNotes;
    expect(notes.engines?.video).toBeUndefined();
    expect(notes.format).toBe("audio");
    expect(notes.layout).toEqual({ introSeconds: 8, episodeOffsetSeconds: 8, outroSeconds: 15 });
    expect(notes.clips).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honest failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe("e2e: honest failures", () => {
  it("stops before any model call when a news link cannot be read, naming the reason", async () => {
    resetState({ topic: "https://news.example/paywalled", topicType: "news_link" });
    installHappyPath(SCRIPT_SEGMENTS);
    mocks.fetch.mockResolvedValue({ ok: false, status: 403, text: async () => "" });

    const result = await generateShowWorkflow("show-1");

    expect(result).toEqual({
      success: false,
      currentStep: "research",
      completedSteps: [],
      error: "Could not read https://news.example/paywalled: the site returned HTTP 403. Paste the article text directly, or try a different link.",
    });
    expect(mocks.state.show.status).toBe("failed");
    expect(mocks.state.show.error).toBe(result.error);
    expect(mocks.runPass1Research).not.toHaveBeenCalled();
    expect(mocks.runDramaturgyPipeline).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("refuses to spend on generation when Mux has no room, before a single line is voiced", async () => {
    installHappyPath(SCRIPT_SEGMENTS);
    mocks.getMuxCapacity.mockResolvedValue({ used: 10, limit: 10, available: 0, hasRoom: false });

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(false);
    expect(result.completedSteps).toEqual(["research", "script"]);
    expect(result.error).toBe("Mux storage is full (10/10 assets). Delete a show from the library to free a slot, then try again. Generation was stopped before starting so no render time was spent.");
    expect(mocks.state.show.status).toBe("failed");
    expect(mocks.state.show.error).toBe(result.error);
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    expect(mocks.generateH3Clip).not.toHaveBeenCalled();
    expect(mocks.generateMusic).not.toHaveBeenCalled();
  });

  it("keeps a finished render on disk when Mux fills up between the preflight and the upload", async () => {
    installHappyPath(SCRIPT_SEGMENTS);
    mocks.createDirectUpload.mockRejectedValue(new Error("Free plan is limited to 10 assets, and this request would result in exceeding this limit."));

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(false);
    expect(result.completedSteps).toEqual(["research", "script", "voices", "generate-clips", "music", "stitch"]);
    const renderPath = path.join(mocks.tmpDir, "episode.mp4");
    expect(result.error).toBe(
      `Mux storage filled up before upload. Your rendered show was kept at: ${renderPath}. ` +
      "Delete a show from the library to free a slot, then use Retry upload. The render is complete, so retrying costs nothing to regenerate.",
    );
    expect(mocks.state.show.status).toBe("failed");
    expect(mocks.state.show.error).toBe(result.error);
    expect(mocks.state.show.localRenderPath).toBe(renderPath);
    expect(fs.existsSync(renderPath)).toBe(true);
    expect(mocks.cleanupTempFiles.mock.calls.flat(2)).not.toContain(renderPath);
  });

  it("aborts the run with the budget message when a MiniMax-H3 cap is hit mid-episode", async () => {
    installHappyPath(SCRIPT_SEGMENTS);
    const budget = "This show has already issued 14 MiniMax-H3 requests, the per-run cap (H3_MAX_REQUESTS_PER_RUN=14). Shorten the episode or raise the cap.";
    mocks.generateH3Clip
      .mockImplementationOnce(async () => h3Result(0))
      .mockRejectedValueOnce(new BudgetExceededError(budget));

    const result = await generateShowWorkflow("show-1");

    expect(result).toEqual({ success: false, currentStep: "voices", completedSteps: ["research", "script", "voices"], error: budget });
    expect(mocks.state.show.status).toBe("failed");
    expect(mocks.state.show.error).toBe(budget);
    expect(statuses()).toEqual(["researching", "scripting", "voicing", "generating", "failed"]);
    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(2);
    expect(mocks.generateMusic).not.toHaveBeenCalled();
    expect(mocks.assembleEpisode).not.toHaveBeenCalled();
    expect(mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex).map(c => c.status)).toEqual(["ready", "failed", "pending"]);
  });

  it("fails the run, not the beat, when MiniMax-H3 keeps refusing a line after two M3 rewrites", async () => {
    installHappyPath(SCRIPT_SEGMENTS);
    mocks.generateH3Clip.mockRejectedValue(new GmiContentFilterError(record("h3-refused") as any, "sensitive content: celebrity likeness"));
    mocks.generateText.mockResolvedValue("A rewritten line that is still refused.");

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(false);
    expect(result.error).toBe("MiniMax-H3 refused clip 0 on content grounds after 2 rewrites (sensitive content: celebrity likeness). Soften the topic or the template notes and try again.");
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(3);
    expect(mocks.state.show.status).toBe("failed");
    expect(mocks.state.show.error).toBe(result.error);
    expect(mocks.state.clips[0].status).toBe("failed");
  });

  it("fails the run with a clear message when Music 3.0 cannot render even after a retry", async () => {
    installHappyPath(SCRIPT_SEGMENTS);
    mocks.generateMusic.mockRejectedValue(new Error("GMI Cloud minimax-music-3.0 request m-9 failed: engine busy"));

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(false);
    expect(result.completedSteps).toEqual(["research", "script", "voices", "generate-clips"]);
    expect(result.error).toBe("Music 3.0 could not render the theme song (GMI Cloud minimax-music-3.0 request m-9 failed: engine busy). The run was stopped rather than shipping a silent theme; retry the show.");
    expect(mocks.generateMusic).toHaveBeenCalledTimes(2);
    expect(mocks.assembleEpisode).not.toHaveBeenCalled();
    expect(statuses()).toEqual(["researching", "scripting", "voicing", "generating", "scoring", "failed"]);
    // The lyrics M3 wrote are kept for inspection even though the render failed.
    expect(mocks.state.show.themeLyrics).toContain("[Hook]");
  });

  it("fails the run when the writers' room returns no segments", async () => {
    installHappyPath([]);

    const result = await generateShowWorkflow("show-1");

    expect(result.success).toBe(false);
    expect(result.completedSteps).toEqual(["research"]);
    expect(result.error).toMatch(/MiniMax-M3 returned a script with no segments/);
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });
});
