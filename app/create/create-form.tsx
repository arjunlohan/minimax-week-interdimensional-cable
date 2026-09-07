"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { StoredKeys } from "@/app/components/api-key-panel";
import { ApiKeyPanel, readStoredKeys } from "@/app/components/api-key-panel";
import type { ShowTemplate } from "@/db/schema";

import { createShowAction } from "./actions";
import {
  DEFAULT_FORMAT,
  defaultDurationFor,
  durationOptionsFor,
  estimatedH3CostUsd,
  FORMAT_OPTIONS,
  isValidDuration,
} from "./constants";
import type { ShowFormat } from "./constants";
import { DurationSelector } from "./duration-selector";
import { FamiliaritySelector } from "./familiarity-selector";
import { TemplateSelector } from "./template-selector";
import { TopicInput } from "./topic-input";

const STEPS = [
  { number: 1, label: "Template" },
  { number: 2, label: "Topic" },
  { number: 3, label: "Configure" },
  { number: 4, label: "Review" },
];

interface CreateFormProps {
  templates: ShowTemplate[];
  /** True when this deployment requires the visitor to bring their own key. */
  requiresApiKey: boolean;
}

export function CreateForm({ templates, requiresApiKey }: CreateFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [step, setStep] = useState(1);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [topicType, setTopicType] = useState("freetext");
  const [format, setFormat] = useState<ShowFormat>(DEFAULT_FORMAT);
  const [durationSeconds, setDurationSeconds] = useState(() => defaultDurationFor(DEFAULT_FORMAT));
  const [familiarity, setFamiliarity] = useState("familiar");
  const [useFrameChaining, setUseFrameChaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<StoredKeys | null>(null);

  const selectedTemplate = templates.find(t => t.id === templateId);
  const selectedFormat = FORMAT_OPTIONS.find(f => f.value === format) ?? FORMAT_OPTIONS[0];
  const selectedDuration = durationOptionsFor(format).find(o => o.value === durationSeconds);
  const isVideo = format === "video";

  function selectFormat(next: ShowFormat) {
    setFormat(next);
    // 60 s and 120 s exist on both scales, so a choice that still fits carries
    // over; anything else lands on the new format's recommended length.
    if (!isValidDuration(next, durationSeconds)) {
      setDurationSeconds(defaultDurationFor(next));
    }
  }

  function canAdvance(): boolean {
    switch (step) {
      case 1:
        return templateId !== null;
      case 2:
        return topic.trim().length > 0;
      case 3:
        return true;
      default:
        return false;
    }
  }

  function handleNext() {
    if (step < 4 && canAdvance()) {
      setStep(step + 1);
      setError(null);
    }
  }

  function handleBack() {
    if (step > 1) {
      setStep(step - 1);
      setError(null);
    }
  }

  function handleSubmit() {
    if (!templateId || !topic.trim())
      return;

    setError(null);
    startTransition(async () => {
      // Read through to storage as well: the panel may not have reported yet on
      // a fresh load, and submitting without the key would fail for no reason.
      const keys = apiKeys ?? readStoredKeys();
      const result = await createShowAction({
        templateId,
        topic: topic.trim(),
        topicType,
        format,
        durationSeconds,
        familiarity,
        useFrameChaining: isVideo && useFrameChaining,
        gmiKey: keys?.gmiKey,
      });

      if (result.error) {
        setError(result.error);
      } else if (result.showId) {
        router.push(`/create/${result.showId}`);
      }
    });
  }

  return (
    <div>
      {/* Step Indicator */}
      <div className="mb-10">
        <div className="flex items-center justify-center gap-0">
          {STEPS.map((s, i) => (
            <div key={s.number} className="flex items-center">
              {/* Step circle */}
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-10 w-10 items-center justify-center border-3 border-border text-sm font-extrabold transition-colors ${
                    step >= s.number ?
                      "bg-foreground text-surface" :
                      "bg-surface text-foreground-muted"
                  }`}
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  {s.number}
                </div>
                <span
                  className={`mt-2 text-[10px] font-bold uppercase tracking-[0.15em] ${
                    step >= s.number ? "text-foreground" : "text-foreground-muted"
                  }`}
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  {s.label}
                </span>
              </div>

              {/* Connecting line */}
              {i < STEPS.length - 1 && (
                <div
                  className={`mb-6 h-[3px] w-12 md:w-20 ${
                    step > s.number ? "bg-foreground" : "bg-border/30"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step Content */}
      <div className="panel-brutal p-6 md:p-8">
        {step === 1 && (
          <div>
            <h3
              className="mb-6 text-2xl font-extrabold tracking-tight"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              Pick a show template
            </h3>
            <TemplateSelector
              templates={templates}
              selectedId={templateId}
              onSelect={setTemplateId}
            />
          </div>
        )}

        {step === 2 && (
          <div>
            <h3
              className="mb-6 text-2xl font-extrabold tracking-tight"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              What should the show cover?
            </h3>
            <TopicInput
              topic={topic}
              topicType={topicType}
              onTopicChange={setTopic}
              onTopicTypeChange={setTopicType}
            />
          </div>
        )}

        {step === 3 && (
          <div>
            <h3
              className="mb-6 text-2xl font-extrabold tracking-tight"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              Configure your show
            </h3>

            {/* Format: decides which pipeline runs and which duration scale applies */}
            <div className="mb-8">
              <label
                className="mb-3 block text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                Format
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                {FORMAT_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={format === option.value}
                    className={`tone-btn p-4 text-left ${format === option.value ? "active" : ""}`}
                    onClick={() => selectFormat(option.value)}
                  >
                    <div className="text-sm font-bold" style={{ fontFamily: "var(--font-syne)" }}>
                      {option.label}
                    </div>
                    <div className="mt-1 text-xs font-normal normal-case tracking-normal opacity-75">
                      {option.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-8 md:grid-cols-2">
              <div>
                <label
                  className="mb-3 block text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  Duration
                </label>
                <DurationSelector
                  value={durationSeconds}
                  onChange={setDurationSeconds}
                  format={format}
                />
                {isVideo && (
                  <p className="mt-3 text-[11px] leading-relaxed text-foreground-muted">
                    Each clip is one MiniMax-H3 request at $0.13. Research, script, voices and music run on the same GMI Cloud key at no extra charge.
                  </p>
                )}
              </div>
              <div>
                <label
                  className="mb-3 block text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  Familiarity
                </label>
                <FamiliaritySelector value={familiarity} onChange={setFamiliarity} />
              </div>
            </div>

            {/* Frame chaining: video only, there are no clips to chain in an audio episode */}
            {isVideo && (
              <div className="mt-8">
                <label
                  className="mb-3 block text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  Visual Consistency
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useFrameChaining}
                  className={`tone-btn w-full text-left ${useFrameChaining ? "active" : ""}`}
                  style={{ fontFamily: "var(--font-space-mono)" }}
                  onClick={() => setUseFrameChaining(!useFrameChaining)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold">
                        Frame chaining ·
                        {" "}
                        {useFrameChaining ? "on" : "off"}
                      </div>
                      <div className="mt-1 text-[10px] font-normal normal-case tracking-normal opacity-70">
                        Off (default): every clip is anchored to the host portrait and that line's Speech 2.8 HD audio.
                      </div>
                      <div className="mt-1 text-[10px] font-normal normal-case tracking-normal opacity-70">
                        On: each clip starts from the previous clip's last frame for continuity, but MiniMax-H3 then cannot use the host portrait or the spoken line as references.
                      </div>
                    </div>
                    <div
                      className={`ml-4 flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-border transition-colors ${
                        useFrameChaining ? "bg-foreground" : "bg-surface"
                      }`}
                    >
                      <div
                        className={`h-4 w-4 rounded-full border border-border transition-transform ${
                          useFrameChaining ? "translate-x-5 bg-surface" : "translate-x-0.5 bg-foreground-muted"
                        }`}
                      />
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <h3
              className="mb-6 text-2xl font-extrabold tracking-tight"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              Review & create
            </h3>

            <div className="space-y-4">
              {/* Template */}
              <div className="border-3 border-border p-4">
                <div
                  className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  Template
                </div>
                <div className="font-bold" style={{ fontFamily: "var(--font-syne)" }}>
                  {selectedTemplate?.name ?? "(none)"}
                </div>
                {selectedTemplate && (
                  <span
                    className="badge mt-2"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    {selectedTemplate.showType.toUpperCase()}
                  </span>
                )}
              </div>

              {/* Topic */}
              <div className="border-3 border-border p-4">
                <div
                  className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  Topic
                </div>
                <div className="font-medium">{topic || "(none)"}</div>
                <span
                  className="badge mt-2"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  {topicType.replace("_", " ").toUpperCase()}
                </span>
              </div>

              {/* Settings */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="border-3 border-border p-4">
                  <div
                    className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Format
                  </div>
                  <div className="font-bold" style={{ fontFamily: "var(--font-syne)" }}>
                    {selectedFormat.label}
                  </div>
                </div>
                <div className="border-3 border-border p-4">
                  <div
                    className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Duration
                  </div>
                  <div className="font-bold" style={{ fontFamily: "var(--font-syne)" }}>
                    {selectedDuration?.label ?? `${durationSeconds} s`}
                  </div>
                  {selectedDuration && (
                    <div
                      className="mt-1 text-[10px] text-foreground-muted"
                      style={{ fontFamily: "var(--font-space-mono)" }}
                    >
                      {selectedDuration.description}
                      {selectedDuration.clips !== undefined ? ` · ${estimatedH3CostUsd(selectedDuration.clips)}` : ""}
                    </div>
                  )}
                </div>
                <div className="border-3 border-border p-4">
                  <div
                    className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Familiarity
                  </div>
                  <div className="font-bold capitalize" style={{ fontFamily: "var(--font-syne)" }}>
                    {familiarity}
                  </div>
                </div>
              </div>

              {/* Frame chaining indicator */}
              {isVideo && useFrameChaining && (
                <div className="border-3 border-border p-4">
                  <div
                    className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Visual Consistency
                  </div>
                  <div className="font-bold" style={{ fontFamily: "var(--font-syne)" }}>
                    Frame chaining on
                  </div>
                  <div
                    className="mt-1 text-[10px] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Clips chain from the previous last frame; host portrait and line audio are not used as references.
                  </div>
                </div>
              )}
            </div>

            {/* Error message */}
            {error && (
              <div
                className="mt-6 border-3 border-red-600 bg-red-50 p-4 text-sm font-bold text-red-600"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        When a key is mandatory it is shown from the first step: discovering the
        requirement only after filling in four steps would be a poor trade for
        the visitor. When it is optional it sits with the final action, next to
        the point where cost is actually incurred.
      */}
      {(requiresApiKey || step === 4) && (
        <div className="mt-8">
          <ApiKeyPanel required={requiresApiKey} onChange={setApiKeys} />
        </div>
      )}

      {/* Navigation Buttons */}
      <div className="mt-8 flex items-center justify-between">
        <div>
          {step > 1 && (
            <button
              type="button"
              className="btn-outlined"
              style={{ fontFamily: "var(--font-space-mono)" }}
              onClick={handleBack}
            >
              Back
            </button>
          )}
        </div>

        <div>
          {step < 4 ?
              (
                <button
                  type="button"
                  className="btn-action"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                  disabled={!canAdvance()}
                  onClick={handleNext}
                >
                  Next
                </button>
              ) :
              (
                <button
                  type="button"
                  className="btn-action"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                  disabled={isPending}
                  onClick={handleSubmit}
                >
                  {isPending ? "Creating..." : "Create Show"}
                </button>
              )}
        </div>
      </div>
    </div>
  );
}
