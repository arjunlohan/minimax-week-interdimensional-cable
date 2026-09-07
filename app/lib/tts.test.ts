import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FALLBACK_VOICE_IDS, FEMININE_VOICE_IDS, MASCULINE_VOICE_IDS } from "./gmi/voices";
import {
  emotionForSegment,
  encodePcmToWav,
  generateShowAudio,
  generateSingleVoiceClip,
  generateTts,
  speedForHost,
  splitTranscriptIntoTurns,
  stripAcousticTags,
  translateTurns,
  voiceForHost,
} from "./tts";

// The GMI boundary is mocked: nothing here reaches the network, ffmpeg, or the
// environment validation those modules run at import.
const mocks = vi.hoisted(() => ({
  synthesizeSpeechWav: vi.fn(),
  generateJson: vi.fn(),
}));

vi.mock("@/app/lib/gmi/speech", () => ({ synthesizeSpeechWav: mocks.synthesizeSpeechWav }));
vi.mock("@/app/lib/gmi/text", () => ({ generateJson: mocks.generateJson }));

const MAGNETIC = "English_magnetic_voiced_man";
const PERSUASIVE = "English_Persuasive_Man";
const TRUSTWORTHY = "English_Trustworth_Man";
const BYTES_PER_SECOND = 48000;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/**
 * A WAV the way ffmpeg writes one: a LIST/INFO chunk sits between "fmt " and
 * "data", so the header is longer than the canonical 44 bytes.
 */
function ffmpegWav(pcm: Buffer): Buffer {
  const riffAndFmt = encodePcmToWav(Buffer.alloc(0)).subarray(0, 36);
  const software = Buffer.from("Lavf61.7.100\0\0", "ascii");
  const list = Buffer.concat([
    Buffer.from("LIST"),
    u32(4 + 8 + software.length),
    Buffer.from("INFO"),
    Buffer.from("ISFT"),
    u32(software.length - 1),
    software,
  ]);
  const data = Buffer.concat([Buffer.from("data"), u32(pcm.length), pcm]);
  const wav = Buffer.concat([riffAndFmt, list, data]);
  wav.writeUInt32LE(wav.length - 8, 4);
  return wav;
}

/** Speech whose PCM is the spoken text's bytes, so a WAV proves what was said, and in what order. */
function speechFor(text: string) {
  const pcm = Buffer.from(text, "utf8");
  return { wav: ffmpegWav(pcm), durationMs: Math.round((pcm.length / BYTES_PER_SECOND) * 1000), requestId: "req-test" };
}

function requests(): Array<Record<string, unknown>> {
  return mocks.synthesizeSpeechWav.mock.calls.map(([request]) => request as Record<string, unknown>);
}

function spokenTexts(): unknown[] {
  return requests().map(r => r.text);
}

function spokenVoices(): unknown[] {
  return requests().map(r => r.voiceId);
}

describe("tts", () => {
  beforeEach(() => {
    mocks.synthesizeSpeechWav.mockReset();
    mocks.generateJson.mockReset();
    mocks.synthesizeSpeechWav.mockImplementation(async (request: { text: string }) => speechFor(request.text));
  });

  describe("encodePcmToWav", () => {
    it("encodes PCM buffer into standard 44-byte RIFF/WAVE header", () => {
      const fakePcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const wav = encodePcmToWav(fakePcm);

      // Check total size
      expect(wav.length).toBe(44 + fakePcm.length);

      // Check RIFF header
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(4)).toBe(fakePcm.length + 44 - 8);
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");

      // Check fmt subchunk
      expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
      expect(wav.readUInt32LE(16)).toBe(16); // Subchunk1Size = 16 for PCM
      expect(wav.readUInt16LE(20)).toBe(1); // AudioFormat = 1 (PCM linear)
      expect(wav.readUInt16LE(22)).toBe(1); // NumChannels = 1 (Mono)
      expect(wav.readUInt32LE(24)).toBe(24000); // SampleRate = 24000 Hz
      expect(wav.readUInt32LE(28)).toBe(48000); // ByteRate = 24000 * 1 * (16/8) = 48000
      expect(wav.readUInt16LE(32)).toBe(2); // BlockAlign = 1 * (16/8) = 2
      expect(wav.readUInt16LE(34)).toBe(16); // BitsPerSample = 16

      // Check data subchunk
      expect(wav.toString("ascii", 36, 40)).toBe("data");
      expect(wav.readUInt32LE(40)).toBe(fakePcm.length);

      // Check audio payload
      expect(wav.subarray(44)).toEqual(fakePcm);
    });

    it("handles empty PCM buffer", () => {
      const emptyPcm = Buffer.alloc(0);
      const wav = encodePcmToWav(emptyPcm);

      expect(wav.length).toBe(44);
      expect(wav.readUInt32LE(4)).toBe(36);
      expect(wav.readUInt32LE(40)).toBe(0);
    });
  });

  describe("voiceForHost", () => {
    it("maps registered host names, and their pre-rename spellings, to catalog voices", () => {
      expect(voiceForHost("John Olive")).toBe(MAGNETIC);
      expect(voiceForHost("Seth Mires")).toBe(PERSUASIVE);
      expect(voiceForHost("Colin Jest")).toBe(MAGNETIC);
      expect(voiceForHost("Michael Chey")).toBe(PERSUASIVE);
      expect(voiceForHost("David Friedegg")).toBe("English_Insightful_Speaker");

      expect(voiceForHost("John Oliver")).toBe(MAGNETIC);
      expect(voiceForHost("Seth Meyers")).toBe(PERSUASIVE);
      expect(voiceForHost("Colin Jost")).toBe(MAGNETIC);
      expect(voiceForHost("Michael Che")).toBe(PERSUASIVE);
    });

    it("cycles through fallback voices for unknown host strings", () => {
      expect(voiceForHost("Unknown Host A", 0)).toBe(FALLBACK_VOICE_IDS[0]);
      expect(voiceForHost("Unknown Host B", 1)).toBe(FALLBACK_VOICE_IDS[1]);
      expect(voiceForHost("Unknown Host C", 2)).toBe(FALLBACK_VOICE_IDS[2]);
      expect(voiceForHost("Unknown Host H", FALLBACK_VOICE_IDS.length)).toBe(FALLBACK_VOICE_IDS[0]);
    });

    it("prioritizes explicit ttsVoice on host object", () => {
      expect(voiceForHost({ name: "John Olive", ttsVoice: "English_expressive_narrator" })).toBe("English_expressive_narrator");
      expect(voiceForHost({ name: "Custom Theorist", ttsVoice: "English_Aussie_Bloke" })).toBe("English_Aussie_Bloke");
    });

    it("resolves a legacy voice name pinned on a host to its catalog equivalent", () => {
      expect(voiceForHost({ name: "John Olive", ttsVoice: "Enceladus" })).toBe("English_expressive_narrator");
      expect(voiceForHost({ name: "Custom Theorist", ttsVoice: "Fenrir" })).toBe("English_Aussie_Bloke");
      expect(voiceForHost({ name: "Custom Host", voice: "Aoede" })).toBe("English_Upbeat_Woman");
    });

    it("supports voice alias property on host object", () => {
      expect(voiceForHost({ name: "Custom Host", voice: "English_Upbeat_Woman" })).toBe("English_Upbeat_Woman");
    });

    it("ignores an explicit voice the catalog does not know rather than sending it to the model", () => {
      expect(voiceForHost({ name: "Seth Mires", ttsVoice: "Morgan Freeman" })).toBe(PERSUASIVE);
      expect(voiceForHost({ name: "Nobody", ttsVoice: "Nonsense", voice: "English_Graceful_Lady" })).toBe("English_Graceful_Lady");
      expect(voiceForHost({ name: "Nobody", ttsVoice: "Nonsense" }, 3)).toBe(FALLBACK_VOICE_IDS[3]);
    });

    it("falls back to name map or fallback voices for host object without explicit voice", () => {
      expect(voiceForHost({ name: "Seth Mires" })).toBe(PERSUASIVE);
      expect(voiceForHost({ name: "Special Guest" }, 3)).toBe(FALLBACK_VOICE_IDS[3]);
    });

    it("picks a pool by the gender the description implies, cycling by seat", () => {
      const her = { name: "Dana Sharp", personality: "She runs a dry news desk." };
      expect(voiceForHost(her, 0)).toBe(FEMININE_VOICE_IDS[0]);
      expect(voiceForHost(her, 1)).toBe(FEMININE_VOICE_IDS[1]);

      const him = { name: "Ed Loud", personality: "He is a loud comic." };
      expect(voiceForHost(him, 0)).toBe(MASCULINE_VOICE_IDS[0]);

      expect(voiceForHost({ name: "Q", personality: "A comedian." }, 0)).toBe(FALLBACK_VOICE_IDS[0]);
    });
  });

  describe("emotionForSegment", () => {
    it("maps acting directions onto the eight Speech 2.8 emotions", () => {
      expect(emotionForSegment("deadpan")).toBe("calm");
      expect(emotionForSegment("mock-serious")).toBe("calm");
      expect(emotionForSegment("outraged")).toBe("angry");
      expect(emotionForSegment("gleeful")).toBe("happy");
      expect(emotionForSegment("whisper")).toBe("fearful");
      expect(emotionForSegment("shocked")).toBe("surprised");
      expect(emotionForSegment("a disgusted sneer")).toBe("disgusted");
      expect(emotionForSegment("mournful")).toBe("sad");
    });

    it("defaults to auto when nothing is recognised", () => {
      expect(emotionForSegment()).toBe("auto");
      expect(emotionForSegment("")).toBe("auto");
      expect(emotionForSegment("confident")).toBe("auto");
      expect(emotionForSegment(undefined, ["[crosstalk]", "[interrupting]"])).toBe("auto");
    });

    it("reads acoustic tags when there is no direction", () => {
      expect(emotionForSegment(undefined, ["[laughs]"])).toBe("happy");
      expect(emotionForSegment(undefined, ["[gasps]"])).toBe("surprised");
      expect(emotionForSegment(undefined, ["[scoffs]"])).toBe("disgusted");
      expect(emotionForSegment(undefined, ["[whispering]"])).toBe("fearful");
      expect(emotionForSegment(undefined, ["[screaming]"])).toBe("angry");
      expect(emotionForSegment(undefined, ["[deadpan]"])).toBe("calm");
    });

    it("lets the direction win over the tags, and the first cue win within a direction", () => {
      expect(emotionForSegment("deadpan", ["[laughs]"])).toBe("calm");
      expect(emotionForSegment("deadpan, then breaking into laughter")).toBe("calm");
      expect(emotionForSegment("outraged, then a chuckle")).toBe("angry");
      expect(emotionForSegment("Delighted. Then outraged.")).toBe("happy");
    });
  });

  describe("speedForHost", () => {
    it("speeds up hosts described or measured as fast talkers", () => {
      expect(speedForHost({ name: "John Olive", personaCraft: "Articulate, fast-talking British anchor." })).toBe(1.1);
      expect(speedForHost({ name: "Jason Calamaris", speakingRateWpm: 178 })).toBe(1.1);
      expect(speedForHost({ name: "Tim Villain", personality: "Manic energy, breathless diatribes." })).toBe(1.1);
    });

    it("leaves everyone else at the model default", () => {
      expect(speedForHost({ name: "Chamath Capitalia", speakingRateWpm: 138, personality: "Speaks slowly." })).toBeUndefined();
      expect(speedForHost({ name: "Seth Mires", speakingRateWpm: 150 })).toBeUndefined();
      expect(speedForHost("Colin Jest")).toBeUndefined();
    });
  });

  describe("stripAcousticTags", () => {
    it("removes bracketed stage directions and tidies the spacing around them", () => {
      expect(stripAcousticTags("Welcome back. [chuckles] Thanks, Colin. [snickers]")).toBe("Welcome back. Thanks, Colin.");
      expect(stripAcousticTags("[laughs] No, but seriously [pause] folks.")).toBe("No, but seriously folks.");
      expect(stripAcousticTags("Cool [sighs].")).toBe("Cool.");
    });

    it("leaves untagged text alone and empties a line that is only a tag", () => {
      expect(stripAcousticTags("Look, the point is this.")).toBe("Look, the point is this.");
      expect(stripAcousticTags("[laughs]")).toBe("");
    });
  });

  describe("splitTranscriptIntoTurns", () => {
    const hosts = [{ name: "Colin Jest" }, { name: "Michael Chey" }];

    it("starts a turn at every line labelled with a host's full or first name", () => {
      const turns = splitTranscriptIntoTurns(
        "Colin Jest: Welcome to the desk.\n\nMichael: Thanks, Colin.\nColin Jest: Breaking news: it is Tuesday.",
        hosts,
      );
      expect(turns).toEqual([
        { speaker: "Colin Jest", text: "Welcome to the desk." },
        { speaker: "Michael Chey", text: "Thanks, Colin." },
        { speaker: "Colin Jest", text: "Breaking news: it is Tuesday." },
      ]);
    });

    it("appends unlabelled lines to the turn before them", () => {
      const turns = splitTranscriptIntoTurns("Colin Jest: Line one.\nLine two.\nLook: line three.", hosts);
      expect(turns).toEqual([{ speaker: "Colin Jest", text: "Line one.\nLine two.\nLook: line three." }]);
    });

    it("maps a transcript's own labels onto the cast in order of appearance", () => {
      const turns = splitTranscriptIntoTurns("Host1: Hey\nHost2: Hi\nHost1: Bye", hosts);
      expect(turns.map(t => t.speaker)).toEqual(["Colin Jest", "Michael Chey", "Colin Jest"]);
      expect(turns.map(t => t.text)).toEqual(["Hey", "Hi", "Bye"]);
    });

    it("gives an unlabelled transcript to the first host", () => {
      expect(splitTranscriptIntoTurns("Just a monologue.\n\nWith two paragraphs.", hosts)).toEqual([
        { speaker: "Colin Jest", text: "Just a monologue.\nWith two paragraphs." },
      ]);
    });
  });

  describe("generateTts", () => {
    it("voices a single host in one request with its catalog voice and returns a canonical WAV", async () => {
      const wav = await generateTts("Hello audience! [laughs]", [{ name: "John Olive" }]);

      expect(mocks.synthesizeSpeechWav).toHaveBeenCalledTimes(1);
      expect(mocks.synthesizeSpeechWav).toHaveBeenCalledWith(expect.objectContaining({
        text: "Hello audience!",
        voiceId: MAGNETIC,
        emotion: "auto",
        languageBoost: "English",
      }));
      expect(requests()[0].speed).toBeUndefined();
      expect(mocks.generateJson).not.toHaveBeenCalled();

      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt32LE(40)).toBe("Hello audience!".length);
      expect(wav.subarray(44).toString()).toBe("Hello audience!");
    });

    it("accepts a canonical 44-byte WAV from the synthesis layer as well", async () => {
      const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
      mocks.synthesizeSpeechWav.mockResolvedValueOnce({ wav: encodePcmToWav(pcm), durationMs: 0, requestId: "r" });

      const wav = await generateTts("Four bytes", [{ name: "John Olive" }]);
      expect(wav.length).toBe(48);
      expect(wav.subarray(44)).toEqual(pcm);
    });

    it("speeds up a host described as a fast talker", async () => {
      await generateTts("Quick.", [{ name: "John Olive", personality: "Fast-talking British satirist." }]);
      expect(requests()[0].speed).toBe(1.1);
    });

    it("voices a multi-host transcript a turn at a time, each host in its own voice", async () => {
      const hosts = [
        { name: "Colin Jest", ttsVoice: MAGNETIC },
        { name: "Michael Chey", ttsVoice: PERSUASIVE },
      ];
      const transcript = "Colin Jest: Welcome to Weekend Update. [chuckles]\n\nMichael Chey: Thanks Colin. [snickers]";

      const wav = await generateTts(transcript, hosts);

      expect(mocks.synthesizeSpeechWav).toHaveBeenCalledTimes(2);
      expect(spokenVoices()).toEqual([MAGNETIC, PERSUASIVE]);
      expect(spokenTexts()).toEqual(["Welcome to Weekend Update.", "Thanks Colin."]);
      expect(requests().map(r => r.emotion)).toEqual(["happy", "happy"]);

      const expected = "Welcome to Weekend Update.Thanks Colin.";
      expect(wav.length).toBe(44 + expected.length);
      expect(wav.subarray(44).toString()).toBe(expected);
    });

    it("supports string host list in multi-speaker dialogue", async () => {
      const wav = await generateTts("John Olive: Hey\nSeth Mires: Hi", ["John Olive", "Seth Mires"]);

      expect(spokenVoices()).toEqual([MAGNETIC, PERSUASIVE]);
      expect(spokenTexts()).toEqual(["Hey", "Hi"]);
      expect(wav.subarray(44).toString()).toBe("HeyHi");
    });

    it("maps a transcript's own speaker labels onto the cast", async () => {
      await generateTts("Host1: Hey\nHost2: Hi\nHost1: Bye", ["John Olive", "Seth Mires"]);
      expect(spokenVoices()).toEqual([MAGNETIC, PERSUASIVE, MAGNETIC]);
    });

    it("translates the transcript with MiniMax-M3 first when targetLang is provided", async () => {
      mocks.generateJson.mockResolvedValueOnce(["¡Hola a todos! [risas]", "Segundo párrafo."]);

      const wav = await generateTts("Hello everyone! [laughs]\n\nSecond paragraph.", [{ name: "John Olive" }], "es");

      expect(mocks.generateJson).toHaveBeenCalledTimes(1);
      const options = mocks.generateJson.mock.calls[0][0];
      expect(options.label).toBe("tts-translate-transcript");
      expect(options.prompt).toContain("Spanish");
      expect(options.prompt).toContain(JSON.stringify(["Hello everyone! [laughs]", "Second paragraph."]));
      expect(options.schema.safeParse(["uno", "dos"]).success).toBe(true);
      expect(options.schema.safeParse(["uno"]).success).toBe(false);

      expect(mocks.synthesizeSpeechWav).toHaveBeenCalledWith(expect.objectContaining({
        text: "¡Hola a todos!\n\nSegundo párrafo.",
        voiceId: MAGNETIC,
        languageBoost: "Spanish",
      }));
      expect(wav.subarray(44).toString()).toBe("¡Hola a todos!\n\nSegundo párrafo.");
    });

    it("does not translate when the target language is English", async () => {
      await generateTts("Hi", [{ name: "John Olive" }], "en");
      expect(mocks.generateJson).not.toHaveBeenCalled();
      expect(requests()[0].languageBoost).toBe("English");
    });

    it("translates a multi-host transcript once, then speaks each translated turn", async () => {
      mocks.generateJson.mockResolvedValueOnce(["Hola", "Adiós"]);

      await generateTts("John Olive: Hello\nSeth Mires: Goodbye", ["John Olive", "Seth Mires"], "es");

      expect(mocks.generateJson).toHaveBeenCalledTimes(1);
      expect(mocks.generateJson.mock.calls[0][0].label).toBe("tts-translate-turns");
      expect(spokenTexts()).toEqual(["Hola", "Adiós"]);
      expect(requests().map(r => r.languageBoost)).toEqual(["Spanish", "Spanish"]);
    });

    it("throws when Speech 2.8 returns no audio", async () => {
      mocks.synthesizeSpeechWav.mockResolvedValueOnce({ wav: encodePcmToWav(Buffer.alloc(0)), durationMs: 0, requestId: "r" });
      await expect(generateTts("test", [{ name: "John Olive" }])).rejects.toThrow(/returned no audio for John Olive/);
    });

    it("throws when the synthesis layer hands back a WAV without a data chunk", async () => {
      mocks.synthesizeSpeechWav.mockResolvedValueOnce({ wav: Buffer.from("RIFF\0\0\0\0WAVE"), durationMs: 0, requestId: "r" });
      await expect(generateTts("test", [{ name: "John Olive" }])).rejects.toThrow(/no data chunk/);
    });

    it("refuses audio in a format the pipeline cannot concatenate", async () => {
      const wav = encodePcmToWav(Buffer.alloc(4));
      wav.writeUInt32LE(44100, 24);
      mocks.synthesizeSpeechWav.mockResolvedValueOnce({ wav, durationMs: 0, requestId: "r" });
      await expect(generateTts("test", [{ name: "John Olive" }])).rejects.toThrow(/expected 24000 Hz 16-bit mono WAV, got 44100 Hz/);
    });

    it("propagates a synthesis failure", async () => {
      mocks.synthesizeSpeechWav.mockRejectedValueOnce(new Error("GMI Cloud minimax-tts-speech-2.8-hd request r1 failed: quota"));
      await expect(generateTts("test", [{ name: "John Olive" }])).rejects.toThrow("request r1 failed: quota");
    });

    it("fails when translation fails, without synthesizing anything", async () => {
      mocks.generateJson.mockRejectedValueOnce(new Error("tts-translate-transcript: MiniMax-M3 did not return valid JSON after 2 attempts"));
      await expect(generateTts("test", [{ name: "John Olive" }], "fr")).rejects.toThrow("did not return valid JSON");
      expect(mocks.synthesizeSpeechWav).not.toHaveBeenCalled();
    });
  });

  describe("generateSingleVoiceClip", () => {
    it("generates a data URI containing the base64 WAV", async () => {
      const dataUri = await generateSingleVoiceClip("Quick tangent!", "Seth Mires");

      expect(dataUri.startsWith("data:audio/wav;base64,")).toBe(true);
      const wav = Buffer.from(dataUri.replace("data:audio/wav;base64,", ""), "base64");
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.subarray(44).toString()).toBe("Quick tangent!");
      expect(spokenVoices()).toEqual([PERSUASIVE]);
    });

    it("accepts a TtsHost object", async () => {
      const dataUri = await generateSingleVoiceClip("Podcast tangent!", { name: "Custom Host", ttsVoice: "English_Upbeat_Woman" });

      expect(dataUri.startsWith("data:audio/wav;base64,")).toBe(true);
      expect(spokenVoices()).toEqual(["English_Upbeat_Woman"]);
    });

    it("defaults to the investigative desk host", async () => {
      await generateSingleVoiceClip("Cool.");
      expect(spokenVoices()).toEqual([MAGNETIC]);
    });
  });

  describe("generateShowAudio", () => {
    it("voices a wide cast from its turns, translating once", async () => {
      mocks.generateJson.mockResolvedValueOnce(["Un", "Deux", "Trois"]);
      const hosts = [
        { name: "A", ttsVoice: MAGNETIC },
        { name: "B", ttsVoice: PERSUASIVE },
        { name: "C", ttsVoice: TRUSTWORTHY },
      ];
      const turns = [
        { speaker: "A", text: "One" },
        { speaker: "B", text: "Two" },
        { speaker: "C", text: "Three" },
      ];

      const wav = await generateShowAudio("A: One\nB: Two\nC: Three", hosts, turns, "fr");

      expect(mocks.generateJson).toHaveBeenCalledTimes(1);
      expect(mocks.generateJson.mock.calls[0][0].label).toBe("tts-translate-turns");
      expect(spokenTexts()).toEqual(["Un", "Deux", "Trois"]);
      expect(spokenVoices()).toEqual([MAGNETIC, PERSUASIVE, TRUSTWORTHY]);
      expect(requests().map(r => r.languageBoost)).toEqual(["French", "French", "French"]);
      expect(wav.subarray(44).toString()).toBe("UnDeuxTrois");
    });

    it("voices a single host from the transcript in one request, even when turns are given", async () => {
      const wav = await generateShowAudio("One.\n\nTwo.", [{ name: "John Olive" }], [
        { speaker: "John Olive", text: "One." },
        { speaker: "John Olive", text: "Two." },
      ]);

      expect(mocks.synthesizeSpeechWav).toHaveBeenCalledTimes(1);
      expect(spokenTexts()).toEqual(["One.\n\nTwo."]);
      expect(wav.subarray(44).toString()).toBe("One.\n\nTwo.");
    });

    it("splits the transcript on its speaker labels when a wide cast has no turns", async () => {
      await generateShowAudio("Colin Jest: Hey.\nMichael Chey: Hi.", [{ name: "Colin Jest" }, { name: "Michael Chey" }], []);
      expect(spokenVoices()).toEqual([MAGNETIC, PERSUASIVE]);
      expect(spokenTexts()).toEqual(["Hey.", "Hi."]);
    });
  });

  describe("translateTurns", () => {
    it("returns English turns untouched without calling the model", async () => {
      const turns = [{ speaker: "A", text: "Hello" }];
      expect(await translateTurns(turns, "en")).toBe(turns);
      expect(await translateTurns([], "fr")).toEqual([]);
      expect(mocks.generateJson).not.toHaveBeenCalled();
    });

    it("keeps speakers and delivery notes attached to their translated lines", async () => {
      mocks.generateJson.mockResolvedValueOnce(["Bonjour", "Au revoir"]);
      const turns = [
        { speaker: "A", text: "Hello", actingDirection: "deadpan", acousticTags: ["[sighs]"] },
        { speaker: "B", text: "Goodbye" },
      ];

      const translated = await translateTurns(turns, "fr");

      expect(translated).toEqual([
        { speaker: "A", text: "Bonjour", actingDirection: "deadpan", acousticTags: ["[sighs]"] },
        { speaker: "B", text: "Au revoir" },
      ]);
      const options = mocks.generateJson.mock.calls[0][0];
      expect(options.prompt).toContain("French");
      expect(options.prompt).toContain(JSON.stringify(["Hello", "Goodbye"]));
      expect(options.schema.safeParse(["a", "b", "c"]).success).toBe(false);
    });
  });
});
