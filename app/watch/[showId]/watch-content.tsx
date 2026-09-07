"use client";

import { useState } from "react";
import Markdown from "react-markdown";

import { MemoryProfileCard } from "@/app/components/memory-profile-card";
import { PlayerProvider } from "@/app/media/[slug]/player/provider";
import { VideoPlayer } from "@/app/media/[slug]/player/ui";
import type { GeneratedShow, ShowTemplate } from "@/db/schema";

import { ChatPanel } from "./chat/chat-panel";
import { ProvenancePanel } from "./provenance-panel";
import type { EngineCredits } from "./provenance-panel";
import { ShowTranscript } from "./show-transcript";
import { DubbingPanel } from "./tts-panel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TranscriptSegment {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
  clipIndex: number;
}

/** Segment shape as persisted by the generation workflow. */
interface RawSegment {
  speaker?: string;
  text?: string;
  startTime?: number;
  endTime?: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
  durationSeconds?: number;
  clipIndex?: number;
}

interface ResearchFact {
  id?: string;
  fact: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

interface ResearchBrief {
  summary?: string;
  groundedFacts?: ResearchFact[];
  selectedAngle?: { title?: string; logline?: string };
  searchMetadata?: { searchQueriesUsed?: string[] };
}

interface WatchContentProps {
  show: GeneratedShow;
  template: ShowTemplate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function WatchContent({ show, template }: WatchContentProps) {
  const hosts = (template.hosts ?? []) as Array<{ name: string; personality: string; position?: string }>;
  // The show row records its format explicitly (MiniMax-H3 video episodes and
  // Speech 2.8 HD audio episodes overlap in length, so duration cannot decide).
  const isAudio = show.format === "audio";
  // The pipeline persists startTimeSeconds/endTimeSeconds; this component reads
  // startTime/endTime. Without this mapping the timestamps render as NaN:NaN.
  const segments: TranscriptSegment[] = ((show.transcriptSegments ?? []) as RawSegment[]).map((seg, i) => {
    const start = seg.startTime ?? seg.startTimeSeconds ?? 0;
    const dur = seg.durationSeconds ?? 8;
    return {
      speaker: seg.speaker ?? "Host",
      text: seg.text ?? "",
      startTime: start,
      endTime: seg.endTime ?? seg.endTimeSeconds ?? start + dur,
      clipIndex: seg.clipIndex ?? i,
    };
  });

  return (
    <PlayerProvider>
      <div className="grid gap-8 md:grid-cols-[1.3fr_1fr]">
        {/* Left Column — Video + Transcript */}
        <div className="space-y-6">
          {/* Mux Player — audio podcasts get cover art + audio transport, because
              Mux cannot generate thumbnails for assets with no video track. */}
          <div className="border-3 border-border shadow-[6px_6px_0_var(--border)]">
            {isAudio && template.referenceImageUrl && (
              <div className="relative aspect-video overflow-hidden border-b-3 border-border bg-background-dark">
                {/* eslint-disable-next-line next/no-img-element */}
                <img
                  src={template.referenceImageUrl}
                  alt={template.name}
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <div
                    className="mb-1 text-[11px] font-bold uppercase tracking-[0.25em] text-white/80"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    🎙️ Audio Podcast ·
                    {" "}
                    {template.name}
                  </div>
                  <div className="text-lg font-extrabold leading-tight text-white" style={{ fontFamily: "var(--font-syne)" }}>
                    {show.topic}
                  </div>
                </div>
              </div>
            )}
            <VideoPlayer
              playbackId={show.muxPlaybackId!}
              title={show.topic}
              isAudio={isAudio}
            />
          </div>

          {/* Persistent Agent Memory Bank Display */}
          <MemoryProfileCard userId={show.userId || "default_user"} />

          {/* Synced Transcript */}
          {segments.length > 0 && (
            <ShowTranscript segments={segments} />
          )}
        </div>

        {/* Right Column — Info Panels */}
        <div className="space-y-6">
          {/* Research Context (collapsed by default) */}
          {show.researchContext && (
            <ResearchPanel content={show.researchContext} />
          )}

          {/* Chat with In-Character Host & Memory Bank */}
          <ChatPanel
            showId={show.id}
            topic={show.topic}
            transcript={show.transcript ?? ""}
            researchContext={show.researchContext ?? ""}
            hostName={hosts[0]?.name ?? "Host"}
          />

          {/* Audio Dubbing */}
          {show.transcript && (
            <DubbingPanel
              transcript={show.transcript}
              hosts={hosts}
              segments={segments.map(s => ({ speaker: s.speaker, text: s.text }))}
            />
          )}

          {/* Social Clips — hidden for now */}

          {/* What actually produced this episode */}
          <ProvenancePanel
            researchContext={show.researchContext}
            segmentCount={segments.length}
            durationSeconds={show.durationSeconds ?? 16}
            isAudio={isAudio}
            hasMux={Boolean(show.muxPlaybackId)}
            language={show.language ?? "en"}
            hasTheme={Boolean(show.themeLyrics)}
            hasCredits={Boolean(show.creditsLyrics)}
            engines={(show.engineNotes as { engines?: EngineCredits } | null)?.engines ?? null}
          />

          {/* Show Details */}
          <div className="card-flat p-4">
            <div
              className="mb-3 text-[14px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Show Details
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Template</span>
                <span className="font-bold">{template.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Type</span>
                <span className="font-bold capitalize">{template.showType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Duration</span>
                <span className="font-bold">
                  {show.durationSeconds}
                  s
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Familiarity</span>
                <span className="font-bold capitalize">{show.familiarity}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-foreground-muted">Language</span>
                <span className="font-bold">{show.language?.toUpperCase() ?? "EN"}</span>
              </div>
              {hosts.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-foreground-muted">Hosts</span>
                  <span className="font-bold">{hosts.map(h => h.name).join(", ")}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </PlayerProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Research Panel (collapsed by default, renders markdown)
// ─────────────────────────────────────────────────────────────────────────────

function ResearchPanel({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card-flat overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between bg-background-dark px-4 py-3 text-white transition-colors hover:brightness-110"
        style={{ fontFamily: "var(--font-space-mono)" }}
      >
        <span className="text-[14px] font-bold uppercase tracking-[0.2em]">Research</span>
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="square" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="max-h-[32rem] overflow-y-auto p-4">
          <ResearchBody content={content} />
        </div>
      )}
    </div>
  );
}

/**
 * The research pass persists a structured ResearchBrief as JSON. Rendering that
 * raw through Markdown produced one unbroken wall of text that blew out the
 * layout, so parse it and lay out the parts that are worth reading.
 */
function ResearchBody({ content }: { content: string }) {
  let brief: ResearchBrief | null = null;
  try {
    const parsed = JSON.parse(content) as ResearchBrief;
    if (parsed && typeof parsed === "object" && (parsed.summary || parsed.groundedFacts)) {
      brief = parsed;
    }
  } catch {
    brief = null;
  }

  // Pre-structured-brief shows stored prose; keep rendering those as Markdown.
  if (!brief) {
    return (
      <div className="research-md break-words text-sm leading-relaxed text-foreground-muted [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-extrabold [&_h1]:text-foreground [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-extrabold [&_h2]:text-foreground [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-foreground [&_hr]:my-3 [&_hr]:border-border [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:mb-2 [&_strong]:font-bold [&_strong]:text-foreground [&_ul]:mb-2">
        <Markdown>{content}</Markdown>
      </div>
    );
  }

  const label = "mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-foreground-muted";

  return (
    <div className="space-y-5 text-sm leading-relaxed">
      {brief.selectedAngle?.title && (
        <div>
          <div className={label} style={{ fontFamily: "var(--font-space-mono)" }}>Angle</div>
          <p className="font-bold text-foreground">{brief.selectedAngle.title}</p>
          {brief.selectedAngle.logline && (
            <p className="mt-1 text-foreground-muted">{brief.selectedAngle.logline}</p>
          )}
        </div>
      )}

      {brief.summary && (
        <div>
          <div className={label} style={{ fontFamily: "var(--font-space-mono)" }}>Summary</div>
          <div className="space-y-2 text-foreground-muted">
            {brief.summary.split("\n\n").filter(Boolean).map((para, i) => <p key={i}>{para}</p>)}
          </div>
        </div>
      )}

      {!!brief.groundedFacts?.length && (
        <div>
          <div className={label} style={{ fontFamily: "var(--font-space-mono)" }}>
            Grounded facts (
            {brief.groundedFacts.length}
            )
          </div>
          <ul className="space-y-3">
            {brief.groundedFacts.map((f, i) => (
              <li key={f.id ?? i} className="border-l-2 border-border pl-3">
                <p className="text-foreground">{f.fact}</p>
                {f.sourceTitle && (
                  <p className="mt-1 break-all text-xs text-foreground-muted">
                    {f.sourceUrl ?
                        <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-accent">{f.sourceTitle}</a> :
                      f.sourceTitle}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!brief.searchMetadata?.searchQueriesUsed?.length && (
        <div>
          <div className={label} style={{ fontFamily: "var(--font-space-mono)" }}>Search queries</div>
          <ul className="space-y-1 text-xs text-foreground-muted">
            {brief.searchMetadata.searchQueriesUsed.map((q, i) => (
              <li key={i}>
                ·
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
