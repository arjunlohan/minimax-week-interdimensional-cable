import type { ShowSkill } from "./types";

export const speculativePodcastSkill: ShowSkill = {
  id: "podcast-speculative-wonder",
  slug: "speculative-podcast",
  name: "Joe Rogan Like",
  archetype: "conversational_podcast",
  showType: "conversation",
  description:
    "Lightly-prepped, wide-ranging conversational podcast diving into extreme human performance, primal biology, ancient history, and cosmic dread with earnest wonder.",
  referenceImageUrl: "/templates/speculative-frontier.jpg",
  rhetoricalSpine: {
    acts: [
      {
        id: "act_1_curiosity_seed",
        name: "Act 1: Premise Exploration & Initial Fascination",
        targetDurationFraction: 0.3,
        purpose:
          "Introduce the topic with open-ended curiosity, laying out bizarre grounded facts and establishing the speculative premise.",
        comedicFormulas: [
          "grounded_anomaly_inquiry",
          "primal_parallel_setup",
        ],
        promptGuidance:
          "Open with earnest fascination. Present the central weird fact or development and invite the guest to explore the underlying weirdness.",
      },
      {
        id: "act_2_associative_drift",
        name: "Act 2: Deep Speculative Riff & Tangent Drift",
        targetDurationFraction: 0.45,
        purpose:
          "Drift into associative thematic tangents (primal biology, aliens, ancient technology) with collaborative escalating wonder.",
        comedicFormulas: [
          "associative_tangent_leap",
          "escalating_wonder_riff",
          "acoustic_banter_exchange",
        ],
        promptGuidance:
          "Allow the conversation to wander into unexpected thematic territory. Hosts build on each other's metaphors with genuine excitement and acoustic cues.",
      },
      {
        id: "act_3_philosophical_snapback",
        name: "Act 3: Philosophical Snapback & Cosmic Perspective",
        targetDurationFraction: 0.25,
        purpose:
          "Snap back to the core story with a characteristic transition phrase, framing the entire discussion in awe at the human condition.",
        comedicFormulas: [
          "organic_snapback_transition",
          "cosmic_perspective_closer",
        ],
        promptGuidance:
          "Deploy a snapback phrase to re-anchor on the core topic. Conclude with a humorous, awe-struck reflection on human absurdity.",
      },
    ],
    laughPerMinuteTarget: { min: 2.5, max: 4.0 },
    ruleOfThreeProbability: 0.4,
    callbackTargetCount: 2,
    wordBudgetPerSecond: 2.4,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 14.0,
    profanityRegister: "frequent",
    outrageAffabilityRatio: 0.2,
    cynicismVsOptimismRatio: 0.3,
    catchphrases: [
      "It's entirely possible",
      "Have you ever seen a chimp without hair?",
      "Pull that up, Jamie",
      "We're literally monkeys flying through space",
      "100 percent",
      "Think about the primal biology of that",
      "That is fascinating",
    ],
    lexicalIdiosyncrasies: [
      "primal biology and martial arts analogies",
      "earnest open-ended speculative questions",
      "open-minded conspiratorial wonder",
      "acoustic laughter and vocal expressions [chuckles], [sighs]",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "conversational_riff",
    signatureConnectors: [
      "Dude...",
      "Think about that for a second...",
      "The crazy thing about that is...",
      "Wait, but here's the question...",
      "Look at me...",
    ],
    ttsVoice: "English_Aussie_Bloke",
    acousticCuePreferences: [
      "[laughs]",
      "[chuckles]",
      "[sighs]",
      "[gasps]",
      "[whispering]",
      "[incredulous]",
    ],
  },
  hosts: [
    {
      name: "Joe Brogan",
      role: "lead_host",
      position: "left",
      ttsVoice: "English_Aussie_Bloke",
      personaCraft:
        "Earnest martial artist and curious explorer. Delivers dialogue with childlike fascination and intense primal awe. Uses physical metaphors, animal psychology, and martial arts analogies to dissect complex stories. Frequently uses open-ended questions ('Think about that...', 'Have you ever seen a chimp without hair?'). Warm, curious, and grounded.",
      personality:
        "Earnest podcast host with passion for martial arts, primal biology, and cosmic mysteries. Listens intently, asks probing questions with wide-eyed curiosity, and explores alternative explanations with open-minded fascination.",
      catchphrases: [
        "It's entirely possible",
        "Have you ever seen a chimp without hair?",
        "Pull that up, Jamie",
        "100 percent",
        "Think about the primal biology of that",
      ],
      speakingRateWpm: 145,
    },
    {
      name: "Duncan Trussed",
      role: "guest_theorist",
      position: "right",
      ttsVoice: "English_expressive_narrator",
      personaCraft:
        "Esoteric philosopher and fringe polymath. Connects tech trends to spiritual archetypes, DMT experiences, and ancient engineering. Speaks with manic enthusiasm and poetic hyperbole, turning dry facts into cosmic journeys.",
      personality:
        "Cosmic philosopher and fringe theorist who brings joyous esoteric angles to every topic. Connects technological trends to spiritual archetypes and ancient civilizations with enthusiastic poetic flair.",
      catchphrases: [
        "It's all resonance, man",
        "The ancient Egyptians definitely knew about this",
        "We are living inside an organic supercomputer",
      ],
      speakingRateWpm: 150,
    },
  ],
  podcastDynamics: {
    targetLpm: { min: 2.5, max: 4.0 },
    driftConfig: {
      driftProbability: 0.65,
      maxDriftDepthTurns: 4,
      backchannelProbability: 0.35,
      snapbackPhrases: [
        "Wait, how did we get here? Right, the actual topic...",
        "Jamie, pull that back up—what was the original number on that?",
        "Hold on, let's step back for a second. The crazy thing about the actual story is...",
        "Think about where we started versus where we are right now. But look at this...",
      ],
      thematicAnchors: [
        "Primal evolutionary biology & apex predator psychology",
        "Psychedelic neurochemistry & alternate dimensions",
        "Ancient megastructures & lost high technologies",
        "Artificial general intelligence as an alien lifeform",
      ],
      turnLengthWeights: {
        backchannel: 0.25,
        pingPong: 0.4,
        speculativeRiff: 0.25,
        diatribe: 0.1,
      },
    },
    acousticTagSet: [
      "[laughs]",
      "[chuckles]",
      "[sighs]",
      "[gasps]",
      "[whispering]",
      "[incredulous]",
      "[wheezes]",
    ],
    talkingPointTree: [
      {
        id: "root_premise",
        title: "The Grounded Anomaly",
        premise: "The factual event or discovery that sparked the conversation.",
        groundedFacts: ["Core news event or technological breakthrough"],
        incongruityAngle: "Why this contradicts our conventional understanding of reality",
        associativeKeywords: ["biology", "ancient", "technology", "dimension", "chimp"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["primal_connection", "ancient_parallel"],
      },
      {
        id: "primal_connection",
        title: "Primal & Evolutionary Mirror",
        premise: "How this modern phenomenon mirrors primordial hunter-gatherer behavior.",
        groundedFacts: ["Chimpanzee tribal behavior and evolutionary psychology"],
        incongruityAngle: "We think we are civilized, but we are apes with smartphones",
        associativeKeywords: ["chimp", "predator", "muscle", "adrenaline", "tribe"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["cosmic_esoteric"],
      },
      {
        id: "ancient_parallel",
        title: "Ancient & Esoteric Technology",
        premise: "Parallels between contemporary discoveries and lost ancient knowledge.",
        groundedFacts: ["Pyramid acoustics and megalithic stonework precision"],
        incongruityAngle: "Ancient civilizations had insights that modern science is only rediscovering",
        associativeKeywords: ["pyramids", "resonance", "egypt", "consciousness", "frequency"],
        suggestedSpeakerRole: "guest_theorist",
        tangentBranches: ["cosmic_esoteric"],
      },
    ],
  },
  visualStylePrompt:
    "Two podcast hosts with studio broadcast microphones and large over-ear headphones in a dimly lit, warm studio with wood panelling, soundproof foam, and neon accents.",
  notes:
    "Long-form audio podcast format (60s-300s). Dialogue synthesized a turn at a time with MiniMax Speech 2.8 HD. Uses conversational backchannels, laughter tags, and dynamic tangent drift.",
  isDefault: true,
  displayOrder: 6,
  aliases: [
    "speculative-wonder",
    "speculative-podcast",
    "podcast-speculative-wonder",
    "the-speculative-frontier",
  ],
};
