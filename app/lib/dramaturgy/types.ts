import type {
  ClipWordBudget,
  HostRole,
  ShowArchetype,
  ShowFormat,
  ShowSkill,
  TtsVoice,
} from "@/app/lib/skills/types";

/**
 * What the episode is rendered as. Video plans one MiniMax-H3 clip per beat
 * (8 to 12 s each); audio keeps the 8 s beat grid the podcast path has always
 * used. Mirrors the `format` column on generated_shows.
 */
export type ShowOutputFormat = "video" | "audio";

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1: Research Brief & Premise Seeds
// ─────────────────────────────────────────────────────────────────────────────

export type PremiseAngleType =
  | "absurdist_escalation" |
  "hypocrisy_exposure" |
  "paranoid_wonder" |
  "surreal_literalism" |
  "apocalyptic_nihilism";

export type FactCategory =
  | "statistic" |
  "historical_trivia" |
  "institutional_quote" |
  "technical_detail" |
  "policy_absurdity";

export type AbsurdityType =
  | "stated_vs_actual" |
  "scale_mismatch" |
  "bureaucratic_nightmare" |
  "unintended_consequence" |
  "existential_banality";

export interface GroundedFact {
  id: string;
  fact: string;
  sourceUrl?: string;
  sourceTitle?: string;
  verified: boolean;
  category: FactCategory;
  absurdityScore: number; // 1.0 to 10.0
  bizarreMetric?: string;
}

export interface IncongruitySeed {
  id: string;
  setupFact: string;
  contradiction: string;
  absurdityType: AbsurdityType;
  comedicPotential: string;
  relatedFactIds?: string[];
}

export interface ComedicPremiseAngle {
  id: string;
  angleType: PremiseAngleType;
  title: string;
  logline: string;
  thematicHook: string;
  anchorFacts: string[];
  escalationLadder: [string, string, string]; // [Plausible, Absurd, Cosmic]
  targetArchetypeFit: {
    writersRoomDesk: number; // 0.0 to 1.0
    conversationalPodcast: number; // 0.0 to 1.0
  };
  suggestedAnalogies: string[];
  recommendedActSpineMapping?: {
    act1Thesis: string;
    act2Escalation: string;
    act3ClimaxOrCTA: string;
  };
  comedicPremise?: string;
  angle?: string;
}

export interface SearchGroundingMetadata {
  enabled: boolean;
  searchQueriesUsed: string[];
  groundingSources: Array<{ title: string; url: string }>;
  groundingChunkCount: number;
}

export interface ResearchBrief {
  topic: string;
  topicType: "custom" | "news_link" | "hacker_news" | "trend" | "freetext";
  summary: string;
  groundedFacts: GroundedFact[];
  incongruitySeeds: IncongruitySeed[];
  premiseAngles: ComedicPremiseAngle[];
  selectedAngleId: string;
  selectedAngle: ComedicPremiseAngle;
  searchMetadata: SearchGroundingMetadata;
  familiarityLevel: "beginner" | "familiar" | "expert";
  generatedAt: string; // ISO timestamp
  isMocked: boolean;
}

export interface Pass1ResearchInput {
  topic: string;
  topicType?: "custom" | "news_link" | "hacker_news" | "trend" | "freetext";
  familiarity?: "beginner" | "familiar" | "expert";
  showSkill?: ShowSkill;
  skillId?: string;
  userProfile?: {
    conceptMastery?: Record<string, number>;
    trackedInterests?: string[];
    humorPreference?: string;
    recentQuestions?: string[];
  };
  options?: {
    enableSearch?: boolean; // default true
    maxAngles?: number; // default 4 (range: 3-5)
    forceMock?: boolean; // default false
    temperature?: number; // default 0.75
  };
}

export interface Pass1ResearchOutput {
  brief: ResearchBrief;
  selectedAngle: ComedicPremiseAngle;
  isMocked: boolean;
  latencyMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2: Head-Writer Draft & Joke Construction
// ─────────────────────────────────────────────────────────────────────────────

export type ComedicMechanism =
  | "setup_misdirection" |
  "rule_of_three" |
  "escalating_analogy" |
  "rapid_tag" |
  "callback" |
  "character_act_out" |
  "rhetorical_crescendo" |
  "theatrical_cta";

export interface ComedicBeat {
  id: string;
  actId: string;
  actName: string;
  clipIndex: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  durationSeconds: number;
  targetWordCount: number;
  actualWordCount: number;
  speaker: string;
  setup: string;
  punchline: string;
  tags?: string[];
  fullText: string;
  mechanism: ComedicMechanism;
  plantedCallbackMotif?: string;
  resolvedCallbackMotif?: string;
  visualPrompt: string;
  actingDirection?: string;
  visualPromptSeed?: string;
}

export type TurnType =
  | "inquiry" |
  "speculative_riff" |
  "diatribe" |
  "ping_pong" |
  "backchannel" |
  "tangent_pivot" |
  "snapback";

export interface PodcastTurn {
  id: string;
  turnIndex: number;
  speaker: string;
  role: HostRole | string;
  ttsVoice: TtsVoice | string;
  turnType: TurnType;
  text: string;
  acousticTags: string[];
  wordCount: number;
  estimatedDurationSeconds: number;
  currentNodeId: string;
  isTangent: boolean;
  driftDepth: number;
  snapbackTriggered?: boolean;
}

export interface CallbackLink {
  plantedInBeatId: string;
  resolvedInBeatId: string;
  motif: string;
}

export interface HeadWriterDraft {
  archetype: ShowArchetype;
  showId: string;
  showTitle: string;
  topic: string;
  selectedPremise: ComedicPremiseAngle;
  beats?: ComedicBeat[];
  turns?: PodcastTurn[];
  callbacks: CallbackLink[];
  callbacksPlanted?: string[];
  clipWordBudgets?: ClipWordBudget[];
  metrics: {
    totalDurationSeconds: number;
    totalWordCount: number;
    estimatedLpm: number;
    jokeCount: number;
    callbackCount: number;
    ruleOfThreeCount: number;
    tangentCount?: number;
    maxDriftDepthReached?: number;
  };
  pass1Context: {
    verifiedFactsCount: number;
    incongruitySeedsCount: number;
  };
  totalEstimatedSeconds?: number;
}

export interface PersonalizationContext {
  conceptMastery?: Record<string, number>;
  trackedInterests?: string[];
  humorPreference?: {
    preferredTone?: string;
    absurdismTolerance?: number;
  } | string;
  recentQuestions?: string[];
}

export interface Pass2Input {
  researchBrief: ResearchBrief;
  skill: ShowSkill;
  durationSeconds: number;
  /** Default "video". Decides how desk-show beats are sliced; podcast turns ignore it. */
  format?: ShowOutputFormat;
  personalizationProfile?: PersonalizationContext;
  customInstructions?: string;
  options?: {
    forceMock?: boolean;
    temperature?: number;
  };
}

export interface Pass2Output {
  draft: HeadWriterDraft;
  latencyMs: number;
  isMocked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 3: Voice Tuning, Table-Read Critique & Pre-Flight Content-Filter Safety
// ─────────────────────────────────────────────────────────────────────────────

export interface TableReadJokeEvaluation {
  beatIndex: number;
  setup: string;
  punchline: string;
  incongruityScore: number; // 1 - 10
  punchinessScore: number; // 1 - 10
  timingScore: number; // 1 - 10
  compositeScore: number; // 1 - 10 ((I*0.35)+(P*0.35)+(T*0.30))
  critique: string;
  passed: boolean; // compositeScore >= 7.0
  revised: boolean;
  originalPunchline?: string;
}

export interface TableReadReport {
  totalJokes: number;
  passedJokes: number;
  prunedCount: number;
  revisedCount: number;
  averageScore: number;
  evaluations: TableReadJokeEvaluation[];
  laughsPerMinute: number;
}

export interface ContentFilterSanitizationReport {
  originalLength: number;
  sanitizedLength: number;
  replacementsApplied: Array<{ pattern: string; replacement: string }>;
  isCleanForContentFilter: boolean;
}

export interface FinalScriptSegment {
  clipIndex: number;
  speaker: string;
  text: string;
  visualPrompt: string;
  actingDirection?: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  durationSeconds: number;
  acousticTags?: string[];
  wordCount?: number;
  position?: string;
}

export interface FinalScript {
  title: string;
  archetype: ShowArchetype;
  showType: ShowFormat;
  totalDurationSeconds: number;
  segments: FinalScriptSegment[];
  transcriptPlainText: string;
  tableReadReport: TableReadReport;
  voiceTuningReport: {
    meanSentenceLengthWords: number;
    targetSentenceLengthWords: number;
    profanityCompliance: boolean;
    catchphrasesUsed: string[];
    outrageAffabilityScore?: number;
  };
  sanitizationReport: ContentFilterSanitizationReport;
}

export interface Pass3Input {
  draft: HeadWriterDraft;
  skill: ShowSkill;
  personalizationProfile?: PersonalizationContext;
  options?: {
    forceMock?: boolean;
    skipTableReadPrune?: boolean;
    minScoreThreshold?: number; // default 7.0
  };
}

export interface Pass3Output {
  finalScript: FinalScript;
  latencyMs: number;
  isMocked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Master Orchestrator Pipeline Contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface DramaturgyInput {
  showId: string;
  topic: string;
  topicType?: "custom" | "news_link" | "hacker_news" | "trend" | "freetext";
  templateId?: string;
  skillIdOrSlug?: string;
  durationSeconds: number;
  /** Default "video". See ShowOutputFormat. */
  format?: ShowOutputFormat;
  familiarity?: "beginner" | "familiar" | "expert";
  userId?: string;
  language?: string;
  /**
   * A brief the caller already produced (the workflow's research step stores
   * one). When present and valid, pass 1 is skipped instead of researching the
   * same topic a second time.
   */
  researchBrief?: ResearchBrief;
  options?: {
    enableSearch?: boolean;
    forceMock?: boolean;
    skipTableReadPrune?: boolean;
    temperature?: number;
  };
}

export interface DramaturgyExecutionMetrics {
  totalDurationMs: number;
  pass1DurationMs: number;
  pass2DurationMs: number;
  pass3DurationMs: number;
  jokesEvaluated: number;
  jokesPrunedOrRevised: number;
  tableReadAvgScore: number;
}

export interface DramaturgyResult {
  showId: string;
  skill: ShowSkill;
  researchBrief: ResearchBrief;
  headWriterDraft: HeadWriterDraft;
  finalScript: FinalScript;
  executionMetrics: DramaturgyExecutionMetrics;
}

export type DramaturgyOutput = DramaturgyResult;

export interface DramaturgyProgressEvent {
  step: "research" | "script_draft" | "voice_prune" | "complete";
  message: string;
  progressFraction: number;
}
