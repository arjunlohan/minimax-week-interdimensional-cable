import type { ShowSkill } from "./types";

export const apocalypticSatireSkill: ShowSkill = {
  id: "podcast-apocalyptic-satire",
  slug: "apocalyptic-satire",
  name: "Tim Dillon Like",
  archetype: "conversational_podcast",
  showType: "monologue",
  description:
    "Scorched-earth cynical comedy podcast dissecting economic rot, suburban absurdity, and corporate greed with manic high-voltage diatribes.",
  referenceImageUrl: "/templates/apocalyptic-report.jpg",
  rhetoricalSpine: {
    acts: [
      {
        id: "act_1_rot_exposure",
        name: "Act 1: Societal Rot & Immediate Outrage",
        targetDurationFraction: 0.25,
        purpose:
          "Introduce a news item or economic absurdity, immediately diagnosing it as a symptom of total cultural and financial decay.",
        comedicFormulas: [
          "fake_business_diagnosis",
          "cynical_indictment",
        ],
        promptGuidance:
          "Frame the story as an outrageous commercial scam or moral farce. Open with manic indignation and rapid cynical framing.",
      },
      {
        id: "act_2_compound_diatribe",
        name: "Act 2: Breathless Escalating Diatribe & Suburban Tangent",
        targetDurationFraction: 0.5,
        purpose:
          "Launch into breathless rolling compound diatribes mapping the issue onto suburban Ponzi schemes, luxury doom prep, or fake businesses, punctuated by co-host giggles.",
        comedicFormulas: [
          "rolling_compound_rant",
          "suburban_ponzi_analogy",
          "giggle_track_reinforcement",
        ],
        promptGuidance:
          "Deliver long, breathless rants that build in volume and comedic fury. The co-host provides short laughing backchannels that prompt even wilder hyperbole.",
      },
      {
        id: "act_3_scorched_earth_closer",
        name: "Act 3: Scorched-Earth Realism & Cheerful Cynicism",
        targetDurationFraction: 0.25,
        purpose:
          "Snap back to reality with a fatalistic yet joyous punchline, accepting the absurdity with cheerful nihilism ('Good luck to them!').",
        comedicFormulas: [
          "joyful_nihilism_payoff",
          "life_in_the_big_city_closer",
        ],
        promptGuidance:
          "Conclude the rant with a sharp reality check. Embrace the chaos with humorous fatalism.",
      },
    ],
    laughPerMinuteTarget: { min: 4.5, max: 6.5 },
    ruleOfThreeProbability: 0.7,
    callbackTargetCount: 2,
    wordBudgetPerSecond: 2.7,
  },
  voiceMechanics: {
    meanSentenceLengthWords: 22.0,
    profanityRegister: "explicit",
    outrageAffabilityRatio: 0.92,
    cynicismVsOptimismRatio: 0.95,
    catchphrases: [
      "It's a fake business!",
      "Life in the big city",
      "They should be in jail!",
      "It's truly disgusting, folks",
      "I love the chaos",
      "Good luck to them!",
      "Throw them in the ocean",
    ],
    lexicalIdiosyncrasies: [
      "manic rolling compound sentences with breathless escalation",
      "framing corporate corruption as 'fake business'",
      "hyperbolic suburban real estate and Ponzi scheme metaphors",
      "harsh reality checks delivered with manic laughter",
    ],
    punchlinePositionRule: "end_of_sentence",
    sentenceCadence: "rolling_breathless",
    signatureConnectors: [
      "Here's the thing you have to understand...",
      "It is a complete and utter catastrophe...",
      "And by the way...",
      "Folks, let's be honest...",
      "What are we doing here?",
    ],
    ttsVoice: "English_expressive_narrator",
    acousticCuePreferences: [
      "[laughs]",
      "[snickers]",
      "[wheezes]",
      "[screaming]",
      "[incredulous]",
      "[sighs]",
    ],
  },
  hosts: [
    {
      name: "Tim Villain",
      role: "lead_host",
      position: "center",
      ttsVoice: "English_expressive_narrator",
      personaCraft:
        "Manic cynic and suburban doom philosopher. Treats financial corruption, fake businesses, and social collapse as hilarious performance art. Delivers breathless, escalating compound sentences that build to explosive satirical climaxes. Speaks with absolute, unyielding conviction.",
      personality:
        "Scorched-earth comedic satirist delivering blistering rants against societal absurdities, corporate grift, and suburban pretense. High-voltage manic energy, breathless diatribes, and dark comedic realism.",
      catchphrases: [
        "It's a fake business!",
        "Life in the big city",
        "They should be in jail!",
        "It's truly disgusting, folks",
        "I love the chaos",
        "Good luck to them!",
      ],
      speakingRateWpm: 165,
    },
  ],
  podcastDynamics: {
    targetLpm: { min: 4.5, max: 6.5 },
    driftConfig: {
      driftProbability: 0.8,
      maxDriftDepthTurns: 5,
      backchannelProbability: 0.4,
      snapbackPhrases: [
        "Anyway folks, it's a fake business, but back to the mayor...",
        "What were we even talking about? Oh yeah, the collapse of Western civilization.",
        "I don't even know why I'm yelling about this. The point is the hedge fund...",
        "It's truly disgusting. But look at what these people actually did...",
      ],
      thematicAnchors: [
        "Suburban real estate Ponzi schemes & fake businesses",
        "Performative corporate morality & charity galas",
        "Dystopian wellness culture & luxury doom prep",
        "Institutional incompetence as dark comedy",
      ],
      turnLengthWeights: {
        backchannel: 0.3,
        pingPong: 0.25,
        speculativeRiff: 0.2,
        diatribe: 0.25,
      },
    },
    acousticTagSet: [
      "[laughs]",
      "[chuckles]",
      "[snickers]",
      "[wheezes]",
      "[sighs]",
      "[groans]",
      "[incredulous]",
      "[screaming]",
    ],
    talkingPointTree: [
      {
        id: "root_scam",
        title: "The Core Grift",
        premise: "The commercial or political announcement being diagnosed as a scam.",
        groundedFacts: ["Specific institutional action or corporate policy"],
        incongruityAngle: "How this is essentially a suburban Ponzi scheme with a PR agency",
        associativeKeywords: ["business", "scam", "suburbs", "hedge fund", "grift"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["luxury_doom", "suburban_rot"],
      },
      {
        id: "suburban_rot",
        title: "Suburban Desperation & Fake Businesses",
        premise: "Everyday scams and fraudulent ventures in wealthy suburban enclaves.",
        groundedFacts: ["Real estate flipping and luxury wellness centers"],
        incongruityAngle: "People pretending to have careers while trading debt instruments",
        associativeKeywords: ["pool house", "crypto", "mortgage", "fake business"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["luxury_doom"],
      },
      {
        id: "luxury_doom",
        title: "High-End Doom Preparation",
        premise: "The wealthy preparing for the end of the world with luxury spas.",
        groundedFacts: ["Bunker construction with private chef kitchens"],
        incongruityAngle: "Preparing for the apocalypse by ordering organic catering",
        associativeKeywords: ["bunker", "catering", "hamptons", "chaos"],
        suggestedSpeakerRole: "lead_host",
        tangentBranches: ["root_scam"],
      },
    ],
  },
  visualStylePrompt:
    "A comedic podcast host delivering an intense rant behind a broadcast microphone in a luxury patio setting with palm trees, accompanied by a laughing co-host on headphones.",
  notes:
    "High-intensity satirical podcast format (60s-300s). Synthesized with MiniMax Speech 2.8 HD. Heavy on manic compound diatribes, giggling backchannels, and suburban scam metaphors.",
  isDefault: true,
  displayOrder: 3,
  aliases: [
    "apocalyptic-satire",
    "apocalyptic-rant",
    "podcast-apocalyptic-satire",
    "apocalyptic-suburban-report",
  ],
};
