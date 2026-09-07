import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";

import {
  applyConceptDecay,
  buildCognitiveMemoryBankContext,
  buildPersonalizedPromptContext,
  calculateBoostedConfidence,
  calculateDecayedConfidence,
  formatProceduralMemory,
  formatWorkingMemory,
  getMasteryLabel,
  getMasteryLevelFromConfidence,
  getMemorySummary,
  getProceduralMemory,
  getSemanticMemory,
  getShowTangents,
  getUserMemories,
  getUserTangents,
  getWorkingMemory,
  MemoryExtractionSchema,
  updateMemoryFromInteraction,
} from "./memory-bank";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const { mockGenerateJson, mockGenerateText, mockSearchVideoChunks } = vi.hoisted(() => ({
  mockGenerateJson: vi.fn(),
  mockGenerateText: vi.fn(),
  mockSearchVideoChunks: vi.fn(),
}));

vi.mock("@/app/lib/env", () => ({
  env: {
    GMI_CLOUD_APIKEY: "test-gmi-key",
    DATABASE_URL: "postgresql://localhost:5432/test",
  },
}));

vi.mock("./env", () => ({
  env: {
    GMI_CLOUD_APIKEY: "test-gmi-key",
    DATABASE_URL: "postgresql://localhost:5432/test",
  },
}));

// The model boundary. generateJson's contract is "the reply, parsed and
// validated by the caller's schema", so the mock runs the schema the module
// hands it over a raw reply object, exactly as the real function would after
// extracting the JSON.
vi.mock("@/app/lib/gmi/text", () => ({
  generateJson: mockGenerateJson,
  generateText: mockGenerateText,
}));

vi.mock("@/db/search", () => ({
  searchVideoChunks: mockSearchVideoChunks,
}));

function queueModelReply(reply: unknown) {
  mockGenerateJson.mockImplementationOnce(async ({ schema: replySchema }: { schema: { parse: (v: unknown) => unknown } }) => replySchema.parse(reply));
}

// In-memory test state for DB tables
let mockDbMemories: any[] = [];
let mockDbChatMessages: any[] = [];
let mockDbTangents: any[] = [];
let mockInsertCalls: any[] = [];
let mockUpdateCalls: any[] = [];

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

function createQueryBuilder(table: any) {
  let limitCount: number | undefined;

  const getResults = () => {
    if (table === schema.chatMessages || (table?.showId && !table?.question)) {
      return [...mockDbChatMessages];
    }
    if (table === schema.showTangents || table?.question) {
      return [...mockDbTangents];
    }
    return [...mockDbMemories];
  };

  const builder: any = {
    where: vi.fn().mockImplementation(() => builder),
    orderBy: vi.fn().mockImplementation(() => builder),
    limit: vi.fn().mockImplementation((lim: number) => {
      limitCount = lim;
      return builder;
    }),
    then: (resolve: (val: any) => any, reject?: (reason: any) => any) => {
      let results = getResults();
      if (limitCount !== undefined) {
        results = results.slice(0, limitCount);
      }
      return Promise.resolve(results).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn().mockReturnValue({
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: any) => createQueryBuilder(table)),
    })),
    insert: vi.fn().mockImplementation((table: any) => ({
      values: vi.fn().mockImplementation((val: any) => {
        mockInsertCalls.push(val);
        const record = { id: `id-${Date.now()}-${Math.random()}`, ...val, createdAt: new Date(), updatedAt: new Date() };
        if (table === schema.showTangents || val.question) {
          mockDbTangents.push(record);
        } else if (table === schema.chatMessages || val.role) {
          mockDbChatMessages.push(record);
        } else {
          mockDbMemories.push(record);
        }
        return {
          returning: vi.fn().mockResolvedValue([record]),
          then: (resolve: (val: any) => any, reject?: (reason: any) => any) => Promise.resolve([record]).then(resolve, reject),
        };
      }),
    })),
    update: vi.fn().mockImplementation((_table: any) => ({
      set: vi.fn().mockImplementation((val: any) => ({
        where: vi.fn().mockImplementation(() => {
          mockUpdateCalls.push(val);
          return {
            returning: vi.fn().mockResolvedValue([{ id: "updated-record", ...val }]),
            then: (resolve: (val: any) => any, reject?: (reason: any) => any) => Promise.resolve([{ id: "updated-record", ...val }]).then(resolve, reject),
          };
        }),
      })),
    })),
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

describe("persistent cognitive memory bank", () => {
  beforeEach(() => {
    mockGenerateJson.mockReset();
    mockGenerateText.mockReset();
    mockSearchVideoChunks.mockReset();
    mockDbMemories = [];
    mockDbChatMessages = [];
    mockDbTangents = [];
    mockInsertCalls = [];
    mockUpdateCalls = [];
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 1: 4-Tier Memory Retrieval & Synthesis
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 1: 4-tier memory retrieval & synthesis", () => {
    it("computes MemorySummary aggregating concept mastery, interests, humor preferences, and recent questions", async () => {
      mockDbMemories = [
        {
          id: "mem-1",
          userId: "user-123",
          memoryType: "humor_preference",
          key: "humor",
          value: "Sharp, dry British satire with escalating analogies",
          confidence: 0.95,
          updatedAt: new Date(),
        },
        {
          id: "mem-2",
          userId: "user-123",
          memoryType: "concept_mastery",
          key: "quantum-computing",
          value: "Expert level",
          confidence: 0.9,
          updatedAt: new Date(),
        },
        {
          id: "mem-3",
          userId: "user-123",
          memoryType: "interest_topic",
          key: "ai-agents",
          value: "autonomous systems",
          confidence: 0.88,
          updatedAt: new Date(),
        },
        {
          id: "mem-4",
          userId: "user-123",
          memoryType: "question_pattern",
          key: "q1",
          value: "How does MiniMax-H3 keep a host's face consistent across clips?",
          confidence: 1.0,
          updatedAt: new Date(),
        },
      ];

      const summary = await getMemorySummary("user-123");

      expect(summary.totalMemories).toBe(4);
      expect(summary.humorPreference).toBe("Sharp, dry British satire with escalating analogies");
      expect(summary.interests).toEqual(["ai-agents"]);
      expect(summary.conceptMastery).toHaveLength(1);
      expect(summary.conceptMastery[0].concept).toBe("quantum-computing");
      expect(summary.conceptMastery[0].level).toBe("Expert level");
      expect(summary.conceptMastery[0].confidence).toBe(0.9);
      expect(summary.recentQuestions).toEqual(["How does MiniMax-H3 keep a host's face consistent across clips?"]);
    });

    it("handles empty memory bank gracefully and returns fallback defaults", async () => {
      mockDbMemories = [];

      const summary = await getMemorySummary("empty-user");

      expect(summary.totalMemories).toBe(0);
      expect(summary.conceptMastery).toEqual([]);
      expect(summary.interests).toEqual([]);
      expect(summary.recentQuestions).toEqual([]);
      expect(summary.humorPreference).toBe("Sharp, witty satire with clear punchlines");
    });

    it("deduplicates repetitive interest topics and questions while preserving unique entries", async () => {
      mockDbMemories = [
        { memoryType: "interest_topic", key: "ai-agents", value: "tag1", updatedAt: new Date() },
        { memoryType: "interest_topic", key: "ai-agents", value: "duplicate tag", updatedAt: new Date() },
        { memoryType: "interest_topic", key: "robotics", value: "tag2", updatedAt: new Date() },
        { memoryType: "question_pattern", key: "q1", value: "What is MiniMax-H3?", updatedAt: new Date() },
        { memoryType: "question_pattern", key: "q2", value: "What is MiniMax-H3?", updatedAt: new Date() },
        { memoryType: "question_pattern", key: "q3", value: "How fast is MiniMax-M3?", updatedAt: new Date() },
      ];

      const summary = await getMemorySummary("user-dups");

      expect(summary.interests).toEqual(["ai-agents", "robotics"]);
      expect(summary.recentQuestions).toEqual(["What is MiniMax-H3?", "How fast is MiniMax-M3?"]);
    });

    it("caps summary arrays to prevent prompt bloat (max 10 concepts, 10 interests, 5 questions)", async () => {
      mockDbMemories = [
        ...Array.from({ length: 15 }, (_, i) => ({
          memoryType: "concept_mastery",
          key: `concept-${i}`,
          value: "Familiar",
          confidence: 0.6,
          updatedAt: new Date(),
        })),
        ...Array.from({ length: 15 }, (_, i) => ({
          memoryType: "interest_topic",
          key: `interest-${i}`,
          value: "topic",
          updatedAt: new Date(),
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          memoryType: "question_pattern",
          key: `q-${i}`,
          value: `Question ${i}?`,
          updatedAt: new Date(),
        })),
      ];

      const summary = await getMemorySummary("user-large");

      expect(summary.totalMemories).toBe(40);
      expect(summary.conceptMastery.length).toBe(10);
      expect(summary.interests.length).toBe(10);
      expect(summary.recentQuestions.length).toBe(5);
    });

    it("formats working memory turns correctly", () => {
      const messages = [
        { role: "user", content: "Tell me about quantum supremacy." },
        { role: "assistant", content: "Quantum supremacy refers to solving problems classical computers cannot." },
      ];

      const formatted = formatWorkingMemory(messages);

      expect(formatted).toContain("[USER]: Tell me about quantum supremacy.");
      expect(formatted).toContain("[ASSISTANT]: Quantum supremacy refers to solving problems classical computers cannot.");

      expect(formatWorkingMemory([])).toBe("No recent working conversation turns.");
    });

    it("retrieves working memory from database", async () => {
      mockDbChatMessages = [
        { id: "msg-1", showId: "show-123", role: "user", content: "Hello", createdAt: new Date() },
      ];

      const messages = await getWorkingMemory("show-123");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");
    });

    it("resolves and formats procedural memory for show archetypes", () => {
      const deskSkill = getProceduralMemory("writers_room_desk");
      expect(deskSkill).toBeDefined();
      expect(deskSkill.archetype).toBe("writers_room_desk");

      const formatted = formatProceduralMemory("writers_room_desk");
      expect(formatted).toContain("=== PROCEDURAL CRAFT MEMORY");
      expect(formatted).toContain("Archetype: Writers'-Room Desk Show");
      expect(formatted).toContain("Target Laughs-Per-Minute:");
      expect(formatted).toContain("Profanity Register:");
      expect(formatted).toContain("Host Voice & Persona Bindings:");
    });

    it("builds comprehensive 4-tier cognitive memory bank context", async () => {
      mockDbMemories = [
        { memoryType: "interest_topic", key: "distributed-systems", value: "cloud", updatedAt: new Date() },
      ];
      mockDbChatMessages = [
        { role: "user", content: "Can you explain RAFT consensus?" },
      ];

      const cognitiveContext = await buildCognitiveMemoryBankContext({
        userId: "user-4tier",
        showId: "show-4tier",
        skillIdOrSlug: "investigative-desk",
      });

      expect(cognitiveContext.workingMemory).toContain("[USER]: Can you explain RAFT consensus?");
      expect(cognitiveContext.episodicSummary.interests).toContain("distributed-systems");
      expect(cognitiveContext.proceduralCraft).toContain("JOHN OLIVER LIKE");
      expect(cognitiveContext.promptBlock).toContain("=== PERSISTENT USER MEMORY BANK ===");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 2: Concept Mastery Dynamics (Decay & Boost Models)
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 2: concept mastery boost & temporal decay models", () => {
    it("calculates boosted confidence on repeated interactions with alpha = 0.30", () => {
      // C_new = min(1.0, C_old + 0.3 * (1.0 - C_old))
      expect(calculateBoostedConfidence(0.5, 0.3)).toBe(0.65);
      expect(calculateBoostedConfidence(0.8, 0.3)).toBe(0.86);
      expect(calculateBoostedConfidence(0.95, 0.3)).toBe(0.965);
      expect(calculateBoostedConfidence(1.0, 0.3)).toBe(1.0);
      expect(calculateBoostedConfidence(0.0, 0.3)).toBe(0.3);
    });

    it("decays confidence score over time according to 30-day half-life Ebbinghaus curve", () => {
      // 0 days elapsed -> no decay
      expect(calculateDecayedConfidence(1.0, 0, 30)).toBe(1.0);

      // 30 days elapsed -> 50% decay (1.0 * 2^(-1) = 0.5)
      expect(calculateDecayedConfidence(1.0, 30, 30)).toBe(0.5);

      // 60 days elapsed -> 75% decay (1.0 * 2^(-2) = 0.25)
      expect(calculateDecayedConfidence(1.0, 60, 30)).toBe(0.25);

      // 15 days elapsed -> (1.0 * 2^(-0.5) ≈ 0.707)
      expect(calculateDecayedConfidence(1.0, 15, 30)).toBe(0.707);

      // Negative days elapsed (time anomaly) should not boost
      expect(calculateDecayedConfidence(0.8, -10, 30)).toBe(0.8);
    });

    it("transitions mastery labels (beginner -> familiar -> expert) as confidence crosses thresholds", () => {
      expect(getMasteryLevelFromConfidence(0.95)).toBe("expert");
      expect(getMasteryLevelFromConfidence(0.75)).toBe("expert");
      expect(getMasteryLevelFromConfidence(0.74)).toBe("familiar");
      expect(getMasteryLevelFromConfidence(0.35)).toBe("familiar");
      expect(getMasteryLevelFromConfidence(0.34)).toBe("beginner");
      expect(getMasteryLevelFromConfidence(0.10)).toBe("beginner");

      expect(getMasteryLabel(0.80)).toBe("Expert level");
      expect(getMasteryLabel(0.50)).toBe("Familiar");
      expect(getMasteryLabel(0.20)).toBe("Beginner level");
    });

    it("applies temporal decay to dated memories when evaluating summary", async () => {
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const decayedResult = applyConceptDecay(1.0, sixtyDaysAgo, new Date(), 30);

      // 1.0 decayed over 60 days (2 half-lives) -> 0.25 ("Beginner level")
      expect(decayedResult.confidence).toBe(0.25);
      expect(decayedResult.slug).toBe("beginner");
      expect(decayedResult.level).toBe("Beginner level");

      mockDbMemories = [
        {
          id: "mem-decay",
          userId: "user-decay",
          memoryType: "concept_mastery",
          key: "quantum-mechanics",
          value: "Expert level",
          confidence: 1.0,
          updatedAt: sixtyDaysAgo,
        },
      ];

      const summary = await getMemorySummary("user-decay", { now: new Date() });
      expect(summary.conceptMastery[0].confidence).toBe(0.25);
      expect(summary.conceptMastery[0].level).toBe("Beginner level");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 3: Personalized Prompt Context Formatting
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 3: personalized prompt context formatting", () => {
    it("returns neutral guidance string when user has zero stored memories", async () => {
      mockDbMemories = [];

      const prompt = await buildPersonalizedPromptContext("user-empty");

      expect(prompt).toBe("No prior user interaction history. Maintain standard balanced conversational tone.");
    });

    it("includes all active memory sections (Tone, Interests, Concepts, Questions) when available", async () => {
      mockDbMemories = [
        { memoryType: "humor_preference", key: "humor", value: "Absurdist deadpan with scientific analogies", updatedAt: new Date() },
        { memoryType: "interest_topic", key: "neural-interfaces", value: "biotech", updatedAt: new Date() },
        { memoryType: "concept_mastery", key: "bci-hardware", value: "Expert level", confidence: 0.9, updatedAt: new Date() },
        { memoryType: "question_pattern", key: "q1", value: "How do invasive electrodes prevent glial scarring?", updatedAt: new Date() },
      ];

      const prompt = await buildPersonalizedPromptContext("user-rich");

      expect(prompt).toContain("=== PERSISTENT USER MEMORY BANK ===");
      expect(prompt).toContain("Preferred Tone/Humor: Absurdist deadpan with scientific analogies");
      expect(prompt).toContain("Known User Interests: neural-interfaces");
      expect(prompt).toContain("User Concept Mastery: bci-hardware (Expert level)");
      expect(prompt).toContain("Recent Questions Asked by User:\n- How do invasive electrodes prevent glial scarring?");
      expect(prompt).toContain("Instruction: Adapt your explanation depth, humor, and analogies");
    });

    it("provides custom instructions for on-demand tangent generation", async () => {
      mockDbMemories = [
        { memoryType: "humor_preference", key: "humor", value: "Fast-paced topical satire", updatedAt: new Date() },
      ];

      const prompt = await buildPersonalizedPromptContext("user-tangent", { showType: "tangent" });

      expect(prompt).toContain("Instruction: Provide an on-demand tangent tailored to this listener's known mastery level");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 4: Autonomous Memory Extractor (MiniMax-M3 structured output)
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 4: autonomous memory extractor (minimax-m3 structured output)", () => {
    it("hands generateJson the extraction schema, a label, and the full interaction", async () => {
      queueModelReply({ memories: [] });

      await updateMemoryFromInteraction(
        "user-call",
        "Why do coral reefs bleach?",
        "Heat stress evicts the algae that feed them.",
        "Ocean Science",
        "show-uuid-0",
      );

      expect(mockGenerateJson).toHaveBeenCalledTimes(1);
      const call = mockGenerateJson.mock.calls[0][0];
      expect(call.schema).toBe(MemoryExtractionSchema);
      expect(call.label).toBe("memory-extraction");
      expect(call.prompt).toContain("TOPIC: Ocean Science");
      expect(call.prompt).toContain("USER MESSAGE: Why do coral reefs bleach?");
      expect(call.prompt).toContain("ASSISTANT RESPONSE: Heat stress evicts the algae that feed them.");
      expect(mockInsertCalls.length).toBe(0);
    });

    it("parses the MiniMax-M3 extraction envelope and inserts new memories into database", async () => {
      queueModelReply({
        memories: [
          {
            memoryType: "concept_mastery",
            key: "transformers-architecture",
            value: "Expert level",
            confidence: 0.9,
          },
          {
            memoryType: "interest_topic",
            key: "gpu-clusters",
            value: "high performance computing",
            confidence: 0.85,
          },
        ],
      });

      await updateMemoryFromInteraction(
        "user-extract-1",
        "How do self-attention heads compute cross-batch weights?",
        "Self-attention uses query-key dot products scaled by square root of head dimension.",
        "Machine Learning",
        "show-uuid-1",
      );

      expect(mockInsertCalls.length).toBe(2);
      expect(mockInsertCalls[0].key).toBe("transformers-architecture");
      expect(mockInsertCalls[0].memoryType).toBe("concept_mastery");
      expect(mockInsertCalls[0].confidence).toBe(0.9);
      expect(mockInsertCalls[0].sourceShowId).toBe("show-uuid-1");
      expect(mockInsertCalls[1].key).toBe("gpu-clusters");
    });

    it("updates and boosts existing concept mastery memory when matching (userId, memoryType, key) exists", async () => {
      mockDbMemories = [
        {
          id: "existing-concept-1",
          userId: "user-boost",
          memoryType: "concept_mastery",
          key: "quantum-teleportation",
          value: "Familiar",
          confidence: 0.60,
          updatedAt: new Date(),
        },
      ];

      queueModelReply({
        memories: [
          {
            memoryType: "concept_mastery",
            key: "quantum-teleportation",
            value: "Expert level understanding",
            confidence: 0.85,
          },
        ],
      });

      await updateMemoryFromInteraction(
        "user-boost",
        "Explain Bell state entanglement in teleportation circuits.",
        "Bell states maximize entanglement entropy for qubit state transfers.",
        "Quantum Computing",
        "show-uuid-2",
      );

      // Boosted confidence from 0.60 + 0.3 * (1 - 0.6) = 0.72
      expect(mockUpdateCalls.length).toBe(1);
      expect(mockUpdateCalls[0].value).toBe("Expert level understanding");
      expect(mockUpdateCalls[0].confidence).toBe(0.72);
    });

    it("gracefully handles a reply that never became valid JSON without throwing unhandled exceptions", async () => {
      mockGenerateJson.mockRejectedValueOnce(
        new Error("memory-extraction: MiniMax-M3 did not return valid JSON after 2 attempts: No JSON object or array found in the model reply"),
      );

      await expect(
        updateMemoryFromInteraction("user-err", "test", "test", "topic"),
      ).resolves.not.toThrow();

      expect(mockInsertCalls.length).toBe(0);
    });

    it("ignores empty or invalid memory objects lacking required fields", async () => {
      queueModelReply({
        memories: [
          { key: "", value: "val", memoryType: "interest_topic" },
          { key: "valid-key", value: "", memoryType: "interest_topic" },
          { key: "valid-key-2", value: "valid-val" }, // missing memoryType
          { key: "valid-key-3", value: "valid-val-3", memoryType: "interest_topic" },
        ],
      });

      await updateMemoryFromInteraction("user-invalid-items", "query", "reply", "topic");

      expect(mockInsertCalls.length).toBe(1);
      expect(mockInsertCalls[0].key).toBe("valid-key-3");
    });

    it("keeps a memory whose confidence is out of range and falls back to the default confidence", async () => {
      queueModelReply({
        memories: [
          { key: "orbital-mechanics", value: "Familiar", memoryType: "concept_mastery", confidence: 1.7 },
        ],
      });

      await updateMemoryFromInteraction("user-conf", "query", "reply", "topic");

      expect(mockInsertCalls.length).toBe(1);
      expect(mockInsertCalls[0].key).toBe("orbital-mechanics");
      expect(mockInsertCalls[0].confidence).toBe(1.0);
    });

    it("treats a missing or null memories array as nothing learned", () => {
      expect(MemoryExtractionSchema.parse({}).memories).toEqual([]);
      expect(MemoryExtractionSchema.parse({ memories: null }).memories).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 5: Dynamic Tangents & Semantic Search Integration
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 5: dynamic tangents & semantic search integration", () => {
    it("retrieves user tangents and show tangents with limit", async () => {
      mockDbTangents = [
        { id: "tan-1", userId: "user-t", showId: "show-1", question: "Why do bees dance?", scriptText: "Monologue", createdAt: new Date() },
        { id: "tan-2", userId: "user-t", showId: "show-1", question: "How does honey not spoil?", scriptText: "Monologue 2", createdAt: new Date() },
      ];

      const userTangents = await getUserTangents("user-t", 10);
      expect(userTangents).toHaveLength(2);

      const showTangents = await getShowTangents("show-1");
      expect(showTangents).toHaveLength(2);
    });

    it("retrieves and maps full-text search hits into semantic memory items", async () => {
      mockSearchVideoChunks.mockResolvedValueOnce([
        {
          chunk_id: "chunk-1",
          mux_asset_id: "mux-asset-1",
          similarity_score: 0.89,
          title: "Quantum Show",
          summary: "Episode on superposition",
          start_time: 12.5,
          end_time: 25.0,
        },
      ]);

      const results = await getSemanticMemory("quantum computing", 3);

      expect(mockSearchVideoChunks).toHaveBeenCalledWith("quantum computing", 3);
      expect(results).toHaveLength(1);
      expect(results[0].chunkId).toBe("chunk-1");
      expect(results[0].similarityScore).toBe(0.89);
      expect(results[0].title).toBe("Quantum Show");
    });

    it("gracefully catches and recovers from semantic search errors", async () => {
      mockSearchVideoChunks.mockRejectedValueOnce(new Error("Rate limit exceeded"));

      const results = await getSemanticMemory("failing query", 3);

      expect(results).toEqual([]);
    });

    it("retrieves user memories via getUserMemories", async () => {
      mockDbMemories = [
        { id: "mem-x", userId: "user-x", memoryType: "interest_topic", key: "astronomy", value: "stars", confidence: 1.0, updatedAt: new Date() },
      ];

      const memories = await getUserMemories("user-x");
      expect(memories).toHaveLength(1);
      expect(memories[0].key).toBe("astronomy");
    });
  });
});
