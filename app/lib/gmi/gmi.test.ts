import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/env", () => ({
  env: {
    GMI_CLOUD_APIKEY: "test-gmi-key-0123456789abcdef",
    H3_RESOLUTION: undefined,
    H3_MAX_REQUESTS_PER_RUN: "14",
    H3_SESSION_CAP_USD: "8",
    DATABASE_URL: "postgresql://localhost:5432/test",
    MUX_TOKEN_ID: "id",
    MUX_TOKEN_SECRET: "secret",
  },
}));

// The spend guard reaches the database only when a clip is generated; the
// payload builders never do. Stub the module so importing video.ts is inert.
vi.mock("@/db", () => ({ db: {}, gmiSpend: {} }));

const { unwrapGmiErrorMessage } = await import("./client");
const { describeFailure, firstMediaUrl, isTerminalStatus } = await import("./queue");
const { extractJsonValue, stripThinking } = await import("./text");
const { buildClipPrompt, buildH3Payload, clampDuration } = await import("./video");
const { buildSpeechPayload } = await import("./speech");
const { buildMusicPayload } = await import("./music");
const { resolveVoiceId, MINIMAX_VOICES } = await import("./voices");
const { h3RunCap, h3SessionCapUsd } = await import("./spend");

describe("gmi error unwrapping", () => {
  it("prefers the engine's nested diagnostic over the edge banner", () => {
    const body = {
      error: {
        message: "Backend request failed with status 400",
        details: JSON.stringify({ error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]." } }),
      },
    };
    expect(unwrapGmiErrorMessage(body, "fallback")).toBe("Invalid max_tokens value, the valid range of max_tokens is [1, 393216].");
  });

  it("reads a bare string error, the shape billing failures use", () => {
    expect(unwrapGmiErrorMessage({ error: "Insufficient credits. Please add more credits to your account." }, "fallback"))
      .toBe("Insufficient credits. Please add more credits to your account.");
  });

  it("falls back to the banner, then to the caller's default", () => {
    expect(unwrapGmiErrorMessage({ error: { message: "Backend request failed" } }, "fallback")).toBe("Backend request failed");
    expect(unwrapGmiErrorMessage({}, "fallback")).toBe("fallback");
    expect(unwrapGmiErrorMessage("plain text body", "fallback")).toBe("plain text body");
  });
});

describe("request queue records", () => {
  const base = { request_id: "req-1", model: "MiniMax-H3", status: "success" };

  it("reads the video URL from whichever field the model used", () => {
    expect(firstMediaUrl({ ...base, outcome: { video_url: "https://cdn/a.mp4" } })).toBe("https://cdn/a.mp4");
    expect(firstMediaUrl({ ...base, outcome: { media_urls: [{ id: "0", url: "https://cdn/b.mp3" }] } }, "audio")).toBe("https://cdn/b.mp3");
    expect(firstMediaUrl({ ...base, outcome: { audio_url: "https://cdn/c.mp3" } }, "audio")).toBe("https://cdn/c.mp3");
  });

  it("refuses a success record with no media", () => {
    expect(() => firstMediaUrl({ ...base, outcome: {} })).toThrow(/no video URL/);
  });

  it("knows which statuses are final", () => {
    expect(isTerminalStatus("success")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("processing")).toBe(false);
  });

  it("surfaces the most specific failure reason", () => {
    expect(describeFailure({ ...base, status: "failed", error_message: "content moderation rejected the prompt" })).toBe("content moderation rejected the prompt");
    expect(describeFailure({ ...base, status: "failed", outcome: { error: { message: "GPU pool exhausted" } } })).toBe("GPU pool exhausted");
    expect(describeFailure({ ...base, status: "cancelled" })).toMatch(/no reason reported/);
  });
});

describe("m3 reply parsing", () => {
  it("strips inline thinking blocks", () => {
    expect(stripThinking("<think>plan the joke</think>\nA toaster walks into a bar.")).toBe("A toaster walks into a bar.");
    expect(stripThinking("<think>unterminated reasoning")).toBe("");
  });

  it("extracts a fenced object with braces inside strings", () => {
    const reply = "Here you go:\n```json\n{\"title\": \"Pigeons {allegedly} Unionize\", \"jokes\": [{\"setup\": \"a\", \"punchline\": \"b }\"}]}\n```\nEnjoy!";
    expect(JSON.parse(extractJsonValue(reply))).toEqual({
      title: "Pigeons {allegedly} Unionize",
      jokes: [{ setup: "a", punchline: "b }" }],
    });
  });

  it("extracts an array and tolerates a thinking preamble", () => {
    expect(JSON.parse(extractJsonValue("<think>{not json}</think>[\"a\", \"b\"]"))).toEqual(["a", "b"]);
  });

  it("fails clearly when there is no JSON at all", () => {
    expect(() => extractJsonValue("I would rather not.")).toThrow(/No JSON/);
  });
});

describe("minimax-h3 payloads", () => {
  it("clamps durations to the model's 4 to 15 second window", () => {
    expect(clampDuration(2)).toBe(4);
    expect(clampDuration(9.2)).toBe(10);
    expect(clampDuration(40)).toBe(15);
  });

  it("builds a reference-mode request", () => {
    const payload = buildH3Payload({
      prompt: "A host at a desk",
      durationSeconds: 9,
      referenceImageUrls: ["https://cdn/portrait.jpg"],
      referenceAudioUrls: ["https://cdn/line.mp3"],
    });
    expect(payload).toEqual({
      prompt: "A host at a desk",
      resolution: "768P",
      duration: 9,
      ratio: "16:9",
      reference_images: ["https://cdn/portrait.jpg"],
      reference_audios: ["https://cdn/line.mp3"],
    });
  });

  it("builds a frame-mode request without a ratio (the image decides it)", () => {
    const payload = buildH3Payload({ prompt: "continue", durationSeconds: 8, firstFrameUrl: "https://cdn/tail.png", resolution: "2K" });
    expect(payload).toEqual({ prompt: "continue", resolution: "2K", duration: 8, first_frame_image: "https://cdn/tail.png" });
  });

  it("refuses to mix frames with references, and refuses empty or oversized prompts", () => {
    expect(() => buildH3Payload({ prompt: "x", durationSeconds: 8, firstFrameUrl: "https://a", referenceImageUrls: ["https://b"] })).toThrow(/cannot combine/);
    expect(() => buildH3Payload({ prompt: "   ", durationSeconds: 8 })).toThrow(/non-empty/);
    expect(() => buildH3Payload({ prompt: "x".repeat(7001), durationSeconds: 8 })).toThrow(/7000/);
    expect(() => buildH3Payload({ prompt: "x", durationSeconds: 8, referenceAudioUrls: ["a", "b", "c", "d"] })).toThrow(/at most 3/);
  });

  it("writes the spoken line and the consistency asks into the clip prompt", () => {
    const prompt = buildClipPrompt(
      { text: "Tonight, the pigeons have unionized.", speaker: "Colin Jest", actingDirection: "deadpan" },
      {
        hosts: [{ name: "Colin Jest", position: "left" }, { name: "Michael Chey", position: "right" }],
        showType: "conversation",
        notes: "Weekend Update desk energy on NBC",
        hasReferencePortrait: true,
        hasReferenceAudio: true,
      },
    );
    expect(prompt).toContain("Colin Jest says (deadpan): \"Tonight, the pigeons have unionized.\"");
    expect(prompt).toContain("LEFT is speaking");
    expect(prompt).toContain("attached spoken line");
    expect(prompt).toContain("consistent with the reference image");
    expect(prompt).not.toMatch(/NBC|Weekend Update/);
    expect(prompt.length).toBeLessThanOrEqual(7000);
  });
});

describe("speech 2.8 and music 3.0 payloads", () => {
  it("sends the documented field names and drops the auto emotion", () => {
    expect(buildSpeechPayload({ text: " Hello ", voiceId: "English_Upbeat_Woman", emotion: "auto", speed: 1.2 })).toEqual({
      text: "Hello",
      voice_id: "English_Upbeat_Woman",
      format: "mp3",
      audio_sample_rate: "44100",
      bitrate: "128000",
      channel: "1",
      speed: 1.2,
    });
    expect(buildSpeechPayload({ text: "Hi", voiceId: "v", emotion: "angry", pitch: 40 })).toMatchObject({ emotion: "angry", pitch: 12 });
    expect(() => buildSpeechPayload({ text: " ", voiceId: "v" })).toThrow(/non-empty/);
  });

  it("enforces the lyric and prompt limits", () => {
    expect(buildMusicPayload({ lyrics: "[Hook]\nla la", prompt: "big band" })).toEqual({
      lyrics: "[Hook]\nla la",
      prompt: "big band",
      sample_rate: 44100,
      bitrate: 256000,
      format: "mp3",
    });
    expect(() => buildMusicPayload({ lyrics: "x".repeat(3501) })).toThrow(/3500/);
    expect(() => buildMusicPayload({ lyrics: "ok", prompt: "y".repeat(2001) })).toThrow(/2000/);
  });
});

describe("voice catalog", () => {
  it("maps legacy voice names from the previous engine onto MiniMax ids and passes catalog ids through", () => {
    expect(resolveVoiceId("Charon")).toBe("English_magnetic_voiced_man");
    expect(resolveVoiceId("Aoede")).toBe("English_Upbeat_Woman");
    expect(resolveVoiceId("English_Graceful_Lady")).toBe("English_Graceful_Lady");
    expect(resolveVoiceId("Not_A_Voice")).toBeUndefined();
    expect(new Set(MINIMAX_VOICES.map(v => v.id)).size).toBe(MINIMAX_VOICES.length);
  });
});

describe("spend caps", () => {
  it("reads the caps from env with sane defaults", () => {
    expect(h3RunCap()).toBe(14);
    expect(h3SessionCapUsd()).toBe(8);
  });
});
