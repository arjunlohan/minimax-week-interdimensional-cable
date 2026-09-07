import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";

import type { MusicStepResult, ProgressEvent, TranscriptSegment } from "./generate-show";
import { checkShowFormatStepImpl, musicStepImpl, stitchStepImpl, voicesStepImpl } from "./generate-show-steps";

/**
 * Media interface integration: how the workflow drives Speech 2.8 HD, Music
 * 3.0 and the ffmpeg assembly, and how the transcript is retimed from what
 * those actually produced. Every model and the DB are mocked at the module
 * boundary; nothing here touches the network.
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
  tmpDir: "",
  tmpCounter: 0,
  synthesizeSpeech: vi.fn(),
  uploadToGmi: vi.fn(),
  generateJson: vi.fn(),
  generateText: vi.fn(),
  generateMusic: vi.fn(),
  emotionForSegment: vi.fn(),
  voiceForHost: vi.fn(),
  generateTtsPerTurn: vi.fn(),
  cleanupTempFiles: vi.fn(),
  assembleEpisode: vi.fn(),
  assembleAudioEpisode: vi.fn(),
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
  return { ...actual, cleanupTempFiles: mocks.cleanupTempFiles, extractFrame: vi.fn() };
});

vi.mock("@/app/lib/assemble", () => ({
  assembleEpisode: mocks.assembleEpisode,
  assembleAudioEpisode: mocks.assembleAudioEpisode,
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

function seg(i: number, speaker: string, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { clipIndex: i, speaker, text, visualPrompt: "", durationSeconds: 10, startTimeSeconds: i * 10, endTimeSeconds: (i + 1) * 10, ...extra };
}

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
    transcriptSegments: [seg(0, "John Olive", "Tonight, toasters."), seg(1, "John Olive", "They have opinions.", { actingDirection: "outraged" }), seg(2, "John Olive", "Good night.")],
    transcript: null,
    themeLyrics: null,
    creditsLyrics: null,
    musicPrompt: null,
    engineNotes: { script: { title: "The Toaster That Learned to Lie" } },
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
    hosts: DESK_HOSTS,
    notes: "HBO style investigative desk",
    ...templateOverrides,
  };
  mocks.state.clips = [];
  mocks.state.updates = [];
}

function musicResult(overrides: Partial<MusicStepResult> = {}): MusicStepResult {
  const themePath = path.join(mocks.tmpDir, "theme.mp3");
  const creditsPath = path.join(mocks.tmpDir, "credits.mp3");
  fs.writeFileSync(themePath, "theme");
  fs.writeFileSync(creditsPath, "credits");
  return {
    themePath,
    creditsPath,
    themeDurationMs: 31_000,
    creditsDurationMs: 44_000,
    themeLyrics: "[Intro]\nJohn Oliver Like, live tonight\n[Hook]\nToasters in the spotlight",
    creditsLyrics: "[Verse]\n\"Three jokes we told tonight\"\nThe toaster learned to lie\n[Outro]\nGood night",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-challenger-test-"));
  mocks.tmpCounter = 0;
  mocks.env.H3_AUDIO_STRATEGY = undefined;
  for (const fn of [
    mocks.synthesizeSpeech,
    mocks.uploadToGmi,
    mocks.generateJson,
    mocks.generateText,
    mocks.generateMusic,
    mocks.emotionForSegment,
    mocks.voiceForHost,
    mocks.generateTtsPerTurn,
    mocks.cleanupTempFiles,
    mocks.assembleEpisode,
    mocks.assembleAudioEpisode,
  ]) {
    fn.mockReset();
  }
  mocks.emotionForSegment.mockImplementation((direction?: string) => (direction === "outraged" ? "angry" : "auto"));
  mocks.voiceForHost.mockImplementation((host: { name: string }, i: number) => (host.name === "Duncan Trussed" ? "English_Graceful_Lady" : ["English_magnetic_voiced_man", "English_Aussie_Bloke"][i] ?? "English_expressive_narrator"));
  mocks.uploadToGmi.mockImplementation(async (_bytes: Buffer, type: string) => `https://gmi.example/upload-${mocks.tmpCounter++}.${type}`);
  mocks.synthesizeSpeech.mockImplementation(async ({ text }: { text: string }) => ({
    audio: Buffer.from(`speech:${text}`),
    format: "mp3",
    remoteUrl: "https://gmi.example/speech.mp3",
    requestId: `speech-${mocks.tmpCounter++}`,
    durationMs: 1000 * (2 + text.length / 4),
  }));
  mocks.generateMusic.mockImplementation(async ({ lyrics }: { lyrics: string }) => {
    const localPath = path.join(mocks.tmpDir, `music-${mocks.tmpCounter++}.mp3`);
    fs.writeFileSync(localPath, lyrics);
    return { localPath, audio: Buffer.from(lyrics), remoteUrl: "https://gmi.example/music.mp3", requestId: `music-${mocks.tmpCounter}`, durationMs: 30_000, format: "mp3" };
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
// Format routing
// ─────────────────────────────────────────────────────────────────────────────

describe("challenger M2: format routing by column", () => {
  it("plans a video run from the format column, carrying the frame-chaining flag", async () => {
    resetState({ format: "video", durationSeconds: 120, useFrameChaining: true });
    await expect(checkShowFormatStepImpl("show-1")).resolves.toEqual({ format: "video", useFrameChaining: true, durationSeconds: 120 });
  });

  it("plans an audio run from the format column even for a short show", async () => {
    resetState({ format: "audio", durationSeconds: 30 });
    await expect(checkShowFormatStepImpl("show-1")).resolves.toEqual({ format: "audio", useFrameChaining: false, durationSeconds: 30 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Voices step
// ─────────────────────────────────────────────────────────────────────────────

describe("challenger M2: voices step on Speech 2.8 HD", () => {
  it("video: assigns a voice per host, voices each line with its emotion, keeps the mp3 and uploads it as reference audio", async () => {
    const { events, stream } = progressCollector();

    const result = await voicesStepImpl(stream, "show-1");

    expect(result.format).toBe("video");
    expect(result.lines).toHaveLength(3);
    expect(mocks.state.show.voiceAssignments).toEqual({ "John Olive": "English_magnetic_voiced_man" });
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(mocks.synthesizeSpeech.mock.calls[0][0]).toEqual({ text: "Tonight, toasters.", voiceId: "English_magnetic_voiced_man", emotion: "auto" });
    expect(mocks.synthesizeSpeech.mock.calls[1][0]).toEqual({ text: "They have opinions.", voiceId: "English_magnetic_voiced_man", emotion: "angry" });
    expect(mocks.emotionForSegment).toHaveBeenCalledWith("outraged", undefined);

    for (const [i, line] of result.lines!.entries()) {
      expect(line.segmentIndex).toBe(i);
      expect(fs.readFileSync(line.audioPath, "utf8")).toBe(`speech:${mocks.state.show.transcriptSegments[i].text}`);
      expect(line.audioPath.endsWith(".mp3")).toBe(true);
      expect(line.durationSeconds).toBeGreaterThan(2);
      expect(line.referenceAudioUrl).toMatch(/^https:\/\/gmi\.example\/upload-\d+\.mp3$/);
    }
    expect(mocks.uploadToGmi).toHaveBeenCalledTimes(3);
    expect(mocks.uploadToGmi.mock.calls[0][0]).toEqual(Buffer.from("speech:Tonight, toasters."));
    expect(mocks.uploadToGmi.mock.calls[0][1]).toBe("mp3");

    expect(statuses()).toEqual(["voicing"]);
    expect(events).toEqual([{ type: "current", step: "voices" }, { type: "completed", step: "voices" }]);
    expect(mocks.state.show.engineNotes.audioStrategy).toBe("reference");
    expect(mocks.state.show.engineNotes.voices.assignments).toEqual({ "John Olive": "English_magnetic_voiced_man" });
    expect(mocks.state.show.engineNotes.voices.lines[1]).toMatchObject({ segmentIndex: 1, emotion: "angry", referenceAudio: true });
    // The script step's notes survive the merge.
    expect(mocks.state.show.engineNotes.script.title).toBe("The Toaster That Learned to Lie");
  });

  it("video: uploads nothing under the native and overlay strategies", async () => {
    for (const strategy of ["native", "overlay"]) {
      resetState();
      mocks.uploadToGmi.mockClear();
      mocks.env.H3_AUDIO_STRATEGY = strategy;
      const result = await voicesStepImpl(progressCollector().stream, "show-1");
      expect(mocks.uploadToGmi).not.toHaveBeenCalled();
      expect(result.lines!.every(l => l.referenceAudioUrl === null)).toBe(true);
      expect(mocks.state.show.engineNotes.audioStrategy).toBe(strategy);
    }
  });

  it("video: skips the upload for a line outside H3's 2 to 15 s window", async () => {
    resetState({ transcriptSegments: [seg(0, "John Olive", "Hi."), seg(1, "John Olive", "A line that keeps going and going and going and going and going and going for far too long.")] });
    mocks.synthesizeSpeech
      .mockResolvedValueOnce({ audio: Buffer.from("short"), format: "mp3", remoteUrl: "", requestId: "s-0", durationMs: 900 })
      .mockResolvedValueOnce({ audio: Buffer.from("long"), format: "mp3", remoteUrl: "", requestId: "s-1", durationMs: 16_500 });

    const result = await voicesStepImpl(progressCollector().stream, "show-1");

    expect(mocks.uploadToGmi).not.toHaveBeenCalled();
    expect(result.lines!.map(l => l.referenceAudioUrl)).toEqual([null, null]);
    expect(result.lines!.map(l => l.durationSeconds)).toEqual([0.9, 16.5]);
  });

  it("reuses existing voice assignments so a retry keeps the cast, and fills in new hosts", async () => {
    resetState({ voiceAssignments: { "Joe Brogan": "English_Persuasive_Man" } }, { hosts: PANEL_HOSTS, showType: "conversation" });
    mocks.state.show.transcriptSegments = [seg(0, "Joe Brogan", "So, toasters."), seg(1, "Duncan Trussed", "Cosmic bread.")];

    const result = await voicesStepImpl(progressCollector().stream, "show-1");

    expect(mocks.state.show.voiceAssignments).toEqual({ "Joe Brogan": "English_Persuasive_Man", "Duncan Trussed": "English_Graceful_Lady" });
    expect(mocks.voiceForHost).toHaveBeenCalledTimes(1);
    expect(mocks.voiceForHost).toHaveBeenCalledWith(PANEL_HOSTS[1], 1);
    expect(result.lines!.map(l => l.voiceId)).toEqual(["English_Persuasive_Man", "English_Graceful_Lady"]);
  });

  it("refuses to voice an empty script", async () => {
    resetState({ transcriptSegments: [] });
    await expect(voicesStepImpl(progressCollector().stream, "show-1")).rejects.toThrow("The script has no segments to voice");
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("audio: voices the whole episode per turn with the assigned cast and retimes the transcript from measured durations", async () => {
    resetState({ format: "audio", language: "en", transcriptSegments: [
      seg(0, "Joe Brogan", "So, toasters.", { acousticTags: ["[laughs]"] }),
      seg(1, "Duncan Trussed", "Cosmic bread.", { actingDirection: "whispering" }),
      seg(2, "Joe Brogan", "Exactly."),
    ] }, { hosts: PANEL_HOSTS, showType: "conversation", name: "Joe Rogan Like" });
    mocks.generateTtsPerTurn.mockResolvedValue({ wav: wavOf(17.5), durations: [6.25, 8.5, 2.75] });
    const { events, stream } = progressCollector();

    const result = await voicesStepImpl(stream, "show-1");

    expect(result).toEqual({ format: "audio" });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
    expect(mocks.generateTtsPerTurn).toHaveBeenCalledTimes(1);
    const [turns, hosts, lang] = mocks.generateTtsPerTurn.mock.calls[0];
    expect(turns).toEqual([
      { speaker: "Joe Brogan", text: "So, toasters.", actingDirection: undefined, acousticTags: ["[laughs]"] },
      { speaker: "Duncan Trussed", text: "Cosmic bread.", actingDirection: "whispering", acousticTags: undefined },
      { speaker: "Joe Brogan", text: "Exactly.", actingDirection: undefined, acousticTags: undefined },
    ]);
    // The fixed cast rides along as each host's ttsVoice.
    expect(hosts.map((h: any) => h.ttsVoice)).toEqual(["English_magnetic_voiced_man", "English_Graceful_Lady"]);
    expect(lang).toBe("en");

    const wavPath = mocks.state.show.localRenderPath;
    expect(wavPath).toMatch(/episode-show-1-\d+\.wav$/);
    expect(fs.statSync(wavPath).size).toBe(44 + 17.5 * 48000);
    expect(mocks.state.show.transcriptSegments.map((s: TranscriptSegment) => [s.startTimeSeconds, s.endTimeSeconds, s.durationSeconds])).toEqual([
      [0, 6.25, 6.25],
      [6.25, 14.75, 8.5],
      [14.75, 17.5, 2.75],
    ]);
    expect(statuses()).toEqual(["voicing"]);
    expect(events).toEqual([{ type: "current", step: "voices" }, { type: "completed", step: "voices" }]);
    expect(mocks.state.show.engineNotes.voices.lines).toHaveLength(3);
  });

  it("audio: apportions by word count when the per-turn durations do not line up, pinned to the real length", async () => {
    resetState({ format: "audio" });
    mocks.generateTtsPerTurn.mockResolvedValue({ wav: wavOf(30), durations: [30] });

    await voicesStepImpl(progressCollector().stream, "show-1");

    const timed = mocks.state.show.transcriptSegments as TranscriptSegment[];
    expect(timed[0].startTimeSeconds).toBe(0);
    expect(timed.at(-1)!.endTimeSeconds).toBe(30);
    expect(timed.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0)).toBeCloseTo(30, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Music step
// ─────────────────────────────────────────────────────────────────────────────

describe("challenger M2: music step on Music 3.0 with MiniMax-M3 lyrics", () => {
  const plan = {
    theme: { lyrics: "[Intro]\nJohn Oliver Like, live tonight\n[Hook]\nToasters in the spotlight", style: "Late-night big band, brassy horns, 140 bpm" },
    credits: { lyrics: "[Verse]\nThree jokes we told tonight\nThe toaster learned to lie\n[Outro]\nGood night", style: "Swing outro, muted trumpet, crooner" },
  };

  it("asks M3 for a theme hook and a credits recap in the show's voice, renders both, and persists the lyrics", async () => {
    mocks.generateJson.mockResolvedValue(plan);
    const { events, stream } = progressCollector();

    const result = await musicStepImpl(stream, "show-1");

    expect(mocks.generateJson).toHaveBeenCalledTimes(1);
    const ask = mocks.generateJson.mock.calls[0][0];
    expect(ask.label).toBe("music-plan");
    expect(ask.prompt).toContain("John Oliver Like");
    expect(ask.prompt).toContain("desk show");
    expect(ask.prompt).toContain("late-night big band");
    expect(ask.prompt).toContain("The Toaster That Learned to Lie");
    expect(ask.prompt).toContain("John Olive: Tonight, toasters.");
    expect(ask.prompt).toContain("[Intro] and [Hook]");
    expect(ask.prompt).toContain("[Verse] and [Outro]");
    expect(ask.prompt).toContain("three best jokes");
    expect(() => ask.schema.parse(plan)).not.toThrow();
    expect(() => ask.schema.parse({ theme: { lyrics: "", style: "x" }, credits: plan.credits })).toThrow();

    expect(mocks.generateMusic).toHaveBeenCalledTimes(2);
    expect(mocks.generateMusic.mock.calls[0][0]).toEqual({ lyrics: plan.theme.lyrics, prompt: plan.theme.style });
    expect(mocks.generateMusic.mock.calls[1][0]).toEqual({ lyrics: plan.credits.lyrics, prompt: plan.credits.style });

    expect(mocks.state.show.themeLyrics).toBe(plan.theme.lyrics);
    expect(mocks.state.show.creditsLyrics).toBe(plan.credits.lyrics);
    expect(mocks.state.show.musicPrompt).toBe("Theme: Late-night big band, brassy horns, 140 bpm\n\nCredits: Swing outro, muted trumpet, crooner");

    expect(result.themePath).toMatch(/music-\d+\.mp3$/);
    expect(result.creditsPath).toMatch(/music-\d+\.mp3$/);
    expect(result.themePath).not.toBe(result.creditsPath);
    expect(result.themeDurationMs).toBe(30_000);
    expect(result.themeLyrics).toBe(plan.theme.lyrics);
    expect(result.creditsLyrics).toBe(plan.credits.lyrics);

    expect(statuses()).toEqual(["scoring"]);
    expect(events).toEqual([{ type: "current", step: "music" }, { type: "completed", step: "music" }]);
    expect(mocks.state.show.engineNotes.music.theme.prompt).toBe(plan.theme.style);
    expect(mocks.state.show.engineNotes.music.credits.durationMs).toBe(30_000);
  });

  it("steers podcasts toward lo-fi or acoustic and wraps untagged lyrics in structure tags", async () => {
    resetState({}, { name: "Joe Rogan Like", showType: "conversation", hosts: PANEL_HOSTS, notes: "Long-form wonder podcast" });
    mocks.generateJson.mockResolvedValue({
      theme: { lyrics: "Joe Rogan Like, tune in", style: "Lo-fi beat" },
      credits: { lyrics: "We wondered about bread\nand then we went to bed", style: "Acoustic guitar" },
    });

    await musicStepImpl(progressCollector().stream, "show-1");

    const ask = mocks.generateJson.mock.calls[0][0];
    expect(ask.prompt).toContain("podcast");
    expect(ask.prompt).toContain("lo-fi or acoustic");
    expect(ask.prompt).toContain("SHOW NOTES: Long-form wonder podcast");
    expect(mocks.state.show.themeLyrics).toBe("[Intro]\nJoe Rogan Like, tune in\n[Hook]");
    expect(mocks.state.show.creditsLyrics).toBe("[Verse]\nWe wondered about bread\nand then we went to bed\n[Outro]");
    expect(mocks.generateMusic.mock.calls[0][0].lyrics).toBe("[Intro]\nJoe Rogan Like, tune in\n[Hook]");
  });

  it("retries a failed render once, then fails the run with a clear message rather than skipping the music", async () => {
    mocks.generateJson.mockResolvedValue(plan);
    const good = mocks.generateMusic.getMockImplementation()!;
    mocks.generateMusic
      .mockRejectedValueOnce(new Error("GMI Cloud minimax-music-3.0 request m-1 failed: engine busy"))
      .mockImplementationOnce(good)
      .mockRejectedValueOnce(new Error("engine busy"))
      .mockRejectedValueOnce(new Error("engine busy"));

    await expect(musicStepImpl(progressCollector().stream, "show-1")).rejects.toThrow(
      "Music 3.0 could not render the credits song (engine busy). The run was stopped rather than shipping a silent credits; retry the show.",
    );
    expect(mocks.generateMusic).toHaveBeenCalledTimes(4);
    // The lyrics were persisted before rendering, so the failure is inspectable.
    expect(mocks.state.show.themeLyrics).toBe(plan.theme.lyrics);
  });

  it("fails the run when MiniMax-M3 cannot produce lyrics", async () => {
    mocks.generateJson.mockRejectedValue(new Error("music-plan: MiniMax-M3 did not return valid JSON after 2 attempts"));
    await expect(musicStepImpl(progressCollector().stream, "show-1")).rejects.toThrow("MiniMax-M3 did not return valid JSON");
    expect(mocks.generateMusic).not.toHaveBeenCalled();
    expect(mocks.state.show.themeLyrics).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stitch step
// ─────────────────────────────────────────────────────────────────────────────

describe("challenger M2: stitch step through the ffmpeg assembly", () => {
  function readyClips() {
    mocks.state.clips = [0, 1, 2].map((i) => {
      const videoUrl = path.join(mocks.tmpDir, `clip-${i}.mp4`);
      fs.writeFileSync(videoUrl, `clip-${i}`);
      return { id: `clip-${i}`, showId: "show-1", clipIndex: i, status: "ready", videoUrl, durationSeconds: 10, measuredDurationSeconds: [9.4, 11.05, 8.2][i], audioSource: "h3" };
    });
  }

  it("video: hands the clips in order with measured durations to assembleEpisode and retimes the transcript to the layout", async () => {
    readyClips();
    const music = musicResult();
    const outputPath = path.join(mocks.tmpDir, "episode.mp4");
    mocks.assembleEpisode.mockImplementation(async () => {
      fs.writeFileSync(outputPath, "episode");
      return {
        outputPath,
        layout: { titleCardSeconds: 7, clipOffsets: [7, 16.4, 27.45], clipDurations: [9.4, 11.05, 8.2], endCardSeconds: 13, totalSeconds: 48.65, width: 1366, height: 768, fps: 24, cardText: true },
        assemblyMs: 4_200,
      };
    });
    const { events, stream } = progressCollector();

    await stitchStepImpl(stream, "show-1", music);

    expect(mocks.assembleEpisode).toHaveBeenCalledTimes(1);
    const input = mocks.assembleEpisode.mock.calls[0][0];
    expect(input.clips.map((c: any) => [path.basename(c.path), c.durationSeconds])).toEqual([["clip-0.mp4", 9.4], ["clip-1.mp4", 11.05], ["clip-2.mp4", 8.2]]);
    expect(input.showName).toBe("John Oliver Like");
    expect(input.episodeTitle).toBe("The Toaster That Learned to Lie");
    expect(input.creditsLine).toBe("Three jokes we told tonight");
    expect(input.themeMusicPath).toBe(music.themePath);
    expect(input.creditsMusicPath).toBe(music.creditsPath);

    expect(mocks.state.show.localRenderPath).toBe(outputPath);
    expect(mocks.state.show.transcriptSegments.map((s: TranscriptSegment) => [s.startTimeSeconds, s.endTimeSeconds])).toEqual([[7, 16.4], [16.4, 27.45], [27.45, 35.65]]);
    expect(mocks.state.show.engineNotes.layout).toMatchObject({ titleCardSeconds: 7, clipOffsets: [7, 16.4, 27.45], endCardSeconds: 13 });
    expect(mocks.state.show.engineNotes.assemblyMs).toBe(4_200);
    expect(mocks.state.show.engineNotes.script.title).toBe("The Toaster That Learned to Lie");
    // Clip files and the music beds are cleaned; the render is kept for upload.
    const cleaned = mocks.cleanupTempFiles.mock.calls.flat(2);
    expect(cleaned).toEqual(expect.arrayContaining([mocks.state.clips[0].videoUrl, music.themePath, music.creditsPath]));
    expect(cleaned).not.toContain(outputPath);
    expect(statuses()).toEqual(["stitching"]);
    expect(events).toEqual([{ type: "current", step: "stitch" }, { type: "completed", step: "stitch" }]);
  });

  it("video: falls back to the topic as the episode title when the script recorded none", async () => {
    resetState({ engineNotes: null });
    readyClips();
    mocks.assembleEpisode.mockResolvedValue({ outputPath: "/tmp/x.mp4", layout: { titleCardSeconds: 7, clipOffsets: [7, 16.4, 27.45], clipDurations: [9.4, 11.05, 8.2], endCardSeconds: 13, totalSeconds: 48.65, width: 1280, height: 720, fps: 24, cardText: false }, assemblyMs: 1 });
    await stitchStepImpl(progressCollector().stream, "show-1", musicResult());
    expect(mocks.assembleEpisode.mock.calls[0][0].episodeTitle).toBe("Sentient toasters");
  });

  it("video: refuses to assemble when a clip is missing or not ready", async () => {
    readyClips();
    mocks.state.clips[1].status = "failed";
    await expect(stitchStepImpl(progressCollector().stream, "show-1", musicResult())).rejects.toThrow("Clip 1 is not ready; refusing to assemble an episode with missing beats.");
    expect(mocks.assembleEpisode).not.toHaveBeenCalled();

    mocks.state.clips = [];
    await expect(stitchStepImpl(progressCollector().stream, "show-1", musicResult())).rejects.toThrow("No video clips were recorded");
  });

  it("audio: assembles theme + episode + credits and offsets the transcript by the intro", async () => {
    const episodePath = path.join(mocks.tmpDir, "episode.wav");
    fs.writeFileSync(episodePath, "wav");
    resetState({
      format: "audio",
      localRenderPath: episodePath,
      transcriptSegments: [
        seg(0, "Joe Brogan", "So, toasters.", { startTimeSeconds: 0, endTimeSeconds: 6.25, durationSeconds: 6.25 }),
        seg(1, "Duncan Trussed", "Cosmic bread.", { startTimeSeconds: 6.25, endTimeSeconds: 14.75, durationSeconds: 8.5 }),
      ],
    });
    const music = musicResult();
    const outputPath = path.join(mocks.tmpDir, "podcast.wav");
    mocks.assembleAudioEpisode.mockResolvedValue({ outputPath, layout: { introSeconds: 8, episodeOffsetSeconds: 8, outroSeconds: 15 }, assemblyMs: 900 });
    const { events, stream } = progressCollector();

    await stitchStepImpl(stream, "show-1", music);

    expect(mocks.assembleEpisode).not.toHaveBeenCalled();
    expect(mocks.assembleAudioEpisode).toHaveBeenCalledWith({ episodePath, themeMusicPath: music.themePath, creditsMusicPath: music.creditsPath });
    expect(mocks.state.show.localRenderPath).toBe(outputPath);
    expect(mocks.state.show.transcriptSegments.map((s: TranscriptSegment) => [s.startTimeSeconds, s.endTimeSeconds, s.durationSeconds])).toEqual([
      [8, 14.25, 6.25],
      [14.25, 22.75, 8.5],
    ]);
    expect(mocks.state.show.engineNotes.layout).toEqual({ introSeconds: 8, episodeOffsetSeconds: 8, outroSeconds: 15 });
    expect(mocks.cleanupTempFiles.mock.calls.flat(2)).toEqual(expect.arrayContaining([episodePath, music.themePath, music.creditsPath]));
    expect(statuses()).toEqual(["stitching"]);
    expect(events).toEqual([{ type: "current", step: "stitch" }, { type: "completed", step: "stitch" }]);
  });

  it("audio: refuses to assemble when the voiced episode was never recorded", async () => {
    resetState({ format: "audio", localRenderPath: null });
    await expect(stitchStepImpl(progressCollector().stream, "show-1", musicResult())).rejects.toThrow("The voiced episode file is missing");
    expect(mocks.assembleAudioEpisode).not.toHaveBeenCalled();
  });
});
