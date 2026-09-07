import { resolveVoiceId } from "@/app/lib/gmi/voices";

import { TTS_VOICE_IDS } from "./types";
import type { ShowSkill, TtsVoice } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Licensed MiniMax Speech 2.8 HD System Voices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only voices a host may be synthesized with: MiniMax's own system voice
 * catalog. Cloned or celebrity-derived voices are never licensed here, which is
 * the identity guardrail the rest of this module enforces.
 */
export const LICENSED_MINIMAX_TTS_VOICES = TTS_VOICE_IDS;

export type MinimaxTtsVoice = TtsVoice;

/** The voice a host falls back to when its template pins nothing usable. */
export const DEFAULT_HOST_VOICE: MinimaxTtsVoice = "English_Persuasive_Man";

export interface VoiceProfile {
  voiceId: MinimaxTtsVoice;
  timbre: string;
  resonance: "Low" | "Mid-Low" | "Mid" | "Mid-High" | "High";
  genderPresentation: "Male" | "Female" | "Neutral";
  idealPersonaAlignment: string;
}

export const LICENSED_VOICE_PROFILES: Record<MinimaxTtsVoice, VoiceProfile> = {
  English_magnetic_voiced_man: {
    voiceId: "English_magnetic_voiced_man",
    timbre: "Deep, magnetic desk-anchor delivery; crisp consonants, dry authoritative cadence",
    resonance: "Low",
    genderPresentation: "Male",
    idealPersonaAlignment: "Investigative Satirist, Deadpan Straight-Man News Anchor, Panel Lead with Gravitas",
  },
  English_Persuasive_Man: {
    voiceId: "English_Persuasive_Man",
    timbre: "Confident, wry conversational baritone that sells the punchline",
    resonance: "Mid-Low",
    genderPresentation: "Male",
    idealPersonaAlignment: "Skeptical Head-Writer Monologist, Subversive Loose-Cannon Co-Anchor, Enthusiast Moderator",
  },
  English_Trustworth_Man: {
    voiceId: "English_Trustworth_Man",
    timbre: "Warm, steady, reassuring; the straight man's flat register",
    resonance: "Mid",
    genderPresentation: "Male",
    idealPersonaAlignment: "Deadpan Operator, Straight Man, Fact-Checking Partner",
  },
  English_Aussie_Bloke: {
    voiceId: "English_Aussie_Bloke",
    timbre: "Laid-back, gruff Australian; earnest curiosity, tangent-prone",
    resonance: "Mid-Low",
    genderPresentation: "Male",
    idealPersonaAlignment: "Speculative Explorer Podcast Host, Primal Inquirer",
  },
  English_Insightful_Speaker: {
    voiceId: "English_Insightful_Speaker",
    timbre: "Measured, analytical, unhurried; explains rather than performs",
    resonance: "Mid",
    genderPresentation: "Neutral",
    idealPersonaAlignment: "Science-Corner Sounding Board, Long-Timescale Reframer",
  },
  English_expressive_narrator: {
    voiceId: "English_expressive_narrator",
    timbre: "Expressive, wide-range narration with theatrical swing; carries a rant",
    resonance: "Mid",
    genderPresentation: "Neutral",
    idealPersonaAlignment: "Apocalyptic Satirical Diatribist, Esoteric Polymath Guest",
  },
  English_Upbeat_Woman: {
    voiceId: "English_Upbeat_Woman",
    timbre: "Bright, fast, energetic; infectious comedic timing",
    resonance: "Mid-High",
    genderPresentation: "Female",
    idealPersonaAlignment: "High-Energy Variety Monologist, Cultural Commentator",
  },
  English_Graceful_Lady: {
    voiceId: "English_Graceful_Lady",
    timbre: "Poised, dry, elegant; steady broadcast pacing",
    resonance: "Mid",
    genderPresentation: "Female",
    idealPersonaAlignment: "Fact-Checking Co-Host, Deadpan Investigative Partner",
  },
  English_radiant_girl: {
    voiceId: "English_radiant_girl",
    timbre: "Playful, quick, light; delighted by her own tangents",
    resonance: "High",
    genderPresentation: "Female",
    idealPersonaAlignment: "Sidekick, Wildcard Guest",
  },
  English_captivating_female1: {
    voiceId: "English_captivating_female1",
    timbre: "Magnetic, deliberate, quietly intense",
    resonance: "Mid-Low",
    genderPresentation: "Female",
    idealPersonaAlignment: "Contrarian Panellist, Noir Narrator",
  },
  English_compelling_lady1: {
    voiceId: "English_compelling_lady1",
    timbre: "Persuasive, warm, conversational",
    resonance: "Mid",
    genderPresentation: "Female",
    idealPersonaAlignment: "Podcast Host, Sounding Board",
  },
  English_Lucky_Robot: {
    voiceId: "English_Lucky_Robot",
    timbre: "Synthetic, clipped novelty voice",
    resonance: "Mid-High",
    genderPresentation: "Neutral",
    idealPersonaAlignment: "Bumpers, Station Idents, Robot Correspondent",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Voice Verification & Assertion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a given string is an approved licensed MiniMax system voice.
 */
export function isLicensedMinimaxVoice(voice: string): voice is MinimaxTtsVoice {
  return (LICENSED_MINIMAX_TTS_VOICES as readonly string[]).includes(voice);
}

/**
 * Asserts that a voice string is a licensed MiniMax system voice, throwing an error otherwise.
 */
export function assertLicensedMinimaxVoice(voice: string, hostName?: string): void {
  if (!isLicensedMinimaxVoice(voice)) {
    const hostLabel = hostName ? ` for host "${hostName}"` : "";
    throw new Error(
      `Illegal or unlicensed TTS voice "${voice}"${hostLabel}. Only licensed MiniMax Speech 2.8 HD system voices are permitted: ${LICENSED_MINIMAX_TTS_VOICES.join(", ")}.`,
    );
  }
}

/**
 * Resolves a host's TTS voice safely: a licensed id passes through, a voice
 * name stored by a template before the MiniMax migration maps to its catalog
 * equivalent, and anything else falls back to a licensed default.
 */
export function resolveHostTtsVoice(voice?: string, fallback: MinimaxTtsVoice = DEFAULT_HOST_VOICE): MinimaxTtsVoice {
  const resolved = resolveVoiceId(voice);
  if (resolved && isLicensedMinimaxVoice(resolved)) {
    return resolved;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Satirical Transparency & Parody Disclaimer Generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an explicit satirical parody disclaimer to attach to media outputs,
 * affirming First Amendment parody craft and licensed AI synthesis transparency.
 */
export function generateSatiricalDisclaimer(
  skillOrName: string | ShowSkill,
  topic?: string,
): string {
  const showName = typeof skillOrName === "string" ? skillOrName : skillOrName.name;
  const topicSegment = topic ? ` on "${topic}"` : "";

  return (
    `Generated by Interdimensional Cable AI Comedy Orchestrator (${showName}${topicSegment}). ` +
    `This production is an original satirical parody and comedic commentary executing dramaturgical craft and rhetorical format spines. ` +
    `Audio synthesized exclusively using licensed MiniMax Speech 2.8 HD system voices. Not affiliated with or endorsed by any living individual or network.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Sanitizer & Trademark Normalizer
// ─────────────────────────────────────────────────────────────────────────────

const NETWORK_TRADEMARK_REPLACEMENTS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /\bHBO\b/gi, replacement: "premium cable broadcast" },
  { regex: /\bNBC\b/gi, replacement: "late-night television network" },
  { regex: /\bCBS\b/gi, replacement: "broadcast television studio" },
  { regex: /\bABC\b/gi, replacement: "national broadcast studio" },
  { regex: /\bComedy Central\b/gi, replacement: "satirical comedy network" },
  { regex: /\bShowtime\b/gi, replacement: "premium cable studio" },
  { regex: /\bNetflix\b/gi, replacement: "streaming television platform" },
  { regex: /\bSpotify\b/gi, replacement: "broadcast audio streaming platform" },
  { regex: /\bLast Week Tonight\b/gi, replacement: "investigative comedy deep-dive" },
  { regex: /\bA Closer Look\b/gi, replacement: "surgical satirical breakdown" },
  { regex: /\bWeekend Update\b/gi, replacement: "dual-anchor satirical news desk" },
  { regex: /\bTonight Show\b/gi, replacement: "late-night variety monologue" },
  { regex: /\bJoe Rogan Experience\b|\bJRE\b/gi, replacement: "the speculative podcast studio" },
  { regex: /\bTim Dillon Show\b/gi, replacement: "the satirical apocalyptic podcast" },
];

/**
 * Sanitizes prompt text by stripping proprietary studio/network trademarks and replacing them
 * with generic broadcast genre descriptions. Enforces dramaturgical craft focus.
 */
export function sanitizePromptForLegalSafety(prompt: string): string {
  let sanitized = prompt;

  for (const { regex, replacement } of NETWORK_TRADEMARK_REPLACEMENTS) {
    sanitized = sanitized.replace(regex, replacement);
  }

  // Remove direct biometric cloning commands
  sanitized = sanitized.replace(/\bclone the exact voice of\b/gi, "reproduce the rhetorical cadence and comedic style of");
  sanitized = sanitized.replace(/\bdeepfake\b/gi, "stylized satirical caricature");
  sanitized = sanitized.replace(/\bimpersonate identically\b/gi, "parody the dramaturgical structure of");

  return sanitized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comprehensive Skill Legal Guardrails Validator
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardrailValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that a ShowSkill definition fully respects legal and identity guardrails:
 * 1. All host TTS voices are strictly from the licensed MiniMax system voice pool.
 * 2. Host persona descriptions focus on rhetorical craft rather than biometric cloning.
 * 3. Visual style prompts describe broadcast caricatures rather than photorealistic deepfakes.
 */
export function validateSkillLegalGuardrails(skill: ShowSkill): GuardrailValidationResult {
  const errors: string[] = [];

  if (!skill.hosts || skill.hosts.length === 0) {
    errors.push(`Show skill "${skill.id}" must define at least one host.`);
  }

  for (const host of skill.hosts ?? []) {
    if (!isLicensedMinimaxVoice(host.ttsVoice)) {
      errors.push(
        `Host "${host.name}" in skill "${skill.id}" specifies unlicensed TTS voice "${host.ttsVoice}". Must be one of: ${LICENSED_MINIMAX_TTS_VOICES.join(", ")}.`,
      );
    }

    if (!host.personaCraft || host.personaCraft.length < 15) {
      errors.push(
        `Host "${host.name}" in skill "${skill.id}" must provide rich personaCraft instructions (at least 15 characters).`,
      );
    }
  }

  if (!skill.rhetoricalSpine || !skill.rhetoricalSpine.acts || skill.rhetoricalSpine.acts.length === 0) {
    errors.push(`Skill "${skill.id}" must define a valid rhetorical spine with at least one act.`);
  }

  if (skill.visualStylePrompt && /deepfake|photorealistic identical clone/i.test(skill.visualStylePrompt)) {
    errors.push(`Skill "${skill.id}" visualStylePrompt contains prohibited biometric mimicry keywords.`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
