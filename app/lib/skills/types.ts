// ─────────────────────────────────────────────────────────────────────────────
// Core Enums & Primitive Types
// ─────────────────────────────────────────────────────────────────────────────

export type ShowArchetype = "writers_room_desk" | "conversational_podcast";

export type ShowFormat = "monologue" | "conversation";

export type ProfanityRegister = "clean" | "mild" | "frequent" | "explicit";

export type SentenceCadence =
  | "staccato_snappy" |
  "rolling_breathless" |
  "conversational_riff" |
  "academic_deadpan";

/**
 * MiniMax Speech 2.8 HD system voices a host may pin. Mirrors the catalog in
 * `app/lib/gmi/voices.ts` (asserted equal by the skills tests) so a template
 * can never name a voice the synthesis layer would reject.
 */
export const TTS_VOICE_IDS = [
  "English_magnetic_voiced_man",
  "English_Persuasive_Man",
  "English_Trustworth_Man",
  "English_Aussie_Bloke",
  "English_Insightful_Speaker",
  "English_expressive_narrator",
  "English_Upbeat_Woman",
  "English_Graceful_Lady",
  "English_radiant_girl",
  "English_captivating_female1",
  "English_compelling_lady1",
  "English_Lucky_Robot",
] as const;

export type TtsVoice = typeof TTS_VOICE_IDS[number];

export type HostRole =
  | "anchor" |
  "co-host" |
  "guest" |
  "sidekick" |
  "lead_host" |
  "guest_theorist" |
  "co_host_sounding_board" |
  "straight_man" |
  "wildcard";

export type HostPosition = "left" | "right" | "center" | "far_left" | "far_right";

export type TurnType =
  | "inquiry" |
  "speculative_riff" |
  "diatribe" |
  "ping_pong" |
  "backchannel" |
  "tangent_pivot" |
  "snapback";

// ─────────────────────────────────────────────────────────────────────────────
// Host Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface HostSkillConfig {
  name: string;
  role: HostRole;
  position: HostPosition;
  ttsVoice: TtsVoice;
  personaCraft: string;
  personality?: string;
  catchphrases: string[];
  speakingRateWpm: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comedic & Rhetorical Spines (Archetype A & Base)
// ─────────────────────────────────────────────────────────────────────────────

export interface RhetoricalAct {
  id: string;
  name: string;
  targetDurationFraction: number;
  purpose: string;
  comedicFormulas: string[];
  promptGuidance: string;
  requiredElements?: Array<
    | "thesis_setup" |
    "grounded_fact" |
    "escalating_analogy" |
    "rule_of_three" |
    "tag" |
    "callback" |
    "act_out" |
    "call_to_action"
  >;
}

export interface LaughPerMinuteTarget {
  min: number;
  max: number;
}

export interface RhetoricalSpine {
  acts: RhetoricalAct[];
  laughPerMinuteTarget: LaughPerMinuteTarget;
  ruleOfThreeProbability: number;
  callbackTargetCount: number;
  wordBudgetPerSecond: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice Mechanics & Stylometrics
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceMechanics {
  meanSentenceLengthWords: number;
  profanityRegister: ProfanityRegister;
  outrageAffabilityRatio: number; // 0.0 (affable) to 1.0 (outrage)
  cynicismVsOptimismRatio: number; // 0.0 (optimistic) to 1.0 (cynical)
  catchphrases: string[];
  lexicalIdiosyncrasies: string[];
  punchlinePositionRule: "end_of_sentence";
  sentenceCadence?: SentenceCadence;
  signatureConnectors?: string[];
  ttsVoice?: TtsVoice;
  acousticCuePreferences?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Talking Point Tree & Tangent Drift (Archetype B)
// ─────────────────────────────────────────────────────────────────────────────

export interface TalkingPointNode {
  id: string;
  title: string;
  premise: string;
  groundedFacts: string[];
  incongruityAngle: string;
  associativeKeywords: string[];
  suggestedSpeakerRole?: HostRole;
  tangentBranches?: string[];
}

export interface TangentDriftConfig {
  driftProbability: number;
  maxDriftDepthTurns: number;
  backchannelProbability: number;
  snapbackPhrases: string[];
  thematicAnchors: string[];
  turnLengthWeights: {
    backchannel: number;
    pingPong: number;
    speculativeRiff: number;
    diatribe: number;
  };
}

export interface PodcastDynamics {
  talkingPointTree: TalkingPointNode[];
  driftConfig: TangentDriftConfig;
  targetLpm: LaughPerMinuteTarget;
  acousticTagSet: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Master ShowSkill Model
// ─────────────────────────────────────────────────────────────────────────────

export interface ShowSkill {
  id: string;
  slug: string;
  name: string;
  archetype: ShowArchetype;
  showType: ShowFormat;
  description: string;
  referenceImageUrl?: string;
  rhetoricalSpine: RhetoricalSpine;
  voiceMechanics: VoiceMechanics;
  hosts: HostSkillConfig[];
  podcastDynamics?: PodcastDynamics;
  visualStylePrompt: string;
  notes?: string;
  isDefault?: boolean;
  /** Catalogue rank. Lower sorts first. */
  displayOrder?: number;
  aliases?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripting Execution Structures
// ─────────────────────────────────────────────────────────────────────────────

export interface ClipWordBudget {
  clipIndex: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  durationSeconds: number;
  targetWordsMin: number;
  targetWordsMax: number;
  assignedActId: string;
  actName: string;
}

export interface PodcastTurnSegment {
  speaker: string;
  role: HostRole;
  text: string;
  turnType: TurnType;
  isTangent?: boolean;
  nodeId?: string;
  durationSeconds: number;
}
