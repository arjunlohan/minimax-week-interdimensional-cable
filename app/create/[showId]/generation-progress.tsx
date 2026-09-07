"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { GeneratedShow, ShowTemplate } from "@/db/schema";

import { pollShowStatusAction } from "./actions";
import type { QueueState } from "./actions";
import { generationSteps, POLL_INTERVAL } from "./constants";
import type { GenerationStepId } from "./constants";
import { TVLoading } from "./tv-loading";

interface GenerationProgressProps {
  show: GeneratedShow;
  template: ShowTemplate;
}

/**
 * Which steps a `generated_shows.status` value means are running.
 *
 * The status column is coarser than the step list: "generating" covers the
 * whole MiniMax-H3 phase, so with frame chaining on both H3 steps show as
 * active rather than pretending the boundary frame is still in flight minutes
 * later. Steps that do not run for this show are filtered out by the caller.
 */
const STATUS_TO_STEPS: Record<string, GenerationStepId[]> = {
  pending: [],
  researching: ["research"],
  scripting: ["script"],
  voicing: ["voices"],
  generating: ["frame-chain", "generate-clips"],
  scoring: ["music"],
  stitching: ["stitch"],
  uploading: ["upload"],
  ready: [],
  failed: [],
};

function getActiveSteps(status: string, stepOrder: GenerationStepId[]): GenerationStepId[] {
  return (STATUS_TO_STEPS[status] ?? []).filter(id => stepOrder.includes(id));
}

function getCompletedSteps(status: string, stepOrder: GenerationStepId[]): GenerationStepId[] {
  if (status === "ready") {
    return [...stepOrder];
  }
  const active = getActiveSteps(status, stepOrder);
  if (active.length === 0) {
    return [];
  }
  const firstActive = Math.min(...active.map(id => stepOrder.indexOf(id)));
  return stepOrder.slice(0, firstActive);
}

export function GenerationProgress({ show, template }: GenerationProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(show.status);
  const [error, setError] = useState<string | undefined>(show.error ?? undefined);
  const [queue, setQueue] = useState<QueueState | undefined>(undefined);

  const poll = useCallback(async () => {
    const result = await pollShowStatusAction(show.id);
    setStatus(result.status);
    setQueue(result.queue);
    if (result.error)
      setError(result.error);

    if (result.status === "ready" && result.muxPlaybackId) {
      // Redirect to watch page after a brief delay
      setTimeout(() => {
        router.push(`/watch/${show.id}`);
      }, 1500);
    }
  }, [show.id, router]);

  useEffect(() => {
    if (status === "ready" || status === "failed")
      return;

    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [status, poll]);

  // The show's format column decides the path; the workflow reads the same column.
  const isAudio = show.format === "audio";
  const useFrameChaining = !isAudio && (show.useFrameChaining ?? false);
  const visibleSteps = generationSteps(isAudio, { useFrameChaining });
  const stepOrder = visibleSteps.map(s => s.id);
  const activeSteps = getActiveSteps(status, stepOrder);
  const completedSteps = getCompletedSteps(status, stepOrder);

  return (
    <div className="space-y-8">
      {/* TV Loading Animation */}
      <TVLoading
        templateName={template.name}
        topic={show.topic}
        status={status}
        isAudio={isAudio}
      />

      {/* Step Progress */}
      <div className="mx-auto max-w-xl">
        {/* Waiting for the render worker. The site only queues the show; a
            worker on a machine without a function timeout renders it. */}
        {status === "pending" && queue && (
          <div className={`mb-4 border-3 p-4 ${queue.workerOnline ? "border-border bg-surface-elevated" : "border-amber-600 bg-amber-50"}`}>
            <div
              className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {queue.workerOnline ? "Queued for the render worker" : "Render worker offline"}
            </div>
            <p className="text-sm text-foreground-muted">
              {queue.workerOnline ?
                `The worker checked in ${queue.workerSeenSecondsAgo ?? 0}s ago and picks this episode up next. Rendering happens off the web host because a single voice line can wait minutes in the queue.` :
                "This episode is saved and starts the moment a render worker comes back online. Nothing is lost; you can leave this page and return."}
            </p>
          </div>
        )}
        <div className="card-flat p-5">
          <div
            className="mb-4 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
            style={{ fontFamily: "var(--font-space-mono)" }}
          >
            Pipeline Progress
          </div>
          <p className="mb-4 text-xs leading-relaxed text-foreground-muted">
            Each stage is a checkpointed step. The engine running it is named beside it.
          </p>

          <div className="space-y-3">
            {visibleSteps.map((step) => {
              const isCompleted = completedSteps.includes(step.id);
              const isCurrent = activeSteps.includes(step.id);

              return (
                <div key={step.id} className="flex items-start gap-3">
                  {/* Icon */}
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-border">
                    {isCompleted ?
                        (
                          <svg className="h-3.5 w-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="square" d="M5 13l4 4L19 7" />
                          </svg>
                        ) :
                      isCurrent ?
                          (
                            <div className="h-2 w-2 animate-pulse bg-accent" />
                          ) :
                          (
                            <div className="h-2 w-2 bg-foreground-light/30" />
                          )}
                  </div>

                  {/* Label + the engine actually doing the work */}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={`text-xs font-bold uppercase tracking-[0.1em] ${
                        isCompleted ? "text-foreground" : isCurrent ? "text-accent" : "text-foreground-muted"
                      }`}
                      style={{ fontFamily: "var(--font-space-mono)" }}
                    >
                      {step.label}
                    </span>
                    <span
                      className="text-[10px] leading-tight text-foreground-muted"
                      style={{ fontFamily: "var(--font-space-mono)" }}
                    >
                      {step.engine.model}
                    </span>
                  </div>

                  {/* Service chip. Dimmed until the step is reached, so the
                      active engine is obvious at a glance. */}
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 border-2 border-border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-opacity ${
                      isCompleted || isCurrent ? "opacity-100" : "opacity-40"
                    }`}
                    style={{ fontFamily: "var(--font-space-mono)", background: "var(--surface-elevated)" }}
                  >
                    {step.engine.icon ?
                        (
                          <img src={step.engine.icon} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
                        ) :
                      null}
                    {step.engine.service}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mt-4 border-3 border-red-600 bg-red-50 p-4">
            <div
              className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-red-600"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Error
            </div>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Ready state */}
        {status === "ready" && (
          <div className="mt-4 border-3 border-green-600 bg-green-50 p-4 text-center">
            <div
              className="text-sm font-bold text-green-700"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Redirecting to your show...
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
