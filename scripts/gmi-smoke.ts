/* eslint-disable no-console, node/no-process-env */
/**
 * Phase 0: prove access to every MiniMax model on GMI Cloud and record what the
 * platform actually returns, before any architecture depends on it.
 *
 *   npx tsx scripts/gmi-smoke.ts            # text + speech + music (all free)
 *   npx tsx scripts/gmi-smoke.ts --video    # plus two 4 s MiniMax-H3 clips ($0.26)
 *   npx tsx scripts/gmi-smoke.ts --voices   # plus one line in every catalog voice
 *   npx tsx scripts/gmi-smoke.ts --only=music,video   # just those sections
 *   npx tsx scripts/gmi-smoke.ts --only=video --line=/tmp/line.mp3   # reuse a synthesized line
 *
 * Writes observations to DOCS/gmi-contracts.md (appended, timestamped).
 */
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local" });

const args = process.argv.slice(2);
const onlyArg = args.find(a => a.startsWith("--only="));
const ONLY = new Set(onlyArg ? onlyArg.slice("--only=".length).split(",").map(s => s.trim()).filter(Boolean) : []);
const want = (section: string) => ONLY.size === 0 || ONLY.has(section);
const RUN_VIDEO = args.includes("--video") || ONLY.has("video");
const RUN_VOICES = args.includes("--voices") || ONLY.has("voices");
// --line=<path to an mp3> reuses an already synthesized line for the H3 section
// instead of waiting on the speech queue again.
const LINE_FILE = args.find(a => a.startsWith("--line="))?.slice("--line=".length);

const notes: string[] = [];
function note(line: string) {
  console.log(line);
  notes.push(line);
}

function preview(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    note(`- ${label}: ok in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return result;
  } catch (err) {
    note(`- ${label}: FAILED in ${((Date.now() - started) / 1000).toFixed(1)} s: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function main() {
  if (!process.env.GMI_CLOUD_APIKEY) {
    console.error("GMI_CLOUD_APIKEY is not set in .env.local");
    process.exit(2);
  }

  // Import after dotenv so app/lib/env validates the loaded values.
  const { generateJson, generateText } = await import("../app/lib/gmi/text");
  const { synthesizeSpeech } = await import("../app/lib/gmi/speech");
  const { generateMusic } = await import("../app/lib/gmi/music");
  const { MINIMAX_VOICES } = await import("../app/lib/gmi/voices");
  const { probeMedia } = await import("../app/lib/media");
  const { tmpPath } = await import("../app/lib/gmi/queue");

  note(`\n## Smoke run ${new Date().toISOString()}`);

  // ── 1. MiniMax-M3, plain text ───────────────────────────────────────────────
  if (want("text")) {
    const plain = await timed("M3 text", () => generateText({
      system: "You are a late-night comedy head writer.",
      prompt: "In one sentence, pitch a talk-show cold open about a toaster that achieved sentience. No preamble.",
      maxOutputTokens: 4096,
    }));
    note(`  reply: ${preview(plain, 300)}`);
    note(`  contains <think>: ${/<think>/i.test(plain)}`);

    // ── 2. MiniMax-M3, JSON with Zod ────────────────────────────────────────────
    const Pitch = z.object({
      title: z.string(),
      hosts: z.array(z.string()).min(1),
      jokes: z.array(z.object({ setup: z.string(), punchline: z.string() })).min(2),
    });
    const json = await timed("M3 JSON", () => generateJson({
      label: "smoke-json",
      schema: Pitch,
      system: "You are a late-night comedy head writer.",
      prompt: "Return a JSON object with keys title (string), hosts (array of 2 fictional host names), jokes (array of 2 objects with setup and punchline) about municipal pigeon policy.",
      maxOutputTokens: 4096,
    }));
    note(`  parsed: ${preview(json, 400)}`);
  }

  // ── 3. Speech 2.8 HD, two voices ────────────────────────────────────────────
  let speechA: Awaited<ReturnType<typeof synthesizeSpeech>> | null = null;
  if (LINE_FILE && RUN_VIDEO && !want("speech")) {
    const audio = fs.readFileSync(LINE_FILE);
    const probe = await probeMedia(LINE_FILE);
    speechA = { audio, format: LINE_FILE.endsWith(".flac") ? "flac" : "mp3", remoteUrl: `file://${LINE_FILE}`, requestId: "reused", durationMs: Math.round((probe.durationSeconds ?? 0) * 1000) };
    note(`- Speech line reused from ${LINE_FILE} (${speechA.durationMs} ms)`);
  } else if (want("speech") || RUN_VIDEO) {
    speechA = await timed("Speech 2.8 HD (English_magnetic_voiced_man, calm)", () => synthesizeSpeech({
      text: "Good evening. Tonight, the pigeons have unionized, and honestly, their demands are reasonable.",
      voiceId: "English_magnetic_voiced_man",
      emotion: "calm",
    }));
    const speechAPath = tmpPath("smoke-speech-a", speechA.format);
    fs.writeFileSync(speechAPath, speechA.audio);
    note(`  audio: ${speechA.audio.length} bytes, ${speechA.durationMs} ms, url: ${preview(speechA.remoteUrl, 120)}`);
    note(`  probe: ${preview(await probeMedia(speechAPath).then(p => ({ duration: p.durationSeconds, audio: p.hasAudio })))}`);

    if (want("speech")) {
      const speechB = await timed("Speech 2.8 HD (English_Upbeat_Woman, happy)", () => synthesizeSpeech({
        text: "And I, for one, welcome our new feathered overlords.",
        voiceId: "English_Upbeat_Woman",
        emotion: "happy",
      }));
      note(`  audio: ${speechB.audio.length} bytes, ${speechB.durationMs} ms`);
    }
  }

  // ── 4. Music 3.0, a short hook ──────────────────────────────────────────────
  if (want("music")) {
    const music = await timed("Music 3.0 (theme hook)", () => generateMusic({
      lyrics: "[Intro]\n(brass stab, drum fill)\n[Hook]\nInterdimensional Cable, live from every channel\nYour show is on, the hosts are gone, the desk is made of flannel",
      prompt: "Late-night talk show theme, big band brass, upbeat, punchy, 120 bpm, television intro, short",
    }));
    note(`  music: ${music.audio.length} bytes, ${music.durationMs} ms, ${music.localPath}`);
    note(`  probe: ${preview(await probeMedia(music.localPath).then(p => ({ duration: p.durationSeconds, audio: p.hasAudio })))}`);
  }

  // ── 5. Optional: every catalog voice ────────────────────────────────────────
  if (RUN_VOICES) {
    for (const voice of MINIMAX_VOICES) {
      try {
        const r = await synthesizeSpeech({ text: `This is ${voice.label}, reporting for Interdimensional Cable.`, voiceId: voice.id });
        note(`- voice ${voice.id}: ok, ${r.durationMs} ms`);
      } catch (err) {
        note(`- voice ${voice.id}: FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 6. Optional: MiniMax-H3, with and without references ───────────────────
  if (RUN_VIDEO && speechA) {
    const { generateH3Clip, referencePortraitUrls } = await import("../app/lib/gmi/video");
    const { uploadToGmi } = await import("../app/lib/gmi/upload");

    const portrait = await timed("upload portrait", () => referencePortraitUrls("/templates/dual-anchor-desk.jpg"));
    note(`  portrait url: ${preview(portrait, 200)}`);
    const lineUrl = await timed("upload TTS line", () => uploadToGmi(speechA.audio, speechA.format === "mp3" ? "mp3" : "wav"));
    note(`  line url: ${preview(lineUrl, 200)}`);

    const line = "Good evening. Tonight, the pigeons have unionized, and honestly, their demands are reasonable.";
    const basePrompt =
      "A professional late-night talk show segment, single continuous take. [static] A host in a dark suit sits behind a news desk with a large graphic screen behind him, studio lighting, broadcast television production quality. " +
      `The host says, deadpan, to camera: "${line}"`;

    const withRefs = await timed("H3 (a) reference image + reference audio", () => generateH3Clip({
      prompt: `${basePrompt} The host performs exactly the attached spoken line, lips in sync with it. Keep the host's appearance, desk and studio consistent with the reference image.`,
      durationSeconds: 7,
      resolution: "768P",
      referenceImageUrls: portrait,
      referenceAudioUrls: [lineUrl],
    }));
    note(`  (a) ${withRefs.localPath}: ${withRefs.durationSeconds.toFixed(1)} s, audio=${withRefs.hasAudio}, ${withRefs.width}x${withRefs.height}, ${Math.round(withRefs.generationMs / 1000)} s to generate`);

    const plainClip = await timed("H3 (b) no references", () => generateH3Clip({
      prompt: basePrompt,
      durationSeconds: 7,
      resolution: "768P",
    }));
    note(`  (b) ${plainClip.localPath}: ${plainClip.durationSeconds.toFixed(1)} s, audio=${plainClip.hasAudio}, ${plainClip.width}x${plainClip.height}, ${Math.round(plainClip.generationMs / 1000)} s to generate`);
    note("  Listen to both: does (a) speak in the Speech 2.8 voice, and is the mouth in sync? Record the verdict under 'Audio strategy' below.");
  }

  const docPath = path.join(process.cwd(), "DOCS", "gmi-contracts.md");
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.appendFileSync(docPath, `${notes.join("\n")}\n`);
  console.log(`\nObservations appended to ${docPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
