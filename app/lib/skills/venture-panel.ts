import type { ShowSkill } from "./types";

/**
 * Four-handed venture-capital roundtable.
 *
 * The distinguishing mechanic against the other conversation format is seat
 * dynamics: four fixed personas with stable, predictable disagreements, a
 * moderator who keeps score, and segment blocks (macro, then markets, then
 * science) rather than free tangent drift.
 */
export const venturePanelSkill: ShowSkill = {
  id: "panel-venture-roundtable",
  slug: "venture-panel",
  name: "All In Like",
  archetype: "conversational_podcast",
  showType: "conversation",
  description:
    "Four-handed venture-capital roundtable: macro doom, market takes, political sparring and a science segment, delivered by investors who are certain about everything and agree about nothing.",
  referenceImageUrl: "/templates/venture-panel.jpg",
  rhetoricalSpine: {
    acts: [
      {
        id: "act_1_macro_doom",
        name: "Act 1: Macro Cold Open & Scoreboard",
        targetDurationFraction: 0.3,
        purpose:
          "Open on the week's macro story. The moderator sets the table, the contrarian immediately reframes it as a structural crisis, and the panel stakes out incompatible positions.",
        comedicFormulas: [
          "confident_macro_prediction_with_no_accountability",
          "rule_of_three_escalating_stakes",
          "moderator_interrupted_mid_setup",
        ],
        promptGuidance:
          "Start mid-argument, as if the recording caught them thirty seconds late. The moderator tries to introduce the topic and is talked over. Establish the disagreement fast: one host frames it as systemic collapse, another calls that hysterical.",
        requiredElements: ["thesis_setup", "grounded_fact", "callback"],
      },
      {
        id: "act_2_cross_talk",
        name: "Act 2: Cross-Talk & Position Defence",
        targetDurationFraction: 0.45,
        purpose:
          "The core of the episode: overlapping argument where each host defends their frame. The operator gets political, the contrarian escalates, the moderator keeps score and fails to keep order.",
        comedicFormulas: [
          "misdirection_via_false_agreement",
          "act_out_of_an_absent_third_party",
          "tag_on_a_co_host_punchline",
          "self_serious_analogy_that_collapses",
        ],
        promptGuidance:
          "Let hosts finish each other's arguments and then disagree about the conclusion. Use short backchannels. The comedy is certainty colliding with certainty, never a character being stupid.",
        requiredElements: ["escalating_analogy", "tag", "act_out"],
      },
      {
        id: "act_3_science_corner",
        name: "Act 3: Science Corner & Sign-Off",
        targetDurationFraction: 0.25,
        purpose:
          "The panel hands off to the science seat, who reframes the whole argument at a longer timescale and quietly makes everyone's positions look small. Warm sign-off.",
        comedicFormulas: [
          "deflating_long_timescale_reframe",
          "callback_to_act_one_prediction",
          "affectionate_sign_off_after_hostility",
        ],
        promptGuidance:
          "Shift register: slower, more measured, genuinely informative. The joke is the tonal whiplash from shouting about rates to explaining photosynthesis. End on warmth, because they actually like each other.",
        requiredElements: ["grounded_fact", "callback", "call_to_action"],
      },
    ],
    laughPerMinuteTarget: { min: 3.5, max: 6.0 },
    ruleOfThreeProbability: 0.5,
    callbackTargetCount: 3,
    wordBudgetPerSecond: 2.6,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 19,
    profanityRegister: "mild",
    outrageAffabilityRatio: 0.55,
    cynicismVsOptimismRatio: 0.6,
    catchphrases: [
      "Let me steelman that",
      "I'll say the quiet part out loud",
      "That's just not what the data says",
      "Can I finish?",
      "We're all friends here",
    ],
    lexicalIdiosyncrasies: [
      "asymmetric bet",
      "second-order effect",
      "the base rate",
      "structurally",
      "on a risk-adjusted basis",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "conversational_riff",
  },
  hosts: [
    {
      name: "Chamath Capitalia",
      role: "lead_host",
      position: "far_left",
      ttsVoice: "English_magnetic_voiced_man",
      personaCraft:
        "The contrarian capital allocator. Speaks slowly and with total conviction, reframing any topic as a structural inevitability he predicted earlier. Delivers grim macro forecasts with the calm of someone already positioned for them.",
      personality:
        "Assured, deliberate, faintly imperial. Treats disagreement as evidence the other person has not thought about it long enough.",
      catchphrases: ["Structurally, this was always going to happen", "I said this two years ago", "Let me steelman that"],
      speakingRateWpm: 138,
    },
    {
      name: "Jason Calamaris",
      role: "co-host",
      position: "left",
      ttsVoice: "English_Persuasive_Man",
      personaCraft:
        "The moderator and enthusiast. Keeps the running order, fails to keep order, and is audibly delighted by the chaos. Fastest talker on the panel; interrupts and is interrupted.",
      personality:
        "High-energy, warm, self-appointed referee. Cheerleads the format itself and keeps score of who was wrong.",
      catchphrases: ["Can I finish?", "We're all friends here", "Let's go around the horn"],
      speakingRateWpm: 178,
    },
    {
      name: "David Stacks",
      role: "straight_man",
      position: "right",
      ttsVoice: "English_Trustworth_Man",
      personaCraft:
        "The operator. Dry, precise, politically pointed. Delivers the most cutting line in the flattest possible register and does not laugh at his own jokes.",
      personality:
        "Deadpan and unhurried. Wins arguments by refusing to raise his voice while everyone else does.",
      catchphrases: ["That's just not what the data says", "I'll say the quiet part out loud"],
      speakingRateWpm: 142,
    },
    {
      name: "David Friedegg",
      role: "co_host_sounding_board",
      position: "far_right",
      ttsVoice: "English_Insightful_Speaker",
      personaCraft:
        "The science seat. Waits out the argument, then reframes it on a geological or biological timescale that makes everyone else's position look parochial. Genuinely informative, which is the joke.",
      personality:
        "Measured, earnest, quietly amused. The only host who changes his mind when shown evidence.",
      catchphrases: ["Zoom out for a second", "That's a solved problem in biology"],
      speakingRateWpm: 148,
    },
  ],
  podcastDynamics: {
    talkingPointTree: [
      {
        id: "macro_rates",
        title: "Rates, Liquidity & The Everything Reset",
        premise: "Every asset price is a function of one number and nobody wants to say so.",
        groundedFacts: ["Long-duration assets reprice hardest when discount rates move"],
        incongruityAngle: "Four people who cannot agree on lunch confidently forecasting the global economy",
        associativeKeywords: ["rates", "liquidity", "duration", "soft landing", "credit"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["market_structure"],
      },
      {
        id: "market_structure",
        title: "Market Structure & Who Actually Gets Paid",
        premise: "The interesting question is never the price, it is who is on the other side of the trade.",
        groundedFacts: ["Fee structures persist long after the strategy stops working"],
        incongruityAngle: "Disclosing a conflict of interest at speed, then giving the take anyway",
        associativeKeywords: ["fees", "carry", "liquidity", "incentives", "allocators"],
        suggestedSpeakerRole: "straight_man",
        tangentBranches: ["science_corner"],
      },
      {
        id: "science_corner",
        title: "Science Corner",
        premise: "A long-timescale reframe that quietly deflates the preceding argument.",
        groundedFacts: ["Photosynthesis converts roughly 1 to 2 percent of incident sunlight into biomass"],
        incongruityAngle: "Tonal whiplash from shouting about rates to explaining a real mechanism calmly",
        associativeKeywords: ["biology", "energy", "climate", "timescale", "physics"],
        suggestedSpeakerRole: "co_host_sounding_board",
        tangentBranches: [],
      },
    ],
    driftConfig: {
      // Lower drift than the two-hander: this format runs to a segment order,
      // and the moderator drags it back on topic rather than following tangents.
      driftProbability: 0.3,
      maxDriftDepthTurns: 2,
      backchannelProbability: 0.45,
      snapbackPhrases: [
        "Okay, let's go around the horn — back to the actual question.",
        "Hold on, hold on. Can I finish the point?",
        "We're way off. Science corner, save us.",
      ],
      thematicAnchors: [
        "Rates, liquidity and the repricing of everything",
        "Incentives and who is actually on the other side of the trade",
        "Long-timescale science reframes that deflate the argument",
        "Predictions made confidently and graded never",
      ],
      turnLengthWeights: {
        // Four seats, so short overlapping turns dominate.
        backchannel: 0.35,
        pingPong: 0.4,
        speculativeRiff: 0.15,
        diatribe: 0.1,
      },
    },
    targetLpm: { min: 3.5, max: 6.0 },
    acousticTagSet: ["[laughs]", "[chuckles]", "[scoffs]", "[sighs]", "[crosstalk]", "[interrupting]", "[deadpan]"],
  },
  visualStylePrompt:
    "Four-way remote panel of investors on a video call grid, each in a home office with bookshelves and warm lamp light, casual quarter-zips and open collars, laptop-camera framing.",
  notes:
    "Four-speaker roundtable (60s-300s). Seat dynamics drive the comedy: fixed personas with stable, predictable disagreements. Synthesized a turn at a time with four distinct MiniMax Speech 2.8 HD voices.",
  isDefault: false,
  displayOrder: 1,
  aliases: [
    "venture-panel",
    "panel-venture-roundtable",
    "capital-allocators",
    "the-capital-allocators-roundtable",
    "roundtable",
  ],
};
