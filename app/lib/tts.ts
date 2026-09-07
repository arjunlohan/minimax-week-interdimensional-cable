/* eslint-disable no-console */
import { Buffer } from "node:buffer";

import { z } from "zod";

import { synthesizeSpeechWav } from "@/app/lib/gmi/speech";
import type { SpeechEmotion } from "@/app/lib/gmi/speech";
import { generateJson } from "@/app/lib/gmi/text";
import { FALLBACK_VOICE_IDS, FEMININE_VOICE_IDS, MASCULINE_VOICE_IDS, resolveVoiceId } from "@/app/lib/gmi/voices";

import { listShowSkills } from "./skills/registry";

/**
 * Speech for the show pipeline on MiniMax Speech 2.8 HD, through GMI Cloud.
 *
 * The model voices one speaker per request and takes no free-text delivery
 * prompt, so this module does three things the previous multi-speaker call did
 * on its own: it splits dialogue into turns, picks a catalog voice per host,
 * and turns the script's acting directions into the model's emotion parameter.
 * Every function returns 24 kHz 16-bit mono WAV, so concatenation, duration
 * measurement and upload downstream are unchanged.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Hosts and voices
// ─────────────────────────────────────────────────────────────────────────────

export type TtsHost =
  | string |
  {
    name: string;
    ttsVoice?: string;
    voice?: string;
    role?: string;
    position?: string;
    personality?: string;
    personaCraft?: string;
    speakingRateWpm?: number;
  };

/**
 * Speakers one Speech 2.8 HD request can voice. MiniMax has no multi-speaker
 * call, so any wider cast is synthesized a turn at a time and concatenated.
 */
export const MAX_MULTI_SPEAKER_VOICES = 1;

/**
 * Hosts renamed when the parody names were introduced. Shows generated before
 * the rename still carry the old names, so they keep resolving a voice.
 */
const LEGACY_HOST_NAMES: Record<string, string> = {
  "John Oliver": "John Olive",
  "Seth Meyers": "Seth Mires",
  "Colin Jost": "Colin Jest",
  "Michael Che": "Michael Chey",
};

/**
 * The voice each registered host pins, by name. Derived from the skill
 * registry rather than copied, so what a bare host name resolves to cannot
 * drift from the template that defines the host.
 */
const REGISTRY_VOICES = new Map<string, string>(
  listShowSkills().flatMap(skill => skill.hosts.map(host => [host.name, host.ttsVoice] as const)),
);

function voiceForName(name: string): string | undefined {
  return REGISTRY_VOICES.get(name) ?? REGISTRY_VOICES.get(LEGACY_HOST_NAMES[name] ?? "");
}

function hostName(host: TtsHost): string {
  return typeof host === "string" ? host : host.name;
}

function hostProfileText(host: TtsHost): string {
  if (typeof host === "string") {
    return host;
  }
  return [host.name, host.role, host.position, host.personality, host.personaCraft].filter(Boolean).join(" ");
}

// Pronouns are the only reliable signal. Role nouns like "comedian", "host", or
// "journalist" are gender-neutral and previously mis-sexed hosts described with
// "she" simply because the noun appeared earlier in the sentence.
const FEMININE_PRONOUNS = /\b(?:she|her|hers)\b/i;
const MASCULINE_PRONOUNS = /\b(?:he|him|his)\b/i;
const FEMININE_NOUNS = /\b(?:woman|female|actress|comedienne|hostess)\b/i;
const MASCULINE_NOUNS = /\b(?:man|male|actor)\b/i;

/** Infers the perceived gender of a host from the template's description. */
export function inferHostGender(host: TtsHost): "feminine" | "masculine" | "unknown" {
  const text = hostProfileText(host);

  // Pronouns win outright when only one set is present.
  const femPro = FEMININE_PRONOUNS.test(text);
  const mascPro = MASCULINE_PRONOUNS.test(text);
  if (femPro !== mascPro) {
    return femPro ? "feminine" : "masculine";
  }

  // No pronouns (or genuinely mixed): fall back to explicitly gendered nouns.
  const femNoun = FEMININE_NOUNS.test(text);
  const mascNoun = MASCULINE_NOUNS.test(text);
  if (femNoun !== mascNoun) {
    return femNoun ? "feminine" : "masculine";
  }

  return "unknown";
}

const ACCENT_PATTERNS: Array<{ match: RegExp; accent: string }> = [
  { match: /\b(british|english|uk|london|england|welsh)\b/i, accent: "British English" },
  { match: /\b(irish|ireland|dublin)\b/i, accent: "Irish English" },
  { match: /\b(scottish|scotland|glasgow)\b/i, accent: "Scottish English" },
  { match: /\b(australian|australia|aussie)\b/i, accent: "Australian English" },
  { match: /\b(canadian|canada)\b/i, accent: "Canadian English" },
  { match: /\b(indian|india|mumbai|delhi)\b/i, accent: "Indian English" },
  { match: /\b(south african)\b/i, accent: "South African English" },
];

/** Infers the host's accent from the template description; defaults to American. */
export function inferHostAccent(host: TtsHost): string {
  const text = hostProfileText(host);
  for (const { match, accent } of ACCENT_PATTERNS) {
    if (match.test(text)) {
      return accent;
    }
  }
  return "American English";
}

/**
 * The delivery cue a host's own description implies. Speech 2.8 HD takes no
 * free-text delivery prompt, so this is never sent to the model: the accent it
 * infers collapses to `languageBoost: "English"` and the pace to
 * `speedForHost` at synthesis time. It remains the human-readable summary of
 * how a host is meant to read, used by the verification script and the tests.
 */
export function deliveryStyleForHost(host: TtsHost): string | undefined {
  const accent = inferHostAccent(host);
  const name = typeof host === "string" ? host : host.name ?? "";
  const personality = typeof host === "string" ? "" : (host.personality ?? "");

  // Compress the persona prose into a short delivery cue; the full personality
  // is already baked into the script itself.
  const cue = personality
    .split(/[.!?]/)
    .map(t => t.trim())
    .filter(t => t.length > 12)
    .slice(0, 2)
    .join(". ");

  const who = name ? `as ${name}` : "as the host";
  return cue ?
    `Read in a ${accent} accent, ${who}. Delivery notes: ${cue}` :
    `Read in a ${accent} accent, ${who}, with natural late-night comedic timing`;
}

// Pace cues only: "rapid-fire tags" describes a joke rhythm, not a talker.
const FAST_TALKER = /\b(?:fast[- ]talk\w*|fastest talker|breathless|high[- ]velocity|manic|motor[- ]?mouth|machine[- ]gun)\b/i;
const FAST_TALKER_WPM = 165;

/**
 * Playback speed for a host: 1.1 for the fast talkers, by declared words per
 * minute or by description, otherwise undefined so the model keeps its default.
 */
export function speedForHost(host: TtsHost): number | undefined {
  const wpm = typeof host === "string" ? undefined : host.speakingRateWpm;
  if ((wpm !== undefined && wpm >= FAST_TALKER_WPM) || FAST_TALKER.test(hostProfileText(host))) {
    return 1.1;
  }
  return undefined;
}

/**
 * The catalog voice for a host: an explicit `ttsVoice` or `voice` (a catalog
 * id, or a legacy name that maps to one), then the voice the registry pins on
 * that host name, then a pool chosen by the gender the description implies,
 * then the round-robin fallbacks. `index` is the host's seat in the cast, so
 * an unpinned cast still gets distinct voices.
 */
export function voiceForHost(host: TtsHost | string, index = 0): string {
  if (typeof host === "string") {
    return voiceForName(host) ?? FALLBACK_VOICE_IDS[index % FALLBACK_VOICE_IDS.length];
  }

  const explicit = resolveVoiceId(host.ttsVoice) ?? resolveVoiceId(host.voice);
  if (explicit) {
    return explicit;
  }

  const known = voiceForName(host.name ?? "");
  if (known) {
    return known;
  }

  const gender = inferHostGender(host);
  if (gender === "feminine") {
    return FEMININE_VOICE_IDS[index % FEMININE_VOICE_IDS.length];
  }
  if (gender === "masculine") {
    return MASCULINE_VOICE_IDS[index % MASCULINE_VOICE_IDS.length];
  }
  return FALLBACK_VOICE_IDS[index % FALLBACK_VOICE_IDS.length];
}

/** Test seam: the resolver is internal, but its behaviour is worth asserting. */
export function voiceForHostPublic(host: TtsHost, index: number): string {
  return voiceForHost(host, index);
}

// ─────────────────────────────────────────────────────────────────────────────
// WAV encoding (24 kHz, 16-bit, mono)
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);

export function encodePcmToWav(pcm: Buffer): Buffer {
  const byteRate = BYTES_PER_SECOND;
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + headerSize - 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * The PCM payload of a WAV buffer. `synthesizeSpeechWav` converts through
 * ffmpeg, which writes a LIST chunk ahead of the samples, so the header is not
 * a fixed 44 bytes and has to be walked. Throws when the format is not the
 * 24 kHz mono 16-bit the pipeline concatenates, rather than silently producing
 * audio at the wrong pitch.
 */
function pcmFromWav(wav: Buffer, context: string): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${context}: expected a WAV buffer, got ${wav.length} bytes`);
  }

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= wav.length) {
      const channels = wav.readUInt16LE(body + 2);
      const sampleRate = wav.readUInt32LE(body + 4);
      const bits = wav.readUInt16LE(body + 14);
      if (channels !== CHANNELS || sampleRate !== SAMPLE_RATE || bits !== BITS_PER_SAMPLE) {
        throw new Error(
          `${context}: expected ${SAMPLE_RATE} Hz ${BITS_PER_SAMPLE}-bit mono WAV, got ${sampleRate} Hz ${bits}-bit ${channels}-channel`,
        );
      }
    } else if (id === "data") {
      // A streamed WAV can declare size 0; fall back to what is actually present.
      const available = wav.length - body;
      const dataSize = size > 0 ? Math.min(size, available) : available;
      return wav.subarray(body, body + dataSize);
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  throw new Error(`${context}: WAV has no data chunk`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Acting directions and emotion
// ─────────────────────────────────────────────────────────────────────────────

/** Bracketed stage directions the writers' room leaves inline: "[laughs]". */
const INLINE_TAG = /\[[^\]\n]{1,40}\]/g;

/**
 * Removes inline stage directions from text about to be spoken. Speech 2.8
 * reads what it is given, so "[laughs]" would be pronounced rather than acted;
 * the tags still steer delivery through `emotionForSegment`.
 */
export function stripAcousticTags(text: string): string {
  return text
    .replace(INLINE_TAG, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

function inlineTags(text: string): string[] {
  return (text.match(INLINE_TAG) ?? []).map(tag => tag.slice(1, -1));
}

// Cue words per Speech 2.8 emotion. The lists are disjoint, so the earliest
// cue in a direction decides.
const EMOTION_CUES: ReadonlyArray<readonly [SpeechEmotion, RegExp]> = [
  ["calm", /\b(?:deadpan|mock[- ]serious|dry|dryly|flat|flatly|calm|calmly|measured|matter[- ]of[- ]fact|understated|monotone|unhurried|composed|serene|soothing|straight[- ]faced|straight man|sober|soberly|gentle|gently|wry|wryly|sarcastic|sardonic|relaxed|laid[- ]back|casual|casually|thoughtful|sigh|sighs|sighing)\b/i],
  ["angry", /\b(?:angry|anger|angrily|outrage|outraged|furious|fury|rage|enraged|rant|rants|ranting|indignant|indignation|exasperated|exasperation|yell|yells|yelling|scream|screams|screaming|shout|shouts|shouting|seething|irate|livid|heated|fuming|apoplectic|bellowing|irritated|annoyed|frustrated|frustration|hostile|aggressive|bitter|snapping)\b/i],
  ["happy", /\b(?:happy|happily|gleeful|glee|gleefully|delighted|delight|delightedly|joyful|joy|joyous|cheerful|cheerfully|cheery|excited|excitedly|excitement|giddy|laugh|laughs|laughing|laughter|chuckle|chuckles|chuckling|giggle|giggles|giggling|snicker|snickers|snickering|wheeze|wheezes|wheezing|cackle|cackles|cackling|upbeat|enthusiastic|enthusiastically|enthusiasm|amused|amusement|playful|playfully|grinning|grin|elated|jubilant|beaming|bubbly|exuberant|ecstatic|thrilled|triumphant|gloating|smug|teasing|mischievous)\b/i],
  ["sad", /\b(?:sad|sadly|sadness|mournful|mourning|somber|sombre|melancholy|melancholic|dejected|glum|wistful|resigned|resignation|defeated|weary|wearily|disappointed|disappointment|heartbroken|grieving|grief|tearful|crying|sobbing|sobs|forlorn|gloomy|morose|downcast|crestfallen|despairing|despair|hopeless)\b/i],
  ["fearful", /\b(?:fearful|fear|afraid|scared|terrified|terror|frightened|nervous|nervously|anxious|anxiously|anxiety|panicked|panic|panicking|trembling|worried|worry|dread|paranoid|paranoia|whisper|whispers|whispering|whispered|hushed|timid|uneasy|jittery|alarmed|spooked|petrified|conspiratorial)\b/i],
  ["disgusted", /\b(?:disgusted|disgust|disgusting|revolted|revulsion|repulsed|grossed out|nauseated|contempt|contemptuous|sneering|sneer|sneers|scoff|scoffs|scoffing|appalled|groan|groans|groaning|gagging|retching|withering|derisive|derision|distaste|loathing|sickened|disdain|disdainful|cringing|cringe|ugh|yuck)\b/i],
  ["surprised", /\b(?:surprised|surprise|shocked|shock|astonished|astonishment|stunned|incredulous|incredulity|disbelief|disbelieving|gasp|gasps|gasping|amazed|amazement|bewildered|baffled|flabbergasted|dumbfounded|startled|aghast|agog|awestruck|awe|wide[- ]eyed|double[- ]take|jaw drops|taken aback|can(?:no|')t believe)\b/i],
];

function earliestCue(text: string): SpeechEmotion | undefined {
  let best: { emotion: SpeechEmotion; index: number } | undefined;
  for (const [emotion, pattern] of EMOTION_CUES) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index)) {
      best = { emotion, index: match.index };
    }
  }
  return best?.emotion;
}

/**
 * Maps a segment's acting direction ("deadpan", "outraged", "mock-serious")
 * and acoustic tags ("[laughs]", "[gasps]") onto the eight emotions Speech 2.8
 * accepts. The direction wins over the tags, and within a direction the first
 * cue wins ("deadpan, then breaking" reads as calm). Anything unrecognised is
 * "auto", which lets the model infer delivery from the words themselves.
 */
export function emotionForSegment(actingDirection?: string, acousticTags?: string[]): SpeechEmotion {
  return earliestCue(actingDirection ?? "") ?? earliestCue((acousticTags ?? []).join(" ")) ?? "auto";
}

// ─────────────────────────────────────────────────────────────────────────────
// Turns
// ─────────────────────────────────────────────────────────────────────────────

/** One spoken line. `{ speaker, text }` is enough; the rest steers delivery. */
export interface TtsTurn {
  speaker: string;
  text: string;
  /** The writers' room's delivery note for the line, e.g. "deadpan". */
  actingDirection?: string;
  /** Stage tags for the line, e.g. ["[laughs]"]. Tags inline in `text` count too. */
  acousticTags?: string[];
  /** An explicit emotion, bypassing `emotionForSegment`. */
  emotion?: SpeechEmotion;
}

// Lines are trimmed before matching; label and text are trimmed after, so no
// whitespace quantifiers are needed (they would overlap and backtrack).
const SPEAKER_LABEL = /^([^:\n]{1,60}):(.*)$/;

/** The cast index a speaker label refers to: full name first, then first name. Minus one when nobody matches. */
function findSeat(names: string[], label: string): number {
  const wanted = label.trim().toLowerCase();
  const exact = names.findIndex(name => name.trim().toLowerCase() === wanted);
  if (exact !== -1) {
    return exact;
  }
  return names.findIndex(name => name.trim().toLowerCase().split(/\s+/)[0] === wanted);
}

function looksLikeSpeakerLabel(label: string): boolean {
  return label.length <= 40 && !/[.!?]/.test(label) && label.split(/\s+/).length <= 4;
}

/**
 * Splits a labelled transcript ("Colin Jest: line") into turns. A label that
 * names a host (full name or first name) starts a turn for that host; a
 * transcript that uses its own labels instead ("Host1:") maps each distinct
 * label onto the cast in order of appearance; unlabelled lines continue the
 * turn before them. Once a host has been named, unknown labels are treated as
 * text, so a line that merely starts with "Look:" does not switch voices.
 */
export function splitTranscriptIntoTurns(transcript: string, hosts: TtsHost[]): TtsTurn[] {
  const names = hosts.map(hostName);
  const turns: TtsTurn[] = [];
  const aliases = new Map<string, string>();
  let sawHostLabel = false;

  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let speaker: string | undefined;
    let text = line;
    const match = SPEAKER_LABEL.exec(line);
    if (match) {
      const label = match[1].trim();
      const seat = findSeat(names, label);
      if (seat !== -1) {
        speaker = names[seat];
        sawHostLabel = true;
      } else {
        const key = label.toLowerCase();
        const aliased = aliases.get(key);
        if (aliased) {
          speaker = aliased;
        } else if (!sawHostLabel && names.length > 0 && looksLikeSpeakerLabel(label)) {
          speaker = names[aliases.size % names.length];
          aliases.set(key, speaker);
        }
      }
      if (speaker) {
        text = match[2].trim();
      }
    }

    const current = turns[turns.length - 1];
    if (speaker) {
      turns.push({ speaker, text });
    } else if (current) {
      current.text = `${current.text}\n${text}`.trim();
    } else {
      turns.push({ speaker: names[0] ?? "", text });
    }
  }

  return turns.filter(turn => turn.text.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation (MiniMax-M3)
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  ja: "Japanese",
  pt: "Portuguese",
};

/** Languages Speech 2.8 accepts as `language_boost`; anything else is "auto". */
const LANGUAGE_BOOSTS = new Set(Object.values(LANGUAGE_NAMES));

function languageName(targetLang?: string): string {
  return targetLang ? (LANGUAGE_NAMES[targetLang] ?? targetLang) : "English";
}

function languageBoostFor(langName: string): string {
  return LANGUAGE_BOOSTS.has(langName) ? langName : "auto";
}

/**
 * Translates a list of lines in one M3 call. The lines go out as a JSON array
 * and come back as one of the same length: the schema enforces the count and
 * the shared JSON helper feeds a mismatch back for a repair round. A ten-turn
 * panel therefore costs one request, and the translator sees the whole
 * conversation while rendering each line.
 */
async function translateLines(lines: string[], langName: string, label: string): Promise<string[]> {
  console.log(`[tts] Translating ${lines.length} lines to ${langName}`);
  return generateJson({
    schema: z.array(z.string()).length(lines.length),
    label,
    system:
      "You translate late-night comedy scripts for dubbing. Keep the jokes, the register and the rhythm. " +
      "Keep names, any speaker label at the start of a line (\"Name:\"), and bracketed stage directions such as [laughs] exactly as written.",
    prompt:
      `Translate each line of this talk show script to ${langName}. ` +
      `Return a JSON array of exactly ${lines.length} strings: the translated lines, in the same order, nothing else.\n\n${
        JSON.stringify(lines)}`,
    temperature: 0.3,
  });
}

/** Translates a whole transcript paragraph by paragraph, preserving its layout. */
async function translateTranscript(transcript: string, langName: string): Promise<string> {
  const paragraphs = transcript.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    return transcript;
  }
  const translated = await translateLines(paragraphs, langName, "tts-translate-transcript");
  return translated.join("\n\n");
}

/**
 * Translates every turn of a script in a single model call, keeping speakers
 * and delivery notes attached to their lines. English is returned untouched.
 */
export async function translateTurns<T extends TtsTurn>(turns: T[], targetLang: string): Promise<T[]> {
  const langName = languageName(targetLang);
  if (langName === "English" || turns.length === 0) {
    return turns;
  }
  const translated = await translateLines(turns.map(turn => turn.text), langName, "tts-translate-turns");
  return turns.map((turn, i) => ({ ...turn, text: translated[i] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis (MiniMax Speech 2.8 HD)
// ─────────────────────────────────────────────────────────────────────────────

interface SpokenLine {
  host: TtsHost;
  /** The host's seat in the cast, for distinct fallback voices. */
  seat: number;
  text: string;
  emotion: SpeechEmotion;
  langName: string;
}

/** One request for one speaker. Returns raw PCM (24 kHz, 16-bit, mono); empty for a line with nothing to say. */
async function speakLine(line: SpokenLine): Promise<Buffer> {
  const text = stripAcousticTags(line.text);
  if (!text) {
    return Buffer.alloc(0);
  }

  const voiceId = voiceForHost(line.host, line.seat);
  const speed = speedForHost(line.host);
  const { wav } = await synthesizeSpeechWav({
    text,
    voiceId,
    emotion: line.emotion,
    speed,
    languageBoost: languageBoostFor(line.langName),
  });

  const pcm = pcmFromWav(wav, `Speech 2.8 HD (${voiceId})`);
  if (pcm.length === 0) {
    throw new Error(`MiniMax Speech 2.8 HD returned no audio for ${hostName(line.host)} (${voiceId})`);
  }

  const notes = [line.emotion !== "auto" ? line.emotion : "", speed ? `x${speed}` : ""].filter(Boolean).join(", ");
  console.log(`[tts] ${hostName(line.host)} (${voiceId}${notes ? `, ${notes}` : ""}): ${(pcm.length / BYTES_PER_SECOND).toFixed(2)}s`);
  return pcm;
}

/** Requests in flight at once for per-turn synthesis; the client already backs off on 429s. */
const PER_TURN_CONCURRENCY = 4;

/** Maps in order with at most `limit` promises in flight, so a forty-turn podcast is not forty serial round trips. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Voices a script a turn at a time: one Speech 2.8 HD request per line, in
 * that speaker's voice and emotion, with the PCM concatenated. Also yields an
 * exact duration per turn, measured from the audio that came back rather than
 * estimated, which is what keeps transcript highlighting in sync.
 *
 * With `targetLang`, the turns are translated first, in one batch.
 */
export async function generateTtsPerTurn(
  turns: TtsTurn[],
  hosts: TtsHost[],
  targetLang?: string,
): Promise<{ wav: Buffer; durations: number[] }> {
  const langName = languageName(targetLang);
  const spoken = targetLang && langName !== "English" ? await translateTurns(turns, targetLang) : turns;
  const names = hosts.map(hostName);
  console.log(`[tts] Synthesizing ${spoken.length} turns for ${names.join(", ") || "an unnamed host"} (${langName})`);

  const chunks = await mapWithConcurrency(spoken, PER_TURN_CONCURRENCY, (turn) => {
    const seat = Math.max(0, findSeat(names, turn.speaker));
    const host = hosts[seat] ?? turn.speaker;
    const emotion = turn.emotion ?? emotionForSegment(turn.actingDirection, [...(turn.acousticTags ?? []), ...inlineTags(turn.text)]);
    return speakLine({ host, seat, text: turn.text, emotion, langName });
  });

  return {
    wav: encodePcmToWav(Buffer.concat(chunks)),
    durations: chunks.map(chunk => chunk.length / BYTES_PER_SECOND),
  };
}

/**
 * Generates speech for a transcript and returns 24 kHz 16-bit mono WAV.
 *
 * One host is voiced in a single request. A wider cast is split on the
 * transcript's "Speaker: line" labels and voiced a turn at a time, because
 * Speech 2.8 HD has no multi-speaker call. With `targetLang`, MiniMax-M3
 * translates the text first.
 */
export async function generateTts(
  transcript: string,
  hosts: TtsHost[],
  targetLang?: string,
): Promise<Buffer> {
  const langName = languageName(targetLang);
  console.log("[tts] generateTts: transcript length", transcript.length, "hosts:", hosts.map(hostName), "lang:", langName);

  if (hosts.length > MAX_MULTI_SPEAKER_VOICES) {
    const { wav } = await generateTtsPerTurn(splitTranscriptIntoTurns(transcript, hosts), hosts, targetLang);
    return wav;
  }

  // Only translate when actually changing language; en -> en is a wasted call
  // and an unnecessary failure point on the generation critical path.
  const text = targetLang && langName !== "English" ? await translateTranscript(transcript, langName) : transcript;
  const pcm = await speakLine({ host: hosts[0] ?? "", seat: 0, text, emotion: "auto", langName });
  return encodePcmToWav(pcm);
}

/**
 * Synthesizes a whole episode. A cast wider than one request can voice is
 * spoken from its per-turn breakdown (translation batched once, then a request
 * per turn); otherwise the transcript goes out as one request, which gives a
 * monologue the most natural continuity. Without turns, a wide cast falls back
 * to splitting the transcript on its speaker labels.
 */
export async function generateShowAudio(
  transcript: string,
  hosts: TtsHost[],
  turns?: TtsTurn[],
  targetLang?: string,
): Promise<Buffer> {
  if (hosts.length > MAX_MULTI_SPEAKER_VOICES && turns && turns.length > 0) {
    const { wav } = await generateTtsPerTurn(turns, hosts, targetLang);
    return wav;
  }
  return generateTts(transcript, hosts, targetLang);
}

/**
 * A short spoken clip for one host (chat replies, on-demand tangents), as a
 * base64 data URI ("data:audio/wav;base64,...").
 */
export async function generateSingleVoiceClip(
  text: string,
  hostOrName: string | TtsHost = "John Olive",
): Promise<string> {
  const host: TtsHost = typeof hostOrName === "string" ? { name: hostOrName } : hostOrName;
  const wav = await generateTts(text, [host]);
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}
