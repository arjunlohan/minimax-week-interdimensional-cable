import { ARCHETYPE_A_STANDARD_ACTS } from "./archetype-a";
import type { ShowSkill } from "./types";

export const satiricalNewsSkill: ShowSkill = {
  id: "satirical-news-desk",
  slug: "satirical-news",
  name: "SNL Like",
  archetype: "writers_room_desk",
  showType: "conversation",
  description:
    "High-density dual-anchor news desk trading rapid one-liners, deadpan straight-man setups, subversive streetwise reactions, and cross-desk banter.",
  referenceImageUrl: "/templates/dual-anchor-desk.jpg",
  rhetoricalSpine: {
    acts: ARCHETYPE_A_STANDARD_ACTS,
    laughPerMinuteTarget: { min: 5.0, max: 6.5 },
    ruleOfThreeProbability: 0.75,
    callbackTargetCount: 1,
    wordBudgetPerSecond: 2.5,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 11.5,
    profanityRegister: "mild",
    outrageAffabilityRatio: 0.6,
    cynicismVsOptimismRatio: 0.75,
    catchphrases: [
      "For more on this...",
      "Really?",
      "I gotta say...",
      "Back to you...",
      "Look, man...",
    ],
    lexicalIdiosyncrasies: [
      "crisp news-headline syntax with sudden absurd punch words",
      "side-eye reaction glances and chuckle markers between anchors",
      "uncomfortable boundary-pushing provocations",
      "rapid straight-man setup into loose-cannon punchline",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "staccato_snappy",
    signatureConnectors: [
      "Meanwhile...",
      "In other news...",
      "Which makes you wonder...",
      "Back to you, Colin...",
    ],
    ttsVoice: "English_magnetic_voiced_man",
    acousticCuePreferences: ["[chuckles]", "[laughs]", "[deadpan]", "[snickers]"],
  },
  hosts: [
    {
      name: "Colin Jest",
      role: "anchor",
      position: "left",
      ttsVoice: "English_magnetic_voiced_man",
      personaCraft:
        "Polished, straight-man anchor delivering deadpan setups with newsroom sincerity. Maintains composure through shocking punchlines and endures good-natured ribbing from his co-anchor.",
      personality:
        "Clean-cut, preppy Harvard-educated writer. Delivers jokes with a polished, almost news-anchor sincerity that makes the punchlines land harder. Often the straight man to Michael Chey's reactions. Tends toward wordplay and clever setups.",
      catchphrases: ["For more on this...", "Really?"],
      speakingRateWpm: 145,
    },
    {
      name: "Michael Chey",
      role: "anchor",
      position: "right",
      ttsVoice: "English_Persuasive_Man",
      personaCraft:
        "Relaxed, streetwise, subversive co-anchor. Delivers boundary-pushing jokes with casual conversational ease, chuckles at his own lines, and gives knowing side-eyes to the camera and his co-anchor.",
      personality:
        "Laid-back, conversational style with a sharp edge. Delivers jokes as if casually telling a friend, which makes the dark humor hit unexpectedly. Often reacts to his own jokes with suppressed laughter or mock disbelief. More willing to push boundaries.",
      catchphrases: ["I gotta say...", "Look, man..."],
      speakingRateWpm: 140,
    },
  ],
  visualStylePrompt:
    "Two comedic news anchors sitting side-by-side behind a wide modern satirical news desk, high-contrast studio lighting, broadcast graphics monitors, vibrant newsroom set backdrop.",
  notes:
    "Dual-anchor news parody format. The comedic engine relies entirely on the contrasting dynamic between the polished straight man on the left and the subversive loose cannon on the right.",
  isDefault: true,
  displayOrder: 5,
  aliases: [
    "daily-show",
    "satirical-news",
    "satirical-news-desk",
    "news-desk",
  ],
};
