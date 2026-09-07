import { ARCHETYPE_A_STANDARD_ACTS } from "./archetype-a";
import type { ShowSkill } from "./types";

export const closerLookSkill: ShowSkill = {
  id: "closer-look",
  slug: "closer-look",
  name: "Seth Meyers Like",
  archetype: "writers_room_desk",
  showType: "monologue",
  description:
    "Sharp, staccato political dissection driven by head-writer wit, quick character impressions, conversational self-audits, and rapid-fire joke tags.",
  referenceImageUrl: "/templates/political-dissection.jpg",
  rhetoricalSpine: {
    acts: ARCHETYPE_A_STANDARD_ACTS,
    laughPerMinuteTarget: { min: 4.5, max: 5.8 },
    ruleOfThreeProbability: 0.9,
    callbackTargetCount: 1,
    wordBudgetPerSecond: 2.5,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 13.2,
    profanityRegister: "clean",
    outrageAffabilityRatio: 0.45,
    cynicismVsOptimismRatio: 0.55,
    catchphrases: [
      "Let me explain...",
      "He talks like a guy who...",
      "I mean, look at this...",
      "And you just know...",
      "What are we doing here?",
    ],
    lexicalIdiosyncrasies: [
      "breaking into slight chuckles at own absurd comparisons",
      "rapid setup-punch-tag-tag cadences",
      "third-person impressions of political figures and everyday archetypes",
      "meta-commentary on the monologue's own writing",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "staccato_snappy",
    signatureConnectors: [
      "I mean, think about that...",
      "And you just know...",
      "Which makes sense, because...",
      "Let me explain...",
    ],
    ttsVoice: "English_Persuasive_Man",
    acousticCuePreferences: ["[chuckles]", "[laughs]", "[deadpan]"],
  },
  hosts: [
    {
      name: "Seth Mires",
      role: "anchor",
      position: "center",
      ttsVoice: "English_Persuasive_Man",
      personaCraft:
        "Sharp, dry, cerebral head-writer delivery. Delivers surgical takedowns of news clips with knowing smiles, rapid-fire tags, and brief voice impressions. Pauses for effect and readily breaks into slight laughter at his own analogies.",
      personality:
        "Former SNL head writer with sharp, witty delivery. Known for his 'A Closer Look' segments that dissect political news with surgical precision. Dry, understated humor with occasional bursts of animated disbelief. Uses rhetorical questions and callback jokes effectively. Often pauses for effect after a punchline with a knowing smile.",
      catchphrases: [
        "Let me explain...",
        "He talks like a guy who...",
        "What are we doing here?",
      ],
      speakingRateWpm: 150,
    },
  ],
  visualStylePrompt:
    "A witty, clean-cut satirical television host in a sharp grey suit behind an elegant minimalist dark wood desk, warm late-night studio lighting, graphic overlay screen in background.",
  notes:
    "Surgical political comedy. Prioritizes tight joke economy, tags, and rapid impressions over grand theatrical set-pieces.",
  isDefault: true,
  displayOrder: 4,
  aliases: [
    "closer-look",
    "late-night",
    "surgical-dissection",
  ],
};
