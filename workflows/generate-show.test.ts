import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GmiRequestRecord } from "@/app/lib/gmi/queue";
import { BudgetExceededError } from "@/app/lib/gmi/spend";
import { GmiContentFilterError, GmiRequestFailedError } from "@/app/lib/gmi/video";
import * as schema from "@/db/schema";

import { apportionSegmentsByWords, assignVoices, audioStrategyFrom, clipSecondsForLine, ensureLyricTags, firstLyricLine, needsTtsOverlay, offsetSegments, referenceAudioUsable, resolveShowFormat, timeSegmentsFromDurations, transcriptFromSegments } from "./generate-show";
import type { ProgressEvent, TranscriptSegment, VoicedLine } from "./generate-show";
import { generateClipsStepImpl, reviseSegmentText } from "./generate-show-steps";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks: env, DB, GMI models, tts, media. The network is never mocked; the
// module boundaries are.
// ─────────────────────────────────────────────────────────────────────────────

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
  tmpDir: "",
  tmpCounter: 0,
  generateH3Clip: vi.fn(),
  referencePortraitUrls: vi.fn(),
  synthesizeSpeech: vi.fn(),
  uploadToGmi: vi.fn(),
  generateText: vi.fn(),
  emotionForSegment: vi.fn(),
  voiceForHost: vi.fn(),
  extractFrame: vi.fn(),
  cleanupTempFiles: vi.fn(),
  fitAudioToDuration: vi.fn(),
  replaceAudioTrack: vi.fn(),
}));

vi.mock("@/app/lib/env", () => ({ env: mocks.env }));

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

vi.mock("@/app/lib/gmi/video", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/gmi/video")>();
  return { ...actual, generateH3Clip: mocks.generateH3Clip, referencePortraitUrls: mocks.referencePortraitUrls };
});

vi.mock("@/app/lib/gmi/speech", () => ({ synthesizeSpeech: mocks.synthesizeSpeech }));
vi.mock("@/app/lib/gmi/upload", () => ({ uploadToGmi: mocks.uploadToGmi }));
vi.mock("@/app/lib/gmi/text", () => ({ generateText: mocks.generateText }));
vi.mock("@/app/lib/gmi/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/gmi/queue")>();
  return { ...actual, tmpPath: (prefix: string, ext: string) => path.join(mocks.tmpDir, `${prefix}-${mocks.tmpCounter++}.${ext}`) };
});

vi.mock("@/app/lib/tts", () => ({
  voiceForHost: mocks.voiceForHost,
  emotionForSegment: mocks.emotionForSegment,
  generateTtsPerTurn: vi.fn(),
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

// A small in-memory Drizzle stand-in covering the query surface the workflow uses.
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

const HOSTS = [{ name: "John Olive", personality: "Witty British host", position: "center" }];

function segment(i: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { clipIndex: i, speaker: "John Olive", text, visualPrompt: "", durationSeconds: 10, startTimeSeconds: i * 10, endTimeSeconds: (i + 1) * 10, ...extra };
}

function line(i: number, text: string, extra: Partial<VoicedLine> = {}): VoicedLine {
  const audioPath = path.join(mocks.tmpDir, `line-${i}.mp3`);
  fs.writeFileSync(audioPath, `mp3-${i}`);
  return {
    segmentIndex: i,
    speaker: "John Olive",
    voiceId: "English_magnetic_voiced_man",
    emotion: "auto",
    text,
    audioPath,
    durationSeconds: 8.2,
    referenceAudioUrl: `https://gmi.example/line-${i}.mp3`,
    requestId: `speech-${i}`,
    ...extra,
  };
}

function record(id: string, status = "failed"): GmiRequestRecord {
  return { request_id: id, model: "MiniMax-H3", status };
}

function h3Result(i: number, overrides: Partial<Awaited<ReturnType<typeof mocks.generateH3Clip>>> = {}) {
  const localPath = path.join(mocks.tmpDir, `h3-clip-${i}.mp4`);
  fs.writeFileSync(localPath, `clip-${i}`);
  return {
    localPath,
    videoUrl: localPath,
    remoteUrl: `https://gmi.example/clips/${i}.mp4`,
    thumbnailUrl: `https://gmi.example/clips/${i}.jpg`,
    requestId: `h3-${i}`,
    durationSeconds: 9.4,
    hasAudio: true,
    width: 1366,
    height: 768,
    generationMs: 61_000,
    ...overrides,
  };
}

function progressCollector() {
  const events: ProgressEvent[] = [];
  const stream = new WritableStream<ProgressEvent>({ write: (event) => {
    events.push(event);
  } });
  return { events, stream };
}

function statuses(): string[] {
  return mocks.state.updates.filter(u => u.table === "generatedShows" && u.values.status).map(u => u.values.status);
}

function resetState(showOverrides: Record<string, any> = {}, segments = [segment(0, "Line zero."), segment(1, "Line one."), segment(2, "Line two.")]) {
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
    voiceAssignments: { "John Olive": "English_magnetic_voiced_man" },
    transcriptSegments: segments,
    transcript: null,
    engineNotes: null,
    localRenderPath: null,
    encryptedApiKeys: null,
    error: null,
    ...showOverrides,
  };
  mocks.state.template = {
    id: "template-1",
    name: "John Oliver Like",
    showType: "monologue",
    referenceImageUrl: "/templates/investigative-desk.jpg",
    hosts: HOSTS,
    notes: "HBO style investigative desk",
  };
  mocks.state.clips = [];
  mocks.state.updates = [];
}

beforeEach(() => {
  mocks.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-show-test-"));
  mocks.tmpCounter = 0;
  mocks.env.H3_RESOLUTION = undefined;
  mocks.env.H3_AUDIO_STRATEGY = undefined;
  for (const fn of [
    mocks.generateH3Clip,
    mocks.referencePortraitUrls,
    mocks.synthesizeSpeech,
    mocks.uploadToGmi,
    mocks.generateText,
    mocks.emotionForSegment,
    mocks.voiceForHost,
    mocks.extractFrame,
    mocks.cleanupTempFiles,
    mocks.fitAudioToDuration,
    mocks.replaceAudioTrack,
  ]) {
    fn.mockReset();
  }
  mocks.referencePortraitUrls.mockResolvedValue(["https://gmi.example/portrait.jpg"]);
  mocks.emotionForSegment.mockReturnValue("auto");
  mocks.voiceForHost.mockReturnValue("English_magnetic_voiced_man");
  mocks.uploadToGmi.mockImplementation(async (_bytes: Buffer, type: string) => `https://gmi.example/upload-${mocks.tmpCounter++}.${type}`);
  mocks.synthesizeSpeech.mockImplementation(async ({ text }: { text: string }) => ({
    audio: Buffer.from(`speech:${text}`),
    format: "mp3",
    remoteUrl: "https://gmi.example/speech.mp3",
    requestId: `speech-revised-${mocks.tmpCounter++}`,
    durationMs: 8_200,
  }));
  mocks.fitAudioToDuration.mockImplementation(async (audioPath: string) => `${audioPath}.fitted.wav`);
  mocks.replaceAudioTrack.mockImplementation(async (videoPath: string) => `${videoPath}.dubbed.mp4`);
  mocks.extractFrame.mockImplementation(async (videoPath: string, t: number) => {
    const frame = path.join(mocks.tmpDir, `${path.basename(videoPath)}-at-${t}.png`);
    fs.writeFileSync(frame, "png");
    return frame;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(mocks.tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("generate-show: format routing", () => {
  it("routes by the show's format column, never by duration", () => {
    expect(resolveShowFormat({ format: "audio" })).toBe("audio");
    expect(resolveShowFormat({ format: "video" })).toBe("video");
    // A 300 s show is a video when the column says so; a 20 s show is audio when it says so.
    expect(resolveShowFormat({ format: "video", durationSeconds: 300 } as any)).toBe("video");
    expect(resolveShowFormat({ format: "audio", durationSeconds: 20 } as any)).toBe("audio");
    expect(resolveShowFormat({ format: null })).toBe("video");
    expect(resolveShowFormat(undefined)).toBe("video");
    expect(resolveShowFormat({ format: "podcast" })).toBe("video");
  });

  it("reads the H3 audio strategy with reference as the default", () => {
    expect(audioStrategyFrom(undefined)).toBe("reference");
    expect(audioStrategyFrom("reference")).toBe("reference");
    expect(audioStrategyFrom("native")).toBe("native");
    expect(audioStrategyFrom("overlay")).toBe("overlay");
    expect(audioStrategyFrom("whatever")).toBe("reference");
  });
});

describe("generate-show: clip length and audio policy", () => {
  it("requests ceil(line + 0.75 s) clamped to H3's 4 to 15 s window", () => {
    expect(clipSecondsForLine(8.2)).toBe(9);
    expect(clipSecondsForLine(8.25)).toBe(9);
    expect(clipSecondsForLine(8.3)).toBe(10);
    expect(clipSecondsForLine(1)).toBe(4);
    expect(clipSecondsForLine(0)).toBe(9); // unmeasured: the planned 8 s beat plus tail
    expect(clipSecondsForLine(14.5)).toBe(15);
    expect(clipSecondsForLine(40)).toBe(15);
    expect(clipSecondsForLine(Number.NaN)).toBe(9);
  });

  it("only attaches lines inside H3's 2 to 15 s reference-audio window", () => {
    expect(referenceAudioUsable(1_999)).toBe(false);
    expect(referenceAudioUsable(2_000)).toBe(true);
    expect(referenceAudioUsable(15_000)).toBe(true);
    expect(referenceAudioUsable(15_001)).toBe(false);
    expect(referenceAudioUsable(Number.NaN)).toBe(false);
  });

  it("overlays the Speech 2.8 line for silent clips, the overlay strategy, and reference clips without their line", () => {
    // A silent clip is always overlaid.
    expect(needsTtsOverlay({ strategy: "native", hasAudio: false, referenceAudioAttached: false })).toBe(true);
    expect(needsTtsOverlay({ strategy: "reference", hasAudio: false, referenceAudioAttached: true })).toBe(true);
    // "overlay" always replaces.
    expect(needsTtsOverlay({ strategy: "overlay", hasAudio: true, referenceAudioAttached: false })).toBe(true);
    // "native" keeps H3's own performance.
    expect(needsTtsOverlay({ strategy: "native", hasAudio: true, referenceAudioAttached: false })).toBe(false);
    // "reference" keeps H3's track only when it performed the attached line.
    expect(needsTtsOverlay({ strategy: "reference", hasAudio: true, referenceAudioAttached: true })).toBe(false);
    expect(needsTtsOverlay({ strategy: "reference", hasAudio: true, referenceAudioAttached: false })).toBe(true);
  });
});

describe("generate-show: transcript timing from measured durations", () => {
  const segments = [segment(0, "one two three"), segment(1, "four five"), segment(2, "six")];

  it("lays measured durations end to end from the title-card offset", () => {
    const timed = timeSegmentsFromDurations(segments, [9.4, 11.05, 8], 7);
    expect(timed.map(s => [s.startTimeSeconds, s.endTimeSeconds, s.durationSeconds])).toEqual([
      [7, 16.4, 9.4],
      [16.4, 27.45, 11.05],
      [27.45, 35.45, 8],
    ]);
    // The planned slots are gone; the rest of the segment is untouched.
    expect(timed[0].speaker).toBe("John Olive");
    expect(timed[0].text).toBe("one two three");
  });

  it("refuses a duration list that does not match the segments", () => {
    expect(() => timeSegmentsFromDurations(segments, [1, 2])).toThrow("Cannot time 3 segments from 2 durations");
  });

  it("apportions a measured total by word count when per-turn timings are missing, pinning the last boundary", () => {
    const timed = apportionSegmentsByWords(segments, 60, 8);
    expect(timed[0].startTimeSeconds).toBe(8);
    expect(timed[0].endTimeSeconds).toBe(38); // 3 of 6 words
    expect(timed[1].endTimeSeconds).toBe(58); // 2 of 6 words
    expect(timed[2].endTimeSeconds).toBe(68); // pinned to offset + total
    expect(timed[2].durationSeconds).toBe(10);
  });

  it("shifts already-timed segments by a bumper length and leaves them alone for zero", () => {
    const timed = timeSegmentsFromDurations(segments, [5, 5, 5]);
    const shifted = offsetSegments(timed, 8);
    expect(shifted.map(s => [s.startTimeSeconds, s.endTimeSeconds])).toEqual([[8, 13], [13, 18], [18, 23]]);
    expect(offsetSegments(timed, 0)).toBe(timed);
  });

  it("renders the display transcript with speaker labels", () => {
    expect(transcriptFromSegments(segments)).toBe("[John Olive]: one two three\n\n[John Olive]: four five\n\n[John Olive]: six");
  });
});

describe("generate-show: cast and lyrics helpers", () => {
  it("assigns a voice per host and keeps existing assignments so retries keep the cast", () => {
    const pick = vi.fn((host: { name: string }, i: number) => `voice-${host.name}-${i}`);
    const hosts = [{ name: "Colin Jest" }, { name: "Michael Chey" }];
    expect(assignVoices(null, hosts, pick)).toEqual({ "Colin Jest": "voice-Colin Jest-0", "Michael Chey": "voice-Michael Chey-1" });
    expect(assignVoices({ "Colin Jest": "English_Persuasive_Man", "stale": 42 }, hosts, pick)).toEqual({
      "Colin Jest": "English_Persuasive_Man",
      "Michael Chey": "voice-Michael Chey-1",
    });
  });

  it("wraps untagged lyrics in Music 3.0 structure tags and leaves tagged ones alone", () => {
    expect(ensureLyricTags("Tonight the toasters rise", "[Intro]", "[Hook]")).toBe("[Intro]\nTonight the toasters rise\n[Hook]");
    expect(ensureLyricTags("[Hook]\nAlready tagged", "[Intro]", "[Hook]")).toBe("[Hook]\nAlready tagged");
  });

  it("finds the first sung line of a lyric sheet, skipping tags and quotes", () => {
    expect(firstLyricLine("[Verse]\n\"Three jokes we told tonight\"\nAnd one we did not")).toBe("Three jokes we told tonight");
    expect(firstLyricLine("[Outro]")).toBeNull();
    expect(firstLyricLine(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content revision (MiniMax-M3)
// ─────────────────────────────────────────────────────────────────────────────

describe("generate-show: content revision with MiniMax-M3", () => {
  it("asks M3 for a rewrite, strips quotes, and sanitizes names the model left in", async () => {
    mocks.generateText.mockResolvedValueOnce("\"The anchor at HBO says the toaster lied.\"");
    const revised = await reviseSegmentText("John Oliver says the toaster lied.", ["Likeness: living person"]);
    expect(revised).toBe("The anchor at premium cable says the toaster lied.");
    const call = mocks.generateText.mock.calls[0][0];
    expect(call.prompt).toContain("John Oliver says the toaster lied.");
    expect(call.prompt).toContain("Likeness: living person");
    expect(call.system).toContain("comedy writer");
  });

  it("falls back to deterministic name sanitization when M3 fails", async () => {
    mocks.generateText.mockRejectedValueOnce(new Error("MiniMax-M3 timed out"));
    await expect(reviseSegmentText("Colin Jost on SNL loves toast.", ["names"])).resolves.toBe("Colin on sketch comedy show loves toast.");
  });

  it("raises instead of retrying the same refused line when M3 fails and nothing can be sanitized", async () => {
    mocks.generateText.mockResolvedValueOnce("   ");
    await expect(reviseSegmentText("A perfectly generic line.", ["policy"])).rejects.toThrow(/MiniMax-M3 could not rewrite it/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The clip loop
// ─────────────────────────────────────────────────────────────────────────────

describe("generate-show: MiniMax-H3 clip loop", () => {
  it("renders every clip in reference mode with the portrait and that line's audio, then persists per clip", async () => {
    mocks.generateH3Clip.mockImplementation(async (req: any) => h3Result(mocks.generateH3Clip.mock.calls.length - 1, { durationSeconds: 9 + Number(req.prompt.length % 2) }));
    const { events, stream } = progressCollector();
    const lines = [line(0, "Line zero."), line(1, "Line one.", { durationSeconds: 11.9 }), line(2, "Line two.")];

    await generateClipsStepImpl(stream, "show-1", lines);

    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(3);
    for (const [i, call] of mocks.generateH3Clip.mock.calls.entries()) {
      const req = call[0];
      expect(req.referenceImageUrls).toEqual(["https://gmi.example/portrait.jpg"]);
      expect(req.referenceAudioUrls).toEqual([`https://gmi.example/line-${i}.mp3`]);
      expect(req.firstFrameUrl).toBeUndefined();
      expect(req.lastFrameUrl).toBeUndefined();
      expect(req.resolution).toBe("768P");
      expect(req.ratio).toBe("16:9");
      expect(req.showId).toBe("show-1");
      expect(req.prompt).toContain(`"Line ${["zero", "one", "two"][i]}."`);
      expect(req.prompt).toContain("attached spoken line");
      expect(req.prompt).toContain("consistent with the reference image");
      expect(req.prompt).not.toContain("HBO");
    }
    expect(mocks.generateH3Clip.mock.calls.map(c => c[0].durationSeconds)).toEqual([9, 13, 9]);

    const clips = mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex);
    expect(clips).toHaveLength(3);
    for (const [i, clip] of clips.entries()) {
      expect(clip.status).toBe("ready");
      expect(clip.gmiRequestId).toBe(`h3-${i}`);
      expect(clip.thumbnailUrl).toBe(`https://gmi.example/clips/${i}.jpg`);
      expect(clip.audioSource).toBe("h3");
      expect(clip.measuredDurationSeconds).toBeGreaterThan(8);
      expect(clip.videoUrl).toMatch(/h3-clip-\d\.mp4$/);
      expect(fs.existsSync(clip.videoUrl)).toBe(true);
    }
    expect(mocks.replaceAudioTrack).not.toHaveBeenCalled();
    expect(mocks.extractFrame).not.toHaveBeenCalled();

    expect(statuses()).toEqual(["generating"]);
    expect(events).toEqual([
      { type: "current", step: "generate-clips" },
      { type: "completed", step: "generate-clips" },
    ]);
    const notes = mocks.state.show.engineNotes;
    expect(notes.audioStrategy).toBe("reference");
    expect(notes.resolution).toBe("768P");
    expect(notes.frameChaining).toBe(false);
    expect(notes.referencePortrait).toBe(true);
    expect(notes.clips.map((c: any) => [c.clipIndex, c.mode, c.audioSource, c.generationMs, c.requestedSeconds])).toEqual([
      [0, "reference", "h3", 61_000, 9],
      [1, "reference", "h3", 61_000, 13],
      [2, "reference", "h3", 61_000, 9],
    ]);
  });

  it("sends no reference audio under the native strategy and keeps H3's own track", async () => {
    mocks.env.H3_AUDIO_STRATEGY = "native";
    mocks.env.H3_RESOLUTION = "2K";
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1));
    const { stream } = progressCollector();
    const lines = [line(0, "Line zero.", { referenceAudioUrl: null }), line(1, "Line one.", { referenceAudioUrl: null }), line(2, "Line two.", { referenceAudioUrl: null })];

    await generateClipsStepImpl(stream, "show-1", lines);

    for (const call of mocks.generateH3Clip.mock.calls) {
      expect(call[0].referenceAudioUrls).toBeUndefined();
      expect(call[0].referenceImageUrls).toEqual(["https://gmi.example/portrait.jpg"]);
      expect(call[0].resolution).toBe("2K");
      expect(call[0].prompt).not.toContain("attached spoken line");
    }
    expect(mocks.replaceAudioTrack).not.toHaveBeenCalled();
    expect(mocks.state.clips.every(c => c.audioSource === "h3")).toBe(true);
    expect(mocks.state.show.engineNotes.audioStrategy).toBe("native");
  });

  it("replaces every clip's audio with the fitted Speech 2.8 line under the overlay strategy", async () => {
    mocks.env.H3_AUDIO_STRATEGY = "overlay";
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1, { durationSeconds: 9.6 }));
    const { stream } = progressCollector();
    const lines = [line(0, "Line zero.", { referenceAudioUrl: null }), line(1, "Line one.", { referenceAudioUrl: null }), line(2, "Line two.", { referenceAudioUrl: null })];

    await generateClipsStepImpl(stream, "show-1", lines);

    expect(mocks.fitAudioToDuration).toHaveBeenCalledTimes(3);
    expect(mocks.fitAudioToDuration.mock.calls[1]).toEqual([lines[1].audioPath, 9.6]);
    expect(mocks.replaceAudioTrack).toHaveBeenCalledTimes(3);
    expect(mocks.replaceAudioTrack.mock.calls[1][1]).toBe(`${lines[1].audioPath}.fitted.wav`);
    const clips = mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex);
    expect(clips.every(c => c.audioSource === "tts-overlay")).toBe(true);
    expect(clips[1].videoUrl).toMatch(/h3-clip-1\.mp4\.dubbed\.mp4$/);
    // The undubbed H3 file and the fitted line are intermediate and get cleaned.
    const cleaned = mocks.cleanupTempFiles.mock.calls.flat(2);
    expect(cleaned).toContain(`${lines[1].audioPath}.fitted.wav`);
    expect(cleaned.some((p: string) => /h3-clip-1\.mp4$/.test(p))).toBe(true);
  });

  it("falls back to the overlay for a clip that came back silent, even under the reference strategy", async () => {
    mocks.generateH3Clip
      .mockImplementationOnce(async () => h3Result(0))
      .mockImplementationOnce(async () => h3Result(1, { hasAudio: false, durationSeconds: 10.2 }))
      .mockImplementationOnce(async () => h3Result(2));
    const { stream } = progressCollector();
    const lines = [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")];

    await generateClipsStepImpl(stream, "show-1", lines);

    expect(mocks.replaceAudioTrack).toHaveBeenCalledTimes(1);
    expect(mocks.fitAudioToDuration).toHaveBeenCalledWith(lines[1].audioPath, 10.2);
    const clips = mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex);
    expect(clips.map(c => c.audioSource)).toEqual(["h3", "tts-overlay", "h3"]);
    expect(clips[1].videoUrl).toMatch(/dubbed\.mp4$/);
    expect(mocks.state.show.engineNotes.clips[1]).toMatchObject({ clipIndex: 1, audioSource: "tts-overlay", hadAudio: false });
  });

  it("overlays a line H3 could not take as reference audio (outside 2 to 15 s) so the cast stays consistent", async () => {
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1));
    const { stream } = progressCollector();
    const lines = [line(0, "Line zero."), line(1, "Hi.", { durationSeconds: 1.2, referenceAudioUrl: null }), line(2, "Line two.")];

    await generateClipsStepImpl(stream, "show-1", lines);

    expect(mocks.generateH3Clip.mock.calls[1][0].referenceAudioUrls).toBeUndefined();
    expect(mocks.generateH3Clip.mock.calls[1][0].durationSeconds).toBe(4);
    expect(mocks.replaceAudioTrack).toHaveBeenCalledTimes(1);
    expect(mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex).map(c => c.audioSource)).toEqual(["h3", "tts-overlay", "h3"]);
  });

  it("never mixes frame inputs with references: chained clips start on the previous tail frame and carry no portrait or audio", async () => {
    resetState({ useFrameChaining: true });
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1, { durationSeconds: 9.4 }));
    const { events, stream } = progressCollector();
    const lines = [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")];

    await generateClipsStepImpl(stream, "show-1", lines);

    const calls = mocks.generateH3Clip.mock.calls.map(c => c[0]);
    // Clip 0: reference mode (portrait + line audio), no frame.
    expect(calls[0].referenceImageUrls).toEqual(["https://gmi.example/portrait.jpg"]);
    expect(calls[0].referenceAudioUrls).toEqual(["https://gmi.example/line-0.mp3"]);
    expect(calls[0].firstFrameUrl).toBeUndefined();
    // Clips 1 and 2: frame mode only.
    for (const req of calls.slice(1)) {
      expect(req.firstFrameUrl).toMatch(/^https:\/\/gmi\.example\/upload-\d+\.png$/);
      expect(req.referenceImageUrls).toBeUndefined();
      expect(req.referenceAudioUrls).toBeUndefined();
      expect(req.prompt).not.toContain("attached spoken line");
      expect(req.prompt).not.toContain("reference image");
    }
    // Every request satisfies H3's rule on its own.
    for (const req of calls) {
      const usesReferences = Boolean(req.referenceImageUrls?.length || req.referenceAudioUrls?.length);
      const usesFrames = Boolean(req.firstFrameUrl || req.lastFrameUrl);
      expect(usesReferences && usesFrames).toBe(false);
    }
    // Tail frames come from the clip that precedes them, near its end, and are uploaded as PNGs.
    expect(mocks.extractFrame).toHaveBeenCalledTimes(2);
    expect(mocks.extractFrame.mock.calls[0][0]).toMatch(/h3-clip-0\.mp4$/);
    expect(mocks.extractFrame.mock.calls[0][1]).toBeCloseTo(9.15, 5);
    expect(mocks.uploadToGmi).toHaveBeenCalledTimes(2);
    expect(mocks.uploadToGmi.mock.calls.every(c => c[1] === "png")).toBe(true);
    expect(calls[1].firstFrameUrl).not.toBe(calls[2].firstFrameUrl);
    // Chained clips have no line audio attached, so they get the overlay; clip 0 keeps H3's performance.
    expect(mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex).map(c => c.audioSource)).toEqual(["h3", "tts-overlay", "tts-overlay"]);
    expect(mocks.state.show.engineNotes.clips.map((c: any) => c.mode)).toEqual(["reference", "frame", "frame"]);
    expect(mocks.state.show.engineNotes.frameChaining).toBe(true);
    // The anchor clip is the frame-chain step; the rest is generate-clips.
    expect(events).toEqual([
      { type: "current", step: "frame-chain" },
      { type: "completed", step: "frame-chain" },
      { type: "current", step: "generate-clips" },
      { type: "completed", step: "generate-clips" },
    ]);
  });

  it("renders from the prompt alone when the template has no portrait and the line carries no audio", async () => {
    mocks.referencePortraitUrls.mockResolvedValue([]);
    mocks.env.H3_AUDIO_STRATEGY = "native";
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1));
    const { stream } = progressCollector();
    await generateClipsStepImpl(stream, "show-1", [line(0, "Line zero.", { referenceAudioUrl: null }), line(1, "Line one.", { referenceAudioUrl: null }), line(2, "Line two.", { referenceAudioUrl: null })]);
    for (const call of mocks.generateH3Clip.mock.calls) {
      expect(call[0].referenceImageUrls).toBeUndefined();
      expect(call[0].referenceAudioUrls).toBeUndefined();
      expect(call[0].firstFrameUrl).toBeUndefined();
    }
    expect(mocks.state.show.engineNotes.clips.every((c: any) => c.mode === "prompt")).toBe(true);
    expect(mocks.state.show.engineNotes.referencePortrait).toBe(false);
  });

  it("revises a refused line with M3, re-voices it, and retries at most twice per clip", async () => {
    mocks.generateH3Clip
      .mockImplementationOnce(async () => h3Result(0))
      .mockRejectedValueOnce(new GmiContentFilterError(record("h3-bad-1"), "sensitive content: public figure"))
      .mockRejectedValueOnce(new GmiContentFilterError(record("h3-bad-2"), "policy violation"))
      .mockImplementationOnce(async () => h3Result(1))
      .mockImplementationOnce(async () => h3Result(2));
    mocks.generateText
      .mockResolvedValueOnce("A famous anchor once said toast is a lie.")
      .mockResolvedValueOnce("An anchor once said toast is a lie.");
    const { stream } = progressCollector();
    const lines = [line(0, "Line zero."), line(1, "John Oliver said toast is a lie."), line(2, "Line two.")];

    await generateClipsStepImpl(stream, "show-1", lines);

    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(5);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateText.mock.calls[0][0].prompt).toContain("sensitive content: public figure");
    expect(mocks.generateText.mock.calls[1][0].prompt).toContain("policy violation");
    expect(mocks.generateText.mock.calls[1][0].prompt).toContain("A famous anchor once said toast is a lie.");
    // The rewritten line was re-synthesized and re-uploaded so the attached audio matches the prompt.
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(mocks.synthesizeSpeech.mock.calls[1][0].text).toBe("An anchor once said toast is a lie.");
    const finalCall = mocks.generateH3Clip.mock.calls[3][0];
    expect(finalCall.prompt).toContain("An anchor once said toast is a lie.");
    expect(finalCall.referenceAudioUrls).toHaveLength(1);
    expect(finalCall.referenceAudioUrls[0]).toMatch(/^https:\/\/gmi\.example\/upload-\d+\.mp3$/);
    expect(finalCall.referenceAudioUrls[0]).not.toBe(lines[1].referenceAudioUrl);
    // The transcript now carries the revised line.
    expect(mocks.state.show.transcriptSegments[1].text).toBe("An anchor once said toast is a lie.");
    expect(mocks.state.show.transcript).toContain("[John Olive]: An anchor once said toast is a lie.");
    expect(mocks.state.show.engineNotes.clips[1].revisions).toBe(2);
    expect(mocks.state.clips.find(c => c.clipIndex === 1)!.status).toBe("ready");
  });

  it("fails the run with the refusal reasons when a clip is still refused after two rewrites", async () => {
    mocks.generateH3Clip
      .mockImplementationOnce(async () => h3Result(0))
      .mockRejectedValue(new GmiContentFilterError(record("h3-bad"), "public figure likeness"));
    mocks.generateText.mockResolvedValue("A rewritten but still refused line.");
    const { stream } = progressCollector();

    await expect(generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")]))
      .rejects
      .toThrow(/MiniMax-H3 refused clip 1 on content grounds after 2 rewrites \(public figure likeness\)/);

    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(4); // clip 0 + three attempts on clip 1
    const clip1 = mocks.state.clips.find(c => c.clipIndex === 1)!;
    expect(clip1.status).toBe("failed");
    expect(clip1.error).toMatch(/refused clip 1/);
    expect(mocks.state.clips.find(c => c.clipIndex === 2)!.status).toBe("pending");
  });

  it("aborts the run with the budget message the moment a cap is hit", async () => {
    mocks.generateH3Clip
      .mockImplementationOnce(async () => h3Result(0))
      .mockRejectedValueOnce(new BudgetExceededError("MiniMax-H3 session cap reached: $8.00 of $8.00 spent across 61 requests. Raise H3_SESSION_CAP_USD after topping up GMI Cloud, or generate an audio episode instead."));
    const { stream } = progressCollector();

    await expect(generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")]))
      .rejects
      .toThrow("MiniMax-H3 session cap reached: $8.00 of $8.00 spent across 61 requests. Raise H3_SESSION_CAP_USD after topping up GMI Cloud, or generate an audio episode instead.");

    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(2);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const clips = mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex);
    expect(clips.map(c => c.status)).toEqual(["ready", "failed", "pending"]);
    expect(clips[1].error).toMatch(/session cap reached/);
  });

  it("retries a GMI-side failure once, then fails the run with an actionable message instead of skipping the beat", async () => {
    mocks.generateH3Clip
      .mockRejectedValueOnce(new GmiRequestFailedError(record("h3-x"), "internal engine error"))
      .mockImplementationOnce(async () => h3Result(0))
      .mockRejectedValueOnce(new GmiRequestFailedError(record("h3-y"), "internal engine error"))
      .mockRejectedValueOnce(new GmiRequestFailedError(record("h3-z"), "internal engine error"));
    const { stream } = progressCollector();

    await expect(generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")]))
      .rejects
      .toThrow(/Clip 1 failed: GMI Cloud MiniMax-H3 request h3-z failed: internal engine error\. The episode was not assembled because a missing beat would leave a hole in the show/);

    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(4);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.state.clips.sort((a, b) => a.clipIndex - b.clipIndex).map(c => c.status)).toEqual(["ready", "failed", "pending"]);
  });

  it("does not retry local failures such as an ffmpeg error and names the clip", async () => {
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1, { hasAudio: false }));
    mocks.fitAudioToDuration.mockRejectedValueOnce(new Error("ffmpeg exited with code 1"));
    const { stream } = progressCollector();

    await expect(generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")]))
      .rejects
      .toThrow(/Clip 0 failed: ffmpeg exited with code 1/);
    expect(mocks.generateH3Clip).toHaveBeenCalledTimes(1);
  });

  it("refuses to render when the voices step left a segment without a line", async () => {
    const { stream } = progressCollector();
    await expect(generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(2, "Line two.")]))
      .rejects
      .toThrow("The voices step produced 2 lines for 3 segments (missing: 1); refusing to render a show with missing beats.");
    expect(mocks.generateH3Clip).not.toHaveBeenCalled();
  });

  it("rebuilds the clip rows on a retried step instead of doubling them", async () => {
    mocks.state.clips.push({ id: "stale-0", showId: "show-1", clipIndex: 0, status: "failed", prompt: "old" }, { id: "other-show", showId: "show-2", clipIndex: 0, status: "ready", prompt: "keep" });
    mocks.generateH3Clip.mockImplementation(async () => h3Result(mocks.generateH3Clip.mock.calls.length - 1));
    const { stream } = progressCollector();

    await generateClipsStepImpl(stream, "show-1", [line(0, "Line zero."), line(1, "Line one."), line(2, "Line two.")]);

    const mine = mocks.state.clips.filter(c => c.showId === "show-1");
    expect(mine).toHaveLength(3);
    expect(mine.every(c => c.status === "ready")).toBe(true);
    expect(mocks.state.clips.find(c => c.id === "other-show")).toBeDefined();
  });
});
