import { ARCHETYPE_A_STANDARD_ACTS } from "./archetype-a";
import type { ShowSkill } from "./types";

export const investigativeDeskSkill: ShowSkill = {
  id: "investigative-desk",
  slug: "investigative-desk",
  name: "John Oliver Like",
  archetype: "writers_room_desk",
  showType: "monologue",
  description:
    "Erudite, high-velocity investigative monologue combining righteous moral outrage with cascading, hyper-specific absurdist analogies and theatrical set-pieces.",
  referenceImageUrl: "/templates/investigative-desk.jpg",
  rhetoricalSpine: {
    acts: ARCHETYPE_A_STANDARD_ACTS,
    laughPerMinuteTarget: { min: 3.5, max: 4.8 },
    ruleOfThreeProbability: 0.85,
    callbackTargetCount: 2,
    wordBudgetPerSecond: 2.5,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 18.5,
    profanityRegister: "mild",
    outrageAffabilityRatio: 0.85,
    cynicismVsOptimismRatio: 0.7,
    catchphrases: [
      "Look...",
      "Cool.",
      "And now, this...",
      "That is not a real thing, except it entirely is.",
      "Moving on!",
      "Holy shit.",
    ],
    lexicalIdiosyncrasies: [
      "hyper-specific analogies with bizarre first names (e.g., 'Cool, Kevin')",
      "parenthetical asides addressing inanimate objects or corporations",
      "breathless cascading metaphors ('X is like Y, if Y were run by...')",
      "incredulous direct second-person camera address",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "rolling_breathless",
    signatureConnectors: [
      "Look, the point is...",
      "And that sounds crazy until you realize...",
      "Which brings us to...",
      "Yes, exactly...",
    ],
    ttsVoice: "English_magnetic_voiced_man",
    acousticCuePreferences: ["[laughs]", "[sighs]", "[incredulous]"],
  },
  hosts: [
    {
      name: "John Olive",
      role: "anchor",
      position: "center",
      ttsVoice: "English_magnetic_voiced_man",
      personaCraft:
        "Articulate, fast-talking British satirical anchor delivering long, passionate rants that build from measured journalistic facts to incredulous existential outrage. Delivers elaborate similes that escalate to bizarre extremes before snapping back to reality.",
      personality:
        "British comedian known for deep-dive investigative humor. Delivers long, passionate rants that build from absurd observations to genuine outrage. Uses elaborate analogies and metaphors that escalate to ridiculous extremes. Frequently addresses the camera directly with exasperated disbelief. Catchphrases include 'And now this...', 'Cool.', and 'Look...'. Combines righteous anger with self-deprecating humor.",
      catchphrases: [
        "Look...",
        "Cool.",
        "That is not a real thing, except it entirely is.",
        "And now, this...",
      ],
      speakingRateWpm: 160,
    },
  ],
  visualStylePrompt:
    "A sharp, bespectacled satirical news anchor in a tailored suit sitting behind a sleek modern late-night television desk with a high-tech graphics monitor on the left, studio lighting, cinematic broadcast television set.",
  notes:
    "Signature deep-dive format. Heavy journalistic research wrapped in escalating absurdist metaphors and righteous indignation.",
  isDefault: true,
  displayOrder: 2,
  aliases: [
    "last-week-tonight",
    "investigative",
    "deep-dive",
  ],
};
