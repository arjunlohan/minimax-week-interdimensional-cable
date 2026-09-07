import { buildPersonalizedPromptContext, getMemorySummary } from "@/app/lib/memory-bank";
import { resolveSkillForShow } from "@/app/lib/skills/registry";

import { runPass1Research } from "./pass1-research";
import { generateHeadWriterDraft } from "./pass2-head-writer";
import { runPass3VoiceAndPrune } from "./pass3-voice-prune";
import { DramaturgyResultSchema, ResearchBriefSchema } from "./schemas";
import type {
  DramaturgyInput,
  DramaturgyProgressEvent,
  DramaturgyResult,
  PersonalizationContext,
  ResearchBrief,
} from "./types";

export async function runDramaturgyPipeline(
  input: DramaturgyInput,
  onProgress?: (event: DramaturgyProgressEvent) => Promise<void>,
): Promise<DramaturgyResult> {
  const totalStartTime = Date.now();

  // 1. Skill Resolution
  const skill = resolveSkillForShow(input.skillIdOrSlug || input.templateId);

  // 2. Personalization / Memory Bank RAG Context
  let personalizationProfile: PersonalizationContext | undefined;
  if (input.userId) {
    try {
      // Gate on real memories. With an empty bank buildPersonalizedPromptContext
      // still returns a "no prior history" sentence, and injecting that would
      // change the prompt on every first-time run for no benefit.
      const summary = await getMemorySummary(input.userId);
      if (summary.totalMemories > 0) {
        const memoryContext = await buildPersonalizedPromptContext(input.userId);
        personalizationProfile = {
          humorPreference: memoryContext,
        };
        console.log(
          `[dramaturgy-orchestrator] Personalizing from ${summary.totalMemories} memories`,
          `(${summary.conceptMastery.length} tracked concepts)`,
        );
      }
    } catch (err) {
      console.warn("[dramaturgy-orchestrator] Could not load user memory bank context:", err);
    }
  }

  // 3. Pass 1: Grounded Research & Premise Seed
  if (onProgress) {
    await onProgress({
      step: "research",
      message: `Researching topic with MiniMax-M3 and fetched sources: "${input.topic}"...`,
      progressFraction: 0.25,
    });
  }

  const p1StartTime = Date.now();
  const suppliedBrief = input.researchBrief ? ResearchBriefSchema.safeParse(input.researchBrief) : null;
  if (input.researchBrief && !suppliedBrief?.success) {
    console.warn("[dramaturgy-orchestrator] Supplied research brief failed validation; researching again");
  }
  const pass1Result = suppliedBrief?.success ?
      {
        brief: suppliedBrief.data as ResearchBrief,
        selectedAngle: (suppliedBrief.data as ResearchBrief).selectedAngle,
        isMocked: Boolean((suppliedBrief.data as ResearchBrief).isMocked),
        latencyMs: 0,
      } :
      await runPass1Research({
        topic: input.topic,
        topicType: input.topicType,
        familiarity: input.familiarity,
        showSkill: skill,
        userProfile: personalizationProfile ? { humorPreference: typeof personalizationProfile.humorPreference === "string" ? personalizationProfile.humorPreference : undefined } : undefined,
        options: {
          enableSearch: input.options?.enableSearch ?? true,
          forceMock: input.options?.forceMock ?? false,
          temperature: input.options?.temperature,
        },
      });
  const pass1DurationMs = Date.now() - p1StartTime;

  // 4. Pass 2: Head-Writer Draft & Joke Construction
  if (onProgress) {
    await onProgress({
      step: "script_draft",
      message: `Head writer drafting ${skill.archetype === "writers_room_desk" ? "3-act desk script" : "podcast dialogue graph"} for ${skill.name}...`,
      progressFraction: 0.65,
    });
  }

  const p2StartTime = Date.now();
  const headWriterDraft = await generateHeadWriterDraft({
    researchBrief: pass1Result.brief,
    skill,
    durationSeconds: input.durationSeconds,
    format: input.format ?? "video",
    personalizationProfile,
    options: {
      forceMock: input.options?.forceMock ?? false,
      temperature: input.options?.temperature,
    },
  });
  const pass2DurationMs = Date.now() - p2StartTime;

  // 5. Pass 3: Voice Tuning, Table-Read Critic & Pre-Flight Content-Filter Safety
  if (onProgress) {
    await onProgress({
      step: "voice_prune",
      message: "Running stylometric voice pass, table-read joke scoring, and content-filter safety pass...",
      progressFraction: 0.90,
    });
  }

  const p3StartTime = Date.now();
  const pass3Result = await runPass3VoiceAndPrune({
    draft: headWriterDraft,
    skill,
    personalizationProfile,
    options: {
      forceMock: input.options?.forceMock ?? false,
      skipTableReadPrune: input.options?.skipTableReadPrune ?? false,
    },
  });
  const pass3DurationMs = Date.now() - p3StartTime;

  const totalDurationMs = Date.now() - totalStartTime;

  const finalScript = pass3Result.finalScript;
  const tableReadReport = finalScript.tableReadReport;

  const result: DramaturgyResult = {
    showId: input.showId,
    skill,
    researchBrief: pass1Result.brief,
    headWriterDraft,
    finalScript,
    executionMetrics: {
      totalDurationMs,
      pass1DurationMs,
      pass2DurationMs,
      pass3DurationMs,
      jokesEvaluated: tableReadReport.totalJokes,
      jokesPrunedOrRevised: tableReadReport.prunedCount + tableReadReport.revisedCount,
      tableReadAvgScore: tableReadReport.averageScore,
    },
  };

  if (onProgress) {
    await onProgress({
      step: "complete",
      message: `Script complete (${finalScript.segments.length} segments, Table-read avg: ${tableReadReport.averageScore}/10)`,
      progressFraction: 1.0,
    });
  }

  // Validate output with Zod
  const validated = DramaturgyResultSchema.parse(result) as DramaturgyResult;
  return validated;
}
