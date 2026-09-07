import { z } from "zod";

import { TTS_VOICE_IDS } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Core Enums & Primitive Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const ShowArchetypeSchema = z.enum([
  "writers_room_desk",
  "conversational_podcast",
]);

export const ShowFormatSchema = z.enum(["monologue", "conversation"]);

export const ProfanityRegisterSchema = z.enum([
  "clean",
  "mild",
  "frequent",
  "explicit",
]);

export const SentenceCadenceSchema = z.enum([
  "staccato_snappy",
  "rolling_breathless",
  "conversational_riff",
  "academic_deadpan",
]);

// MiniMax Speech 2.8 HD system voice ids; the list lives with the types so the
// schema and the TtsVoice union cannot disagree.
export const TtsVoiceSchema = z.enum(TTS_VOICE_IDS);

export const HostRoleSchema = z.enum([
  "anchor",
  "co-host",
  "guest",
  "sidekick",
  "lead_host",
  "guest_theorist",
  "co_host_sounding_board",
  "straight_man",
  "wildcard",
]);

// far_left / far_right accommodate a four-seat panel.
export const HostPositionSchema = z.enum(["left", "right", "center", "far_left", "far_right"]);

export const TurnTypeSchema = z.enum([
  "inquiry",
  "speculative_riff",
  "diatribe",
  "ping_pong",
  "backchannel",
  "tangent_pivot",
  "snapback",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Host Configuration Schema
// ─────────────────────────────────────────────────────────────────────────────

export const HostSkillConfigSchema = z.object({
  name: z.string().min(1),
  role: HostRoleSchema,
  position: HostPositionSchema.default("center"),
  ttsVoice: TtsVoiceSchema,
  personaCraft: z.string().min(10),
  personality: z.string().optional(),
  catchphrases: z.array(z.string()).default([]),
  speakingRateWpm: z.number().int().min(80).max(240).default(150),
});

// ─────────────────────────────────────────────────────────────────────────────
// Comedic & Rhetorical Spines Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const RhetoricalActSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  targetDurationFraction: z.number().min(0.05).max(0.95),
  purpose: z.string().min(10),
  comedicFormulas: z.array(z.string()).min(1),
  promptGuidance: z.string().min(10),
  requiredElements: z
    .array(
      z.enum([
        "thesis_setup",
        "grounded_fact",
        "escalating_analogy",
        "rule_of_three",
        "tag",
        "callback",
        "act_out",
        "call_to_action",
      ]),
    )
    .optional(),
});

export const LaughPerMinuteTargetSchema = z.object({
  min: z.number().min(1.0).max(10.0),
  max: z.number().min(1.0).max(12.0),
});

export const RhetoricalSpineSchema = z.object({
  acts: z.array(RhetoricalActSchema).min(1),
  laughPerMinuteTarget: LaughPerMinuteTargetSchema,
  ruleOfThreeProbability: z.number().min(0.0).max(1.0),
  callbackTargetCount: z.number().int().min(0).max(10),
  wordBudgetPerSecond: z.number().min(1.0).max(4.0).default(2.5),
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice Mechanics & Stylometrics Schema
// ─────────────────────────────────────────────────────────────────────────────

export const VoiceMechanicsSchema = z.object({
  meanSentenceLengthWords: z.number().min(5).max(40),
  profanityRegister: ProfanityRegisterSchema,
  outrageAffabilityRatio: z.number().min(0.0).max(1.0),
  cynicismVsOptimismRatio: z.number().min(0.0).max(1.0),
  catchphrases: z.array(z.string()).default([]),
  lexicalIdiosyncrasies: z.array(z.string()).default([]),
  punchlinePositionRule: z.literal("end_of_sentence").default("end_of_sentence"),
  sentenceCadence: SentenceCadenceSchema.optional(),
  signatureConnectors: z.array(z.string()).optional(),
  ttsVoice: TtsVoiceSchema.optional(),
  acousticCuePreferences: z.array(z.string()).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Talking Point Tree & Tangent Drift Schemas (Archetype B)
// ─────────────────────────────────────────────────────────────────────────────

export const TalkingPointNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  premise: z.string().min(1),
  groundedFacts: z.array(z.string()).default([]),
  incongruityAngle: z.string().min(1),
  associativeKeywords: z.array(z.string()).min(1),
  suggestedSpeakerRole: HostRoleSchema.optional(),
  tangentBranches: z.array(z.string()).default([]),
});

export const TangentDriftConfigSchema = z.object({
  driftProbability: z.number().min(0.0).max(1.0),
  maxDriftDepthTurns: z.number().int().min(1).max(10),
  backchannelProbability: z.number().min(0.0).max(1.0),
  snapbackPhrases: z.array(z.string()).min(1),
  thematicAnchors: z.array(z.string()).min(1),
  turnLengthWeights: z.object({
    backchannel: z.number().min(0.0).max(1.0),
    pingPong: z.number().min(0.0).max(1.0),
    speculativeRiff: z.number().min(0.0).max(1.0),
    diatribe: z.number().min(0.0).max(1.0),
  }),
});

export const PodcastDynamicsSchema = z.object({
  talkingPointTree: z.array(TalkingPointNodeSchema).default([]),
  driftConfig: TangentDriftConfigSchema,
  targetLpm: LaughPerMinuteTargetSchema,
  acousticTagSet: z.array(z.string()).default([
    "[laughs]",
    "[chuckles]",
    "[snickers]",
    "[sighs]",
    "[gasps]",
    "[whispering]",
    "[incredulous]",
  ]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Master ShowSkill Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ShowSkillSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  archetype: ShowArchetypeSchema,
  showType: ShowFormatSchema,
  description: z.string().min(10),
  referenceImageUrl: z.string().optional(),
  rhetoricalSpine: RhetoricalSpineSchema,
  voiceMechanics: VoiceMechanicsSchema,
  hosts: z.array(HostSkillConfigSchema).min(1),
  podcastDynamics: PodcastDynamicsSchema.optional(),
  visualStylePrompt: z.string().min(10),
  notes: z.string().optional(),
  isDefault: z.boolean().default(false),
  displayOrder: z.number().int().min(1).max(999).default(100),
  aliases: z.array(z.string()).default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Scripting Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const ClipWordBudgetSchema = z.object({
  clipIndex: z.number().int().nonnegative(),
  startTimeSeconds: z.number().nonnegative(),
  endTimeSeconds: z.number().positive(),
  durationSeconds: z.number().positive(),
  targetWordsMin: z.number().int().positive(),
  targetWordsMax: z.number().int().positive(),
  assignedActId: z.string(),
  actName: z.string(),
});

export const PodcastTurnSegmentSchema = z.object({
  speaker: z.string().min(1),
  role: HostRoleSchema,
  text: z.string().min(1),
  turnType: TurnTypeSchema,
  isTangent: z.boolean().default(false),
  nodeId: z.string().optional(),
  durationSeconds: z.number().positive(),
});
