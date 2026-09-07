import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateJson, generateText } from "@/app/lib/gmi/text";
import { gatherSources, gatherSourcesDetailed } from "@/app/lib/research/sources";
import type { ResearchSource } from "@/app/lib/research/sources";
import { calculateClipWordBudgets } from "@/app/lib/skills/archetype-a";
import { getDefaultShowSkill, getShowSkill } from "@/app/lib/skills/registry";

import { runDramaturgyPipeline } from "./orchestrator";
import { createMockResearchBrief, runPass1Research } from "./pass1-research";
import {
  generateHeadWriterDraft,
  planClipWordBudgets,
  planVideoBeatSlots,
  synthesizeDeterministicDeskDraft,
  synthesizeDeterministicPodcastDraft,
} from "./pass2-head-writer";
import {
  applyStylometricVoiceTuning,
  calculateJokeCompositeScore,
  enforceProfanityRegister,
  evaluateSingleJokeDeterministic,
  runPass3VoiceAndPrune,
  sanitizeForContentFilter,
} from "./pass3-voice-prune";
import {
  DramaturgyResultSchema,
  FinalScriptSchema,
  HeadWriterDraftSchema,
  ResearchBriefDraftSchema,
  ResearchBriefSchema,
} from "./schemas";

// Mock env module before importing anything else
vi.mock("@/app/lib/env", () => ({
  env: {
    GMI_CLOUD_APIKEY: "test-gmi-key",
    DATABASE_URL: "postgresql://localhost:5432/test",
  },
}));

// The model boundary. Nothing in these tests may reach GMI Cloud.
vi.mock("@/app/lib/gmi/text", () => ({
  generateText: vi.fn(),
  generateJson: vi.fn(),
  extractJsonValue: vi.fn(),
  stripThinking: vi.fn((text: string) => text),
}));

// The fetch boundary. The pure helpers stay real; only page reading is faked.
vi.mock("@/app/lib/research/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/research/sources")>();
  return { ...actual, gatherSources: vi.fn(), gatherSourcesDetailed: vi.fn() };
});

// Mock memory-bank
vi.mock("@/app/lib/memory-bank", () => ({
  buildPersonalizedPromptContext: vi.fn().mockResolvedValue(
    "=== PERSISTENT USER MEMORY BANK ===\nPreferred Tone/Humor: Sharp, dry British satire\nKnown User Interests: ai-agents, quantum-computing",
  ),
  getMemorySummary: vi.fn().mockResolvedValue({
    conceptMastery: [{ concept: "quantum-computing", level: "Expert", confidence: 0.9 }],
    interests: ["ai-agents"],
    humorPreference: "Sharp, dry British satire",
    recentQuestions: [],
    totalMemories: 2,
  }),
}));

const generateJsonMock = vi.mocked(generateJson);
const generateTextMock = vi.mocked(generateText);
const gatherSourcesMock = vi.mocked(gatherSources);
const gatherSourcesDetailedMock = vi.mocked(gatherSourcesDetailed);

const FETCHED_SOURCES: ResearchSource[] = [
  {
    title: "Toaster Regulation Act passes committee",
    url: "https://example.org/toasters",
    excerpt: "Committee text about toasters. ".repeat(30),
    points: 312,
    via: "hacker-news",
  },
  {
    title: "Appliance Weekly: the firmware problem",
    url: "https://example.org/appliances/",
    excerpt: "Firmware text about appliances. ".repeat(30),
    via: "hacker-news",
  },
];

describe("milestone 2: Multi-Pass Dramaturgy & Scripting Engine", () => {
  const deskSkill = getShowSkill("investigative-desk") ?? getDefaultShowSkill("writers_room_desk");
  const podcastSkill = getShowSkill("speculative-podcast") ?? getDefaultShowSkill("conversational_podcast");

  /** The shape MiniMax-M3 returns for pass 1, built on the mock brief's valid seeds and angles. */
  function modelResearchDraft(topic: string, groundedFacts: Array<Record<string, unknown>>) {
    const base = createMockResearchBrief({ topic, showSkill: deskSkill });
    return {
      summary: base.summary,
      groundedFacts,
      incongruitySeeds: base.incongruitySeeds,
      premiseAngles: base.premiseAngles,
      selectedAngleId: "angle-2",
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    gatherSourcesMock.mockResolvedValue([]);
    // Pass 1 calls the detailed gatherer; the tests script the plain one, so
    // the detailed mock derives its answer from it and reports the topic as
    // the query. Re-armed here because resetAllMocks drops implementations.
    gatherSourcesDetailedMock.mockImplementation(async (topic: string) => {
      const sources = await gatherSourcesMock(topic);
      return { sources, queriesTried: [topic], queryUsed: sources.length > 0 ? topic : undefined };
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Pass 1: Grounded Research & Premise Seed Engine
  // ───────────────────────────────────────────────────────────────────────────
  describe("pass 1: Grounded Research & Premise Seed", () => {
    it("generates a comprehensive deterministic research brief with verified facts and incongruity seeds", () => {
      const brief = createMockResearchBrief({
        topic: "Autonomous AI Toasters",
        showSkill: deskSkill,
      });

      expect(brief.topic).toBe("Autonomous AI Toasters");
      expect(brief.groundedFacts.length).toBeGreaterThanOrEqual(3);
      expect(brief.incongruitySeeds.length).toBeGreaterThanOrEqual(2);
      expect(brief.premiseAngles.length).toBeGreaterThanOrEqual(3);

      // Verify facts contain required fields
      const fact = brief.groundedFacts[0];
      expect(fact.id).toBeDefined();
      expect(fact.fact.length).toBeGreaterThan(20);
      expect(fact.verified).toBe(true);
      expect(fact.absurdityScore).toBeGreaterThanOrEqual(1);

      // Verify incongruity seeds
      const seed = brief.incongruitySeeds[0];
      expect(seed.setupFact).toBeDefined();
      expect(seed.contradiction).toBeDefined();
      expect(seed.absurdityType).toBeDefined();

      // Verify escalation ladder triplet
      const angle = brief.premiseAngles[0];
      expect(angle.escalationLadder).toHaveLength(3);
      expect(angle.escalationLadder[0].length).toBeGreaterThan(5);
      expect(angle.escalationLadder[1].length).toBeGreaterThan(5);
      expect(angle.escalationLadder[2].length).toBeGreaterThan(5);

      // Validate against Zod schema
      expect(() => ResearchBriefSchema.parse(brief)).not.toThrow();
    });

    it("selects appropriate premise angle matching ShowSkill archetype", () => {
      const deskBrief = createMockResearchBrief({
        topic: "Corporate AI Accounting",
        showSkill: deskSkill,
      });
      expect(deskBrief.selectedAngle.targetArchetypeFit.writersRoomDesk).toBeGreaterThanOrEqual(0.7);

      const podBrief = createMockResearchBrief({
        topic: "Quantum Simulation Theory",
        showSkill: podcastSkill,
      });
      expect(podBrief.selectedAngle.targetArchetypeFit.conversationalPodcast).toBeGreaterThanOrEqual(0.7);
    });

    it("runs Pass 1 research with forceMock option cleanly without calling the model", async () => {
      const output = await runPass1Research({
        topic: "Microplastic Diet Trends",
        showSkill: deskSkill,
        options: { forceMock: true },
      });

      expect(output.isMocked).toBe(true);
      expect(output.brief).toBeDefined();
      expect(output.selectedAngle).toBeDefined();
      expect(output.latencyMs).toBeGreaterThanOrEqual(0);
      expect(output.brief.searchMetadata.enabled).toBe(true);
      expect(generateJsonMock).not.toHaveBeenCalled();
      expect(gatherSourcesMock).not.toHaveBeenCalled();
    });

    it("grounds the brief in fetched sources and lets a fact cite nothing else", async () => {
      gatherSourcesMock.mockResolvedValue(FETCHED_SOURCES);
      generateJsonMock.mockResolvedValue(modelResearchDraft("Autonomous AI Toasters", [
        {
          id: "fact-1",
          fact: "A sourced fact about toasters that is long enough to pass validation.",
          sourceUrl: "https://example.org/toasters",
          sourceTitle: "Toaster Regulation Act passes committee",
          verified: true,
          category: "statistic",
          absurdityScore: 7.2,
        },
        {
          id: "fact-2",
          fact: "A fact that cites a publication the pass never fetched.",
          sourceUrl: "https://fake.example.net/made-up-study",
          sourceTitle: "Invented Journal of Appliances",
          verified: true,
          category: "policy_absurdity",
          absurdityScore: 6.1,
        },
        {
          id: "fact-3",
          fact: "A fact from the model's own knowledge with no citation at all.",
          verified: true,
          category: "historical_trivia",
          absurdityScore: 5.5,
        },
        {
          id: "fact-4",
          fact: "A fact citing the second source with a trailing-slash mismatch.",
          sourceUrl: "https://example.org/appliances",
          category: "technical_detail",
          absurdityScore: 4.4,
        },
      ]));

      const output = await runPass1Research({
        topic: "Autonomous AI Toasters",
        topicType: "custom",
        showSkill: deskSkill,
      });

      expect(gatherSourcesMock).toHaveBeenCalledWith("Autonomous AI Toasters");
      expect(generateJsonMock).toHaveBeenCalledTimes(1);
      const call = generateJsonMock.mock.calls[0][0];
      expect(call.schema).toBe(ResearchBriefDraftSchema);
      expect(call.temperature).toBe(0.75);
      expect(call.maxOutputTokens).toBe(65536);
      expect(call.system).toContain("Never invent a URL");
      expect(call.prompt).toContain("<sources>");
      expect(call.prompt).toContain("url=\"https://example.org/toasters\"");
      expect(call.prompt).toContain("url=\"https://example.org/appliances/\"");
      expect(call.prompt).toContain("Committee text about toasters.");

      const facts = output.brief.groundedFacts;
      expect(facts[0]).toMatchObject({
        sourceUrl: "https://example.org/toasters",
        sourceTitle: "Toaster Regulation Act passes committee",
        verified: true,
      });
      // The fabricated citation is stripped, not shipped.
      expect(facts[1].sourceUrl).toBeUndefined();
      expect(facts[1].sourceTitle).toBeUndefined();
      expect(facts[1].verified).toBe(false);
      expect(facts[2].sourceUrl).toBeUndefined();
      expect(facts[2].verified).toBe(false);
      // A near-miss on a real source resolves to the fetched URL and title.
      expect(facts[3]).toMatchObject({
        sourceUrl: "https://example.org/appliances/",
        sourceTitle: "Appliance Weekly: the firmware problem",
        verified: true,
      });

      expect(output.brief.searchMetadata).toEqual({
        enabled: true,
        searchQueriesUsed: ["Autonomous AI Toasters"],
        groundingSources: FETCHED_SOURCES.map(s => ({ title: s.title, url: s.url })),
        groundingChunkCount: 2,
      });
      expect(output.brief.selectedAngleId).toBe("angle-2");
      expect(output.brief.selectedAngle.id).toBe("angle-2");
      expect(output.brief.topic).toBe("Autonomous AI Toasters");
      expect(output.isMocked).toBe(false);
      expect(output.brief.isMocked).toBe(false);
      expect(() => ResearchBriefSchema.parse(output.brief)).not.toThrow();
    });

    it("runs on the model's own knowledge when nothing could be fetched, and says so", async () => {
      gatherSourcesMock.mockResolvedValue([]);
      generateJsonMock.mockResolvedValue(modelResearchDraft("Deep Sea Mining Permits", [
        {
          id: "fact-1",
          fact: "A fact the model dressed up with a citation it cannot have read.",
          sourceUrl: "https://example.org/never-fetched",
          sourceTitle: "Somewhere",
          category: "statistic",
          absurdityScore: 6,
        },
      ]));

      const output = await runPass1Research({ topic: "Deep Sea Mining Permits", showSkill: deskSkill });

      const call = generateJsonMock.mock.calls[0][0];
      expect(call.prompt).toContain("No sources could be fetched");
      expect(call.prompt).not.toContain("<sources>");
      expect(output.brief.searchMetadata).toEqual({
        enabled: false,
        searchQueriesUsed: ["Deep Sea Mining Permits"],
        groundingSources: [],
        groundingChunkCount: 0,
      });
      for (const fact of output.brief.groundedFacts) {
        expect(fact.sourceUrl).toBeUndefined();
        expect(fact.verified).toBe(false);
      }
    });

    it("skips fetching entirely when search is disabled", async () => {
      generateJsonMock.mockResolvedValue(modelResearchDraft("Office Chairs", [
        { id: "fact-1", fact: "A plain fact of sufficient length.", category: "statistic", absurdityScore: 3 },
      ]));

      const output = await runPass1Research({
        topic: "Office Chairs",
        showSkill: deskSkill,
        options: { enableSearch: false },
      });

      expect(gatherSourcesMock).not.toHaveBeenCalled();
      expect(output.brief.searchMetadata).toEqual({
        enabled: false,
        searchQueriesUsed: [],
        groundingSources: [],
        groundingChunkCount: 0,
      });
    });

    it("falls back to the first premise angle when the model names one that does not exist", async () => {
      const draft = modelResearchDraft("Smart Fridges", [
        { id: "fact-1", fact: "A plain fact of sufficient length.", category: "statistic", absurdityScore: 3 },
      ]);
      generateJsonMock.mockResolvedValue({ ...draft, selectedAngleId: "angle-does-not-exist" });

      const output = await runPass1Research({ topic: "Smart Fridges", showSkill: deskSkill });

      expect(output.brief.selectedAngleId).toBe(draft.premiseAngles[0].id);
      expect(output.selectedAngle).toEqual(output.brief.premiseAngles[0]);
    });

    it("drops a citation that is not a URL instead of rejecting the whole brief", () => {
      const draft = modelResearchDraft("Parking Meters", [
        { id: "fact-1", fact: "A plain fact of sufficient length.", sourceUrl: "N/A", sourceTitle: "  ", category: "statistic", absurdityScore: 3 },
      ]);
      const parsed = ResearchBriefDraftSchema.safeParse(draft);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.groundedFacts[0].sourceUrl).toBeUndefined();
        expect(parsed.data.groundedFacts[0].sourceTitle).toBeUndefined();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Pass 2: Head-Writer Draft & Joke Construction
  // ───────────────────────────────────────────────────────────────────────────
  describe("pass 2: Head-Writer Draft & Joke Construction", () => {
    it("plans video beats of 8 to 12 seconds, one MiniMax-H3 clip each", () => {
      expect(planVideoBeatSlots(8)).toEqual([8]);
      expect(planVideoBeatSlots(12)).toEqual([12]);
      expect(planVideoBeatSlots(16)).toEqual([8, 8]);
      expect(planVideoBeatSlots(24)).toEqual([12, 12]);
      expect(planVideoBeatSlots(32)).toEqual([11, 11, 10]);
      expect(planVideoBeatSlots(40)).toEqual([10, 10, 10, 10]);
      expect(planVideoBeatSlots(45)).toEqual([9, 9, 9, 9, 9]);
      expect(planVideoBeatSlots(64)).toEqual([11, 11, 11, 11, 10, 10]);
      expect(planVideoBeatSlots(90)).toEqual(Array.from({ length: 9 }, () => 10));
      expect(planVideoBeatSlots(120)).toEqual(Array.from({ length: 12 }, () => 10));

      for (let duration = 16; duration <= 300; duration++) {
        const slots = planVideoBeatSlots(duration);
        expect(slots.reduce((a, b) => a + b, 0)).toBe(duration);
        for (const slot of slots) {
          expect(slot).toBeGreaterThanOrEqual(8);
          expect(slot).toBeLessThanOrEqual(12);
        }
      }
      // Below 16 s a single slot (or the 8 + 7 split) stays inside H3's 4 to 15 s range.
      for (let duration = 4; duration < 16; duration++) {
        for (const slot of planVideoBeatSlots(duration)) {
          expect(slot).toBeGreaterThanOrEqual(4);
          expect(slot).toBeLessThanOrEqual(15);
        }
      }
    });

    it("budgets video beats across the acts like the fixed grid does, and keeps the 8 s grid for audio", () => {
      const video = planClipWordBudgets(40, deskSkill, "video");
      expect(video.map(b => b.durationSeconds)).toEqual([10, 10, 10, 10]);
      expect(video.map(b => [b.startTimeSeconds, b.endTimeSeconds])).toEqual([[0, 10], [10, 20], [20, 30], [30, 40]]);
      expect(video[0].assignedActId).toBe("act_1_thesis_hook");
      expect(video[1].assignedActId).toBe("act_2_evidence_analogies");
      expect(video[3].assignedActId).toBe("act_3_synthesis_cta");
      // 10 s at the skill's 2.5 words/second, in calculateClipWordBudgets' band
      expect(video[0].targetWordsMin).toBe(23);
      expect(video[0].targetWordsMax).toBe(26);

      expect(planClipWordBudgets(40, deskSkill, "audio")).toEqual(calculateClipWordBudgets(40, deskSkill, 8));
      expect(planClipWordBudgets(40, deskSkill)).toEqual(video);
    });

    it("synthesizes deterministic 3-act desk draft on the video beat plan", () => {
      const brief = createMockResearchBrief({ topic: "Smart Refrigerator DRM", showSkill: deskSkill });
      const draft = synthesizeDeterministicDeskDraft({
        researchBrief: brief,
        skill: deskSkill,
        durationSeconds: 40,
      });

      expect(draft.archetype).toBe("writers_room_desk");
      expect(draft.beats).toBeDefined();
      expect(draft.beats).toHaveLength(4); // 40s / ~10s = 4 beats

      // Verify each beat has word budget and a visual prompt
      let expectedStart = 0;
      for (const beat of draft.beats!) {
        expect(beat.durationSeconds).toBe(10);
        expect(beat.startTimeSeconds).toBe(expectedStart);
        expect(beat.endTimeSeconds).toBe(expectedStart + 10);
        expectedStart += 10;
        expect(beat.actualWordCount).toBeGreaterThanOrEqual(14);
        expect(beat.actualWordCount).toBeLessThanOrEqual(30);
        expect(beat.setup.length).toBeGreaterThan(10);
        expect(beat.punchline.length).toBeGreaterThan(10);
        expect(beat.visualPrompt.length).toBeGreaterThan(20);
        expect(beat.visualPrompt).toMatch(/(talk show set|desk|host|shot)/i);
      }

      // Verify callback resolution
      expect(draft.callbacks.length).toBeGreaterThanOrEqual(1);
      const callback = draft.callbacks[0];
      expect(callback.plantedInBeatId).toBe("beat-1");
      expect(callback.resolvedInBeatId).toBe("beat-3");

      // Verify rule of three beat exists
      const ruleOfThree = draft.beats!.find(b => b.mechanism === "rule_of_three");
      expect(ruleOfThree).toBeDefined();

      // Validate against Zod schema
      expect(() => HeadWriterDraftSchema.parse(draft)).not.toThrow();
    });

    it("keeps the 8-second clip granularity for audio episodes", () => {
      const brief = createMockResearchBrief({ topic: "Smart Refrigerator DRM", showSkill: deskSkill });
      const draft = synthesizeDeterministicDeskDraft({
        researchBrief: brief,
        skill: deskSkill,
        durationSeconds: 40,
        format: "audio",
      });

      expect(draft.beats).toHaveLength(5); // 40s / 8s = 5 clips
      for (const beat of draft.beats!) {
        expect(beat.durationSeconds).toBe(8);
      }
      expect(draft.callbacks[0].resolvedInBeatId).toBe("beat-4");
      expect(() => HeadWriterDraftSchema.parse(draft)).not.toThrow();
    });

    it("synthesizes deterministic podcast draft with dynamic turn-taking and acoustic tags", () => {
      const brief = createMockResearchBrief({ topic: "Ancient Egyptian Batteries", showSkill: podcastSkill });
      const draft = synthesizeDeterministicPodcastDraft({
        researchBrief: brief,
        skill: podcastSkill,
        durationSeconds: 120,
      });

      expect(draft.archetype).toBe("conversational_podcast");
      expect(draft.turns).toBeDefined();
      expect(draft.turns!.length).toBeGreaterThanOrEqual(5);

      // Verify turn types and acoustic cues
      const acousticTurns = draft.turns!.filter(t => t.acousticTags.length > 0);
      expect(acousticTurns.length).toBeGreaterThanOrEqual(2);

      const snapbackTurn = draft.turns!.find(t => t.turnType === "snapback");
      expect(snapbackTurn).toBeDefined();
      expect(snapbackTurn?.snapbackTriggered).toBe(true);

      const tangentTurns = draft.turns!.filter(t => t.isTangent);
      expect(tangentTurns.length).toBeGreaterThanOrEqual(1);

      // Validate against Zod schema
      expect(() => HeadWriterDraftSchema.parse(draft)).not.toThrow();
    });

    it("executes generateHeadWriterDraft with forceMock option", async () => {
      const brief = createMockResearchBrief({ topic: "Subprime Car Loans for AI", showSkill: deskSkill });
      const video = await generateHeadWriterDraft({
        researchBrief: brief,
        skill: deskSkill,
        durationSeconds: 32,
        options: { forceMock: true },
      });

      expect(video.archetype).toBe("writers_room_desk");
      expect(video.beats).toHaveLength(3); // 32s -> 11 + 11 + 10
      expect(video.beats!.map(b => b.durationSeconds)).toEqual([11, 11, 10]);
      expect(video.metrics.totalDurationSeconds).toBe(32);

      const audio = await generateHeadWriterDraft({
        researchBrief: brief,
        skill: deskSkill,
        durationSeconds: 32,
        format: "audio",
        options: { forceMock: true },
      });
      expect(audio.beats).toHaveLength(4); // 32s / 8s
      expect(generateJsonMock).not.toHaveBeenCalled();
    });

    it("asks MiniMax-M3 for exactly one beat per planned slot and snaps timings to the plan", async () => {
      const brief = createMockResearchBrief({ topic: "Municipal Drone Parking", showSkill: deskSkill });
      const skeleton = synthesizeDeterministicDeskDraft({ researchBrief: brief, skill: deskSkill, durationSeconds: 40 });
      // The model's copy of the timeline drifts; the pass must not trust it.
      const driftedBeats = skeleton.beats!.map((beat, index) => ({
        ...beat,
        startTimeSeconds: index * 8,
        endTimeSeconds: index * 8 + 8,
        durationSeconds: 8,
        actualWordCount: 999,
        fullText: `${beat.fullText}  `,
      }));
      const modelDraft = {
        showTitle: "Drones Over Downtown",
        beats: driftedBeats,
        callbacks: skeleton.callbacks,
        metrics: { ...skeleton.metrics, totalDurationSeconds: 32, totalWordCount: 1 },
        pass1Context: skeleton.pass1Context,
      };
      generateJsonMock.mockResolvedValue(modelDraft);

      const draft = await generateHeadWriterDraft({ researchBrief: brief, skill: deskSkill, durationSeconds: 40 });

      expect(generateJsonMock).toHaveBeenCalledTimes(1);
      const call = generateJsonMock.mock.calls[0][0];
      expect(call.temperature).toBe(0.85);
      expect(call.maxOutputTokens).toBe(65536);
      expect(call.system).toContain("MiniMax-H3");
      expect(call.system).not.toMatch(/8-second/i);
      expect(call.prompt).toContain("4 beats of 8 to 12 seconds each");
      expect(call.prompt).toContain("Beat 3 (30s - 40s, 10 s");
      expect(call.prompt).toContain("exactly 4 ComedicBeats");
      expect(call.prompt).toContain("HARD TOTAL WORD BUDGET: 98 words");
      // The schema carries the beat count so the repair round can name it.
      expect(call.schema.safeParse({ ...modelDraft, beats: driftedBeats.slice(0, 3) }).success).toBe(false);
      expect(call.schema.safeParse(modelDraft).success).toBe(true);

      expect(draft.showTitle).toBe("Drones Over Downtown");
      expect(draft.archetype).toBe("writers_room_desk");
      expect(draft.topic).toBe("Municipal Drone Parking");
      expect(draft.selectedPremise).toEqual(brief.selectedAngle);
      expect(draft.beats!.map(b => [b.startTimeSeconds, b.endTimeSeconds, b.durationSeconds])).toEqual([
        [0, 10, 10],
        [10, 20, 10],
        [20, 30, 10],
        [30, 40, 10],
      ]);
      expect(draft.beats![0].actualWordCount).toBe(skeleton.beats![0].actualWordCount);
      expect(draft.beats![3].actId).toBe("act_3_synthesis_cta");
      expect(draft.metrics.totalDurationSeconds).toBe(40);
      expect(draft.totalEstimatedSeconds).toBe(40);
      expect(() => HeadWriterDraftSchema.parse(draft)).not.toThrow();
    });

    it("describes the 8-second grid to the model for an audio desk episode", async () => {
      const brief = createMockResearchBrief({ topic: "Municipal Drone Parking", showSkill: deskSkill });
      const skeleton = synthesizeDeterministicDeskDraft({ researchBrief: brief, skill: deskSkill, durationSeconds: 40, format: "audio" });
      generateJsonMock.mockResolvedValue({
        showTitle: "Drones Over Downtown",
        beats: skeleton.beats,
        callbacks: skeleton.callbacks,
        metrics: skeleton.metrics,
        pass1Context: skeleton.pass1Context,
      });

      const draft = await generateHeadWriterDraft({ researchBrief: brief, skill: deskSkill, durationSeconds: 40, format: "audio" });

      const call = generateJsonMock.mock.calls[0][0];
      expect(call.prompt).toContain("5 beats of 8 seconds each");
      expect(draft.beats).toHaveLength(5);
      expect(draft.beats!.every(b => b.durationSeconds === 8)).toBe(true);
    });

    it("pins every podcast turn to the only host on a solo format", async () => {
      const soloSkill = getShowSkill("apocalyptic-satire")!;
      expect(soloSkill.hosts).toHaveLength(1);
      const brief = createMockResearchBrief({ topic: "Subscription Creep", showSkill: soloSkill });
      const skeleton = synthesizeDeterministicPodcastDraft({ researchBrief: brief, skill: soloSkill, durationSeconds: 120 });
      generateJsonMock.mockResolvedValue({
        showTitle: "The Last Free Trial",
        turns: skeleton.turns!.map((turn, index) => index % 2 === 0 ? turn : { ...turn, speaker: "Producer", role: "guest", ttsVoice: "whoever" }),
        callbacks: [],
        metrics: skeleton.metrics,
        pass1Context: skeleton.pass1Context,
      });

      const draft = await generateHeadWriterDraft({ researchBrief: brief, skill: soloSkill, durationSeconds: 120 });

      expect(draft.archetype).toBe("conversational_podcast");
      expect(draft.showId).toMatch(/^show-podcast-/);
      expect(new Set(draft.turns!.map(t => t.speaker))).toEqual(new Set([soloSkill.hosts[0].name]));
      expect(draft.turns!.every(t => t.ttsVoice === soloSkill.hosts[0].ttsVoice)).toBe(true);
      expect(generateJsonMock.mock.calls[0][0].system).not.toContain("Charon");
    });

    it("fails instead of substituting the deterministic skeleton when the model call fails", async () => {
      const brief = createMockResearchBrief({ topic: "Anything", showSkill: deskSkill });
      generateJsonMock.mockRejectedValue(new Error("pass2-head-writer: MiniMax-M3 did not return valid JSON after 2 attempts"));

      await expect(generateHeadWriterDraft({ researchBrief: brief, skill: deskSkill, durationSeconds: 40 }))
        .rejects
        .toThrow(/MiniMax-M3/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Pass 3: Voice Tuning, Table-Read Critic & Pre-Flight Content-Filter Safety
  // ───────────────────────────────────────────────────────────────────────────
  describe("pass 3: Voice Tuning, Table-Read Critic & Pre-Flight Content-Filter Safety", () => {
    it("sanitizes studio trademarks, living celebrity names, and biometric triggers for the video content filter", () => {
      const dirtyPrompt = "A photorealistic identical clone of John Oliver on the HBO set of Last Week Tonight with Seth Meyers and Colin Jost.";
      const { sanitizedText, report } = sanitizeForContentFilter(dirtyPrompt);

      expect(sanitizedText).not.toContain("HBO");
      expect(sanitizedText).not.toContain("Last Week Tonight");
      expect(sanitizedText).not.toContain("John Oliver");
      expect(sanitizedText).not.toContain("Seth Meyers");
      expect(sanitizedText).not.toContain("Colin Jost");
      expect(sanitizedText).not.toContain("photorealistic identical clone of");

      expect(sanitizedText).toContain("premium cable broadcast");
      expect(sanitizedText).toContain("investigative comedy deep-dive");
      expect(sanitizedText).toContain("John");
      expect(sanitizedText).toContain("Seth");
      expect(sanitizedText).toContain("Colin");
      expect(report.isCleanForContentFilter).toBe(true);
      expect(report.replacementsApplied.length).toBeGreaterThanOrEqual(4);
    });

    it("enforces profanity register filters cleanly", () => {
      const vulgarText = "This fucking system is total shit and the asshole CEO knows it.";
      const clean = enforceProfanityRegister(vulgarText, "clean");

      expect(clean).not.toContain("fucking");
      expect(clean).not.toContain("shit");
      expect(clean).not.toContain("asshole");
      expect(clean).toContain("frick");
      expect(clean).toContain("crap");
    });

    it("applies stylometric voice tuning and detects catchphrases", () => {
      const text = "Look, this is completely bonkers. That is not hyperbole, that is the actual rule. Cool. Great system.";
      const result = applyStylometricVoiceTuning(text, deskSkill);

      expect(result.meanSentenceLength).toBeGreaterThan(0);
      expect(result.tunedText).toBeDefined();
    });

    it("calculates table-read joke composite scores using 0.35/0.35/0.30 formula", () => {
      const score = calculateJokeCompositeScore(8.0, 9.0, 7.0);
      // (8 * 0.35) + (9 * 0.35) + (7 * 0.30) = 2.8 + 3.15 + 2.1 = 8.05
      expect(score).toBe(8.05);
    });

    it("evaluates jokes deterministically in table-read critic", () => {
      const evalResult = evaluateSingleJokeDeterministic(
        "Look at their customer service policy:",
        "It legally transfers your home mortgage to an emotional support badger.",
        0,
      );

      expect(evalResult.compositeScore).toBeGreaterThanOrEqual(7.0);
      expect(evalResult.passed).toBe(true);
      expect(evalResult.critique).toBeDefined();
    });

    it("runs Pass 3 voice and prune end-to-end to produce a validated FinalScript", async () => {
      const brief = createMockResearchBrief({ topic: "Smart Microwaves", showSkill: deskSkill });
      const draft = synthesizeDeterministicDeskDraft({
        researchBrief: brief,
        skill: deskSkill,
        durationSeconds: 40,
      });

      const pass3Output = await runPass3VoiceAndPrune({
        draft,
        skill: deskSkill,
        options: { forceMock: true },
      });

      const { finalScript } = pass3Output;
      expect(finalScript.title).toBe(draft.showTitle);
      expect(finalScript.segments).toHaveLength(4);
      expect(finalScript.tableReadReport.totalJokes).toBe(4);
      expect(finalScript.tableReadReport.averageScore).toBeGreaterThanOrEqual(7.0);
      expect(finalScript.sanitizationReport.isCleanForContentFilter).toBe(true);
      expect(finalScript.transcriptPlainText).toContain(finalScript.segments[0].speaker);
      expect(generateTextMock).not.toHaveBeenCalled();

      // Validate against Zod schema
      expect(() => FinalScriptSchema.parse(finalScript)).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Unified Dramaturgy Orchestrator Pipeline
  // ───────────────────────────────────────────────────────────────────────────
  describe("unified Dramaturgy Orchestrator", () => {
    it("executes the complete 3-pass pipeline for Desk Show (Archetype A)", async () => {
      const events: string[] = [];

      const result = await runDramaturgyPipeline(
        {
          showId: "test-desk-show-123",
          topic: "Autonomous AI Law Firms",
          templateId: "investigative-desk",
          durationSeconds: 40,
          familiarity: "familiar",
          options: { forceMock: true },
        },
        async (event) => {
          events.push(event.step);
        },
      );

      expect(events).toContain("research");
      expect(events).toContain("script_draft");
      expect(events).toContain("voice_prune");
      expect(events).toContain("complete");

      expect(result.showId).toBe("test-desk-show-123");
      expect(result.skill.archetype).toBe("writers_room_desk");
      expect(result.researchBrief.groundedFacts.length).toBeGreaterThanOrEqual(3);
      expect(result.headWriterDraft.beats).toHaveLength(4);
      expect(result.finalScript.segments).toHaveLength(4);
      expect(result.finalScript.segments.map(s => s.durationSeconds)).toEqual([10, 10, 10, 10]);
      expect(result.executionMetrics.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.executionMetrics.jokesEvaluated).toBe(4);
      expect(generateJsonMock).not.toHaveBeenCalled();
      expect(generateTextMock).not.toHaveBeenCalled();

      // Validate master result schema
      expect(() => DramaturgyResultSchema.parse(result)).not.toThrow();
    });

    it("keeps the 8-second grid when the show is an audio episode", async () => {
      const result = await runDramaturgyPipeline({
        showId: "test-desk-audio-789",
        topic: "Autonomous AI Law Firms",
        templateId: "investigative-desk",
        durationSeconds: 40,
        format: "audio",
        options: { forceMock: true },
      });

      expect(result.finalScript.segments).toHaveLength(5);
      expect(result.finalScript.segments.every(s => s.durationSeconds === 8)).toBe(true);
      expect(() => DramaturgyResultSchema.parse(result)).not.toThrow();
    });

    it("executes the complete 3-pass pipeline for Podcast (Archetype B)", async () => {
      const result = await runDramaturgyPipeline({
        showId: "test-podcast-456",
        topic: "Interdimensional Signal Decoding",
        templateId: "speculative-podcast",
        durationSeconds: 120,
        familiarity: "expert",
        options: { forceMock: true },
      });

      expect(result.showId).toBe("test-podcast-456");
      expect(result.skill.archetype).toBe("conversational_podcast");
      expect(result.finalScript.segments.length).toBeGreaterThanOrEqual(5);
      expect(result.finalScript.showType).toBe("conversation");
      expect(result.finalScript.transcriptPlainText.length).toBeGreaterThan(100);

      expect(() => DramaturgyResultSchema.parse(result)).not.toThrow();
    });
  });
});
