/* eslint-disable no-console */
import { getWritable } from "workflow";

import type { GenerationStepId } from "@/app/create/[showId]/constants";

import type { GenerateShowResult, MusicStepResult, ProgressEvent, ShowPlan, VoicedLine, VoicesStepResult } from "./generate-show-shared";
import { closeStream } from "./workflow-progress";

/**
 * The show pipeline on MiniMax models served through GMI Cloud.
 *
 *   research  MiniMax-M3 reads the topic (URL contents fetched here) and briefs the room
 *   script    MiniMax-M3 runs the three writers'-room passes
 *   voices    Speech 2.8 HD voices every line (per clip for video, per turn for audio)
 *   frame-chain / generate-clips
 *             MiniMax-H3 renders one clip per beat (video only)
 *   music     Music 3.0 sings the theme and the credits, lyrics by MiniMax-M3
 *   stitch    ffmpeg assembles title card + clips + end card (or theme + episode + credits)
 *   upload    Mux
 *
 * Every step is durable; every failure is reported with the model that caused
 * it. Nothing here substitutes canned content when a model fails.
 */

// Types, constants and pure helpers are re-exported so callers and tests keep
// one import path. This module is Node-free, so the workflow bundle accepts it.
export * from "./generate-show-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Main Workflow
// ─────────────────────────────────────────────────────────────────────────────

export async function generateShowWorkflow(
  showId: string,
): Promise<GenerateShowResult> {
  "use workflow";

  const completedSteps: GenerationStepId[] = [];
  const progress = getWritable<ProgressEvent>({ namespace: "progress" });

  try {
    console.log("[workflow] Starting research step for showId:", showId);
    await researchStep(progress, showId);
    completedSteps.push("research");

    console.log("[workflow] Starting script step");
    await scriptStep(progress, showId);
    completedSteps.push("script");

    const plan = await checkShowFormatStep(showId);

    // Storage preflight. Generation costs real money and minutes of wall clock,
    // so refuse before spending it if Mux has no room for the finished asset.
    await checkStorageCapacityStep(showId);

    console.log(`[workflow] ${plan.format} episode (${plan.durationSeconds}s): voicing with Speech 2.8 HD`);
    const voiced = await voicesStep(progress, showId);
    completedSteps.push("voices");

    if (plan.format === "video") {
      console.log("[workflow] Rendering clips with MiniMax-H3", plan.useFrameChaining ? "(frame chaining)" : "(reference mode)");
      await generateClipsStep(progress, showId, voiced.lines ?? []);
      if (plan.useFrameChaining) {
        completedSteps.push("frame-chain");
      }
      completedSteps.push("generate-clips");
    }

    console.log("[workflow] Scoring with Music 3.0");
    const music = await musicStep(progress, showId);
    completedSteps.push("music");

    console.log("[workflow] Assembling the episode");
    await stitchStep(progress, showId, music);
    completedSteps.push("stitch");

    console.log("[workflow] Uploading to Mux");
    await uploadStep(progress, showId);
    completedSteps.push("upload");
    console.log("[workflow] All done");

    return {
      success: true,
      currentStep: "upload",
      completedSteps,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Show generation failed";
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[workflow] FAILED after steps:", completedSteps, "error:", message);
    if (stack) {
      console.error("[workflow] Stack trace:", stack);
    }

    // Mark show as failed in a step (can't use Node.js modules in workflow fn)
    await markFailedStep(showId, message);

    try {
      await closeStream(progress);
    } catch {
      // stream may already be closed
    }

    return {
      success: false,
      currentStep: completedSteps.at(-1) ?? "research",
      completedSteps,
      error: message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step boundaries
// ─────────────────────────────────────────────────────────────────────────────
//
// Each step reaches its implementation through a dynamic import so that the
// workflow bundle never sees a Node.js module; the DevKit strips these bodies
// in workflow mode and keeps them in step mode.

async function markFailedStep(showId: string, errorMessage: string): Promise<void> {
  "use step";
  const { markFailedStepImpl } = await import("./generate-show-steps");
  return markFailedStepImpl(showId, errorMessage);
}

async function checkStorageCapacityStep(showId: string): Promise<void> {
  "use step";
  const { checkStorageCapacityStepImpl } = await import("./generate-show-steps");
  return checkStorageCapacityStepImpl(showId);
}

async function checkShowFormatStep(showId: string): Promise<ShowPlan> {
  "use step";
  const { checkShowFormatStepImpl } = await import("./generate-show-steps");
  return checkShowFormatStepImpl(showId);
}

async function researchStep(progress: WritableStream<ProgressEvent>, showId: string): Promise<void> {
  "use step";
  const { researchStepImpl, runWithShowKeys } = await import("./generate-show-steps");
  return runWithShowKeys(showId, () => researchStepImpl(progress, showId));
}

async function scriptStep(progress: WritableStream<ProgressEvent>, showId: string): Promise<void> {
  "use step";
  const { runWithShowKeys, scriptStepImpl } = await import("./generate-show-steps");
  return runWithShowKeys(showId, () => scriptStepImpl(progress, showId));
}

async function voicesStep(progress: WritableStream<ProgressEvent>, showId: string): Promise<VoicesStepResult> {
  "use step";
  const { runWithShowKeys, voicesStepImpl } = await import("./generate-show-steps");
  return runWithShowKeys(showId, () => voicesStepImpl(progress, showId));
}

async function generateClipsStep(progress: WritableStream<ProgressEvent>, showId: string, lines: VoicedLine[]): Promise<void> {
  "use step";
  const { generateClipsStepImpl, runWithShowKeys } = await import("./generate-show-steps");
  return runWithShowKeys(showId, () => generateClipsStepImpl(progress, showId, lines));
}

async function musicStep(progress: WritableStream<ProgressEvent>, showId: string): Promise<MusicStepResult> {
  "use step";
  const { musicStepImpl, runWithShowKeys } = await import("./generate-show-steps");
  return runWithShowKeys(showId, () => musicStepImpl(progress, showId));
}

async function stitchStep(progress: WritableStream<ProgressEvent>, showId: string, music: MusicStepResult): Promise<void> {
  "use step";
  const { stitchStepImpl } = await import("./generate-show-steps");
  return stitchStepImpl(progress, showId, music);
}

async function uploadStep(progress: WritableStream<ProgressEvent>, showId: string): Promise<void> {
  "use step";
  const { uploadStepImpl } = await import("./generate-show-steps");
  return uploadStepImpl(progress, showId);
}
