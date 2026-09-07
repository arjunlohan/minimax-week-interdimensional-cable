/**
 * MiniMax Speech 2.8 voice catalog used by the show pipeline.
 *
 * Ids come from MiniMax's system voice list and GMI Cloud's quickstart. Every
 * id here is probed once by `scripts/gmi-smoke.ts`; drop any the platform
 * rejects rather than letting a show fail on its first line.
 */

export type VoiceGender = "masculine" | "feminine" | "neutral";

export interface VoiceProfile {
  id: string;
  label: string;
  gender: VoiceGender;
  /** How it reads, for choosing a host voice. */
  style: string;
}

export const MINIMAX_VOICES: readonly VoiceProfile[] = [
  { id: "English_magnetic_voiced_man", label: "Magnetic Man", gender: "masculine", style: "deep, authoritative desk anchor" },
  { id: "English_Persuasive_Man", label: "Persuasive Man", gender: "masculine", style: "confident, wry, sells the joke" },
  { id: "English_Trustworth_Man", label: "Trustworthy Man", gender: "masculine", style: "warm, steady, the straight man" },
  { id: "English_Aussie_Bloke", label: "Aussie Bloke", gender: "masculine", style: "laid-back, gruff, tangent-prone" },
  { id: "English_Insightful_Speaker", label: "Insightful Speaker", gender: "neutral", style: "measured, analytical" },
  { id: "English_expressive_narrator", label: "Expressive Narrator", gender: "neutral", style: "expressive narrator, the GMI default" },
  { id: "English_Upbeat_Woman", label: "Upbeat Woman", gender: "feminine", style: "bright, fast, energetic" },
  { id: "English_Graceful_Lady", label: "Graceful Lady", gender: "feminine", style: "poised, dry, elegant" },
  { id: "English_radiant_girl", label: "Radiant Girl", gender: "feminine", style: "playful, quick" },
  { id: "English_captivating_female1", label: "Captivating Woman", gender: "feminine", style: "magnetic, deliberate" },
  { id: "English_compelling_lady1", label: "Compelling Lady", gender: "feminine", style: "persuasive, warm" },
  { id: "English_Lucky_Robot", label: "Lucky Robot", gender: "neutral", style: "robotic novelty, for bumpers" },
];

export const DEFAULT_VOICE_ID = "English_expressive_narrator";

export const MASCULINE_VOICE_IDS = MINIMAX_VOICES.filter(v => v.gender === "masculine").map(v => v.id);
export const FEMININE_VOICE_IDS = MINIMAX_VOICES.filter(v => v.gender === "feminine").map(v => v.id);
export const FALLBACK_VOICE_IDS = [
  "English_magnetic_voiced_man",
  "English_Upbeat_Woman",
  "English_Persuasive_Man",
  "English_Graceful_Lady",
  "English_Trustworth_Man",
  "English_radiant_girl",
  "English_Aussie_Bloke",
];

/**
 * Voice names from the previous engine still live in stored templates and in
 * shows generated before the migration. Map them to MiniMax equivalents so
 * those rows keep resolving a voice.
 */
export const LEGACY_VOICE_ALIASES: Record<string, string> = {
  Charon: "English_magnetic_voiced_man",
  Orus: "English_Persuasive_Man",
  Puck: "English_Trustworth_Man",
  Fenrir: "English_Aussie_Bloke",
  Enceladus: "English_expressive_narrator",
  Iapetus: "English_Insightful_Speaker",
  Algieba: "English_Trustworth_Man",
  Rasalgethi: "English_Persuasive_Man",
  Achird: "English_magnetic_voiced_man",
  Aoede: "English_Upbeat_Woman",
  Kore: "English_Graceful_Lady",
  Leda: "English_radiant_girl",
  Zephyr: "English_captivating_female1",
  Callirrhoe: "English_compelling_lady1",
  Autonoe: "English_Graceful_Lady",
  Despina: "English_Upbeat_Woman",
  Erinome: "English_radiant_girl",
  Sulafat: "English_captivating_female1",
};

export function isKnownVoiceId(id: string): boolean {
  return MINIMAX_VOICES.some(v => v.id === id);
}

/** A MiniMax voice id for a stored voice name, or undefined when unknown. */
export function resolveVoiceId(name: string | null | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (isKnownVoiceId(name)) {
    return name;
  }
  return LEGACY_VOICE_ALIASES[name];
}

export function voiceProfile(id: string): VoiceProfile | undefined {
  return MINIMAX_VOICES.find(v => v.id === id);
}
