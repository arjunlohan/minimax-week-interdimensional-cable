import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FALLBACK_VOICE_IDS } from "./gmi/voices";
import { encodePcmToWav, generateTtsPerTurn } from "./tts";

const mocks = vi.hoisted(() => ({
  synthesizeSpeechWav: vi.fn(),
  generateJson: vi.fn(),
}));

vi.mock("@/app/lib/gmi/speech", () => ({ synthesizeSpeechWav: mocks.synthesizeSpeechWav }));
vi.mock("@/app/lib/gmi/text", () => ({ generateJson: mocks.generateJson }));

// One second of silence per call, so durations are trivially checkable.
const SECONDS = 1;

interface SpeechCall {
  text: string;
  voice: string;
  emotion?: string;
  speed?: number;
  languageBoost?: string;
}

function calls(): SpeechCall[] {
  return mocks.synthesizeSpeechWav.mock.calls.map(([request]) => ({
    text: request.text,
    voice: request.voiceId,
    emotion: request.emotion,
    speed: request.speed,
    languageBoost: request.languageBoost,
  }));
}

describe("per-turn synthesis, one Speech 2.8 HD request per line", () => {
  const HOSTS = [
    { name: "Chamath Capitalia", ttsVoice: "English_magnetic_voiced_man", speakingRateWpm: 138 },
    { name: "Jason Calamaris", ttsVoice: "English_Persuasive_Man", speakingRateWpm: 178 },
    { name: "David Stacks", ttsVoice: "English_Trustworth_Man", speakingRateWpm: 142 },
    { name: "David Friedegg", ttsVoice: "English_Insightful_Speaker", speakingRateWpm: 148 },
  ];
  const TURNS = [
    { speaker: "Chamath Capitalia", text: "Structurally inevitable." },
    { speaker: "Jason Calamaris", text: "Can I finish?" },
    { speaker: "David Stacks", text: "That is not what the data says." },
    { speaker: "David Friedegg", text: "Zoom out for a second." },
    { speaker: "Chamath Capitalia", text: "As I said two years ago." },
  ];

  beforeEach(() => {
    mocks.synthesizeSpeechWav.mockReset();
    mocks.generateJson.mockReset();
    mocks.synthesizeSpeechWav.mockImplementation(async () => ({
      wav: encodePcmToWav(Buffer.alloc(24000 * 2 * SECONDS)),
      durationMs: SECONDS * 1000,
      requestId: "req-test",
    }));
  });

  it("uses each speaker's own voice, never a shared one", async () => {
    await generateTtsPerTurn(TURNS, HOSTS);
    expect(calls()).toHaveLength(5);
    expect(calls().map(c => c.voice)).toEqual([
      "English_magnetic_voiced_man",
      "English_Persuasive_Man",
      "English_Trustworth_Man",
      "English_Insightful_Speaker",
      "English_magnetic_voiced_man",
    ]);
    expect(calls().map(c => c.text)).toEqual(TURNS.map(t => t.text));
  });

  it("returns one measured duration per turn", async () => {
    const { durations } = await generateTtsPerTurn(TURNS, HOSTS);
    expect(durations).toHaveLength(TURNS.length);
    durations.forEach(d => expect(d).toBeCloseTo(SECONDS, 3));
  });

  it("concatenates into one WAV of the summed length", async () => {
    const { wav, durations } = await generateTtsPerTurn(TURNS, HOSTS);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const total = durations.reduce((a, b) => a + b, 0);
    // 44-byte header + PCM at 48000 bytes/sec
    expect(wav.length).toBe(44 + Math.round(total * 24000 * 2));
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  });

  it("falls back to the first host when a turn names an unknown speaker", async () => {
    await generateTtsPerTurn([{ speaker: "Nobody", text: "Hello." }], HOSTS);
    expect(calls()[0].voice).toBe("English_magnetic_voiced_man");
  });

  it("matches a speaker by first name when the script drops the surname", async () => {
    await generateTtsPerTurn([{ speaker: "Jason", text: "Can I finish?" }], HOSTS);
    expect(calls()[0].voice).toBe("English_Persuasive_Man");
  });

  it("maps acting directions, acoustic tags and inline tags onto emotions per turn", async () => {
    await generateTtsPerTurn([
      { speaker: "David Stacks", text: "That is not what the data says.", actingDirection: "deadpan" },
      { speaker: "Jason Calamaris", text: "We're all friends here!", acousticTags: ["[laughs]"] },
      { speaker: "David Friedegg", text: "[gasps] Photosynthesis is two percent efficient." },
      { speaker: "Chamath Capitalia", text: "I said this two years ago.", emotion: "angry", actingDirection: "gleeful" },
      { speaker: "Chamath Capitalia", text: "Let me steelman that." },
    ], HOSTS);

    expect(calls().map(c => c.emotion)).toEqual(["calm", "happy", "surprised", "angry", "auto"]);
    expect(calls()[2].text).toBe("Photosynthesis is two percent efficient.");
  });

  it("speeds up only the fast talker, and boosts English for everyone", async () => {
    await generateTtsPerTurn(TURNS, HOSTS);
    expect(calls().map(c => c.speed)).toEqual([undefined, 1.1, undefined, undefined, undefined]);
    expect(new Set(calls().map(c => c.languageBoost))).toEqual(new Set(["English"]));
  });

  it("skips a turn that is only a stage direction, keeping its zero-length slot", async () => {
    const { durations } = await generateTtsPerTurn([
      { speaker: "Jason Calamaris", text: "[laughs]" },
      { speaker: "David Stacks", text: "Moving on." },
    ], HOSTS);

    expect(calls().map(c => c.text)).toEqual(["Moving on."]);
    expect(durations).toEqual([0, SECONDS]);
  });

  it("translates every turn in one MiniMax-M3 call before speaking them", async () => {
    const translated = ["Uno", "Dos", "Tres", "Cuatro", "Cinco"];
    mocks.generateJson.mockResolvedValueOnce(translated);

    await generateTtsPerTurn(TURNS, HOSTS, "es");

    expect(mocks.generateJson).toHaveBeenCalledTimes(1);
    const options = mocks.generateJson.mock.calls[0][0];
    expect(options.label).toBe("tts-translate-turns");
    expect(options.prompt).toContain("Spanish");
    expect(options.prompt).toContain(JSON.stringify(TURNS.map(t => t.text)));
    expect(calls().map(c => c.text)).toEqual(translated);
    expect(new Set(calls().map(c => c.languageBoost))).toEqual(new Set(["Spanish"]));
  });

  it("does not translate when the show is already in English", async () => {
    await generateTtsPerTurn(TURNS, HOSTS, "en");
    expect(mocks.generateJson).not.toHaveBeenCalled();
  });

  it("seats an unpinned cast on distinct fallback voices", async () => {
    const cast = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
    await generateTtsPerTurn([
      { speaker: "Alpha", text: "One." },
      { speaker: "Beta", text: "Two." },
      { speaker: "Gamma", text: "Three." },
      { speaker: "Beta", text: "Four." },
    ], cast);

    expect(calls().map(c => c.voice)).toEqual([
      FALLBACK_VOICE_IDS[0],
      FALLBACK_VOICE_IDS[1],
      FALLBACK_VOICE_IDS[2],
      FALLBACK_VOICE_IDS[1],
    ]);
  });

  it("surfaces a failed turn instead of returning partial audio", async () => {
    mocks.synthesizeSpeechWav.mockRejectedValueOnce(new Error("GMI Cloud request failed with status 500"));
    await expect(generateTtsPerTurn(TURNS, HOSTS)).rejects.toThrow("status 500");
  });
});
