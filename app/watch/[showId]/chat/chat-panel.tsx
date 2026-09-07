"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import type { ChatMessage } from "@/db/schema";

import { createShowTangentAction, getChatMessagesAction, sendChatMessageAction } from "./actions";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  showId: string;
  topic: string;
  transcript: string;
  researchContext: string;
  hostName?: string;
}

interface MessageWithAudio extends ChatMessage {
  audioData?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ChatPanel({ showId, topic, transcript, researchContext, hostName = "Host" }: ChatPanelProps) {
  const [messages, setMessages] = useState<MessageWithAudio[]>([]);
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isGeneratingTangent, setIsGeneratingTangent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeAudio, setActiveAudio] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(
    () => buildSuggestions(researchContext, transcript, topic),
    [researchContext, transcript, topic],
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Load existing messages on mount
  useEffect(() => {
    getChatMessagesAction(showId).then(setMessages);
  }, [showId]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback((withVoice = false, overrideMessage?: string) => {
    const msg = (overrideMessage ?? input).trim();
    if (!msg || isPending)
      return;

    setInput("");
    setError(null);

    // Optimistic update — add user message immediately
    const optimisticUserMsg: MessageWithAudio = {
      id: `temp-${Date.now()}`,
      showId,
      role: "user",
      content: msg,
      createdAt: new Date(),
    };
    setMessages(prev => [...prev, optimisticUserMsg]);

    startTransition(async () => {
      const result = await sendChatMessageAction(showId, msg, {
        topic,
        transcript,
        researchContext,
        hostName,
        generateVoice: withVoice,
      });

      if (result.error) {
        setError(result.error);
        // Remove optimistic message on error
        setMessages(prev => prev.filter(m => m.id !== optimisticUserMsg.id));
        setInput(msg); // Restore input
      } else {
        // Refresh full message list to get real IDs
        const updated = await getChatMessagesAction(showId);
        const updatedWithAudio = updated.map((m) => {
          if (result.message && m.id === result.message.id && result.audioData) {
            return { ...m, audioData: result.audioData };
          }
          return m;
        });
        setMessages(updatedWithAudio);

        if (result.audioData) {
          setActiveAudio(result.audioData);
        }
      }

      inputRef.current?.focus();
    });
  }, [input, isPending, showId, topic, transcript, researchContext, hostName]);

  const handleCreateTangent = async () => {
    const question = input.trim();
    if (!question || isGeneratingTangent)
      return;

    setIsGeneratingTangent(true);
    setInput("");
    setError(null);

    try {
      const result = await createShowTangentAction(showId, question, hostName, topic);
      if (result.error) {
        setError(result.error);
        setInput(question);
      } else if (result.audioData) {
        setActiveAudio(result.audioData);
        const updated = await getChatMessagesAction(showId);
        setMessages(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate tangent");
    } finally {
      setIsGeneratingTangent(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(false);
    }
  };

  return (
    <div className="card-flat flex flex-col overflow-hidden" style={{ maxHeight: isOpen ? "480px" : undefined }}>
      {/* Header — collapsible */}
      <button
        type="button"
        onClick={() => setIsOpen(v => !v)}
        aria-expanded={isOpen}
        className="panel-brutal-header bg-background-dark text-white flex w-full items-center justify-between transition-colors hover:brightness-110"
        style={{ fontFamily: "var(--font-space-mono)" }}
      >
        <span>Live Host Q&A & Tangents</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-accent font-bold uppercase tracking-wider">MiniMax-M3</span>
          <svg
            className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="square" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <>

          {/* Messages */}
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && !isPending && !isGeneratingTangent && (
              <div className="py-6 text-center text-sm text-foreground-muted space-y-1">
                <p>
                  Ask
                  {hostName}
                  {" "}
                  anything about this episode.
                </p>
                <p className="text-xs text-foreground-muted/70">The host adapts in-character and updates your persistent memory bank.</p>
              </div>
            )}

            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] border-2 border-border px-3 py-2 text-sm ${
                    msg.role === "user" ?
                      "bg-foreground text-surface" :
                      "bg-surface-elevated text-foreground"
                  }`}
                >
                  {msg.role === "assistant" && (
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span
                        className="text-[10px] font-bold uppercase tracking-wider text-accent"
                        style={{ fontFamily: "var(--font-space-mono)" }}
                      >
                        {hostName}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-emerald-500 font-bold">
                        ✓ Memory Adapted
                      </span>
                    </div>
                  )}
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>

                  {msg.audioData && (
                    <div className="mt-2 pt-2 border-t border-border/40">
                      <audio controls src={msg.audioData} className="w-full h-7 text-xs" autoPlay />
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Audio player for active voice reply / tangent */}
            {activeAudio && (
              <div className="border-2 border-accent bg-accent/10 p-2.5 my-2">
                <span className="block text-[10px] font-bold uppercase text-accent mb-1" style={{ fontFamily: "var(--font-space-mono)" }}>
                  🎙️ Playing Host Audio Tangent (Speech 2.8 HD)
                </span>
                <audio controls src={activeAudio} className="w-full h-8" autoPlay />
              </div>
            )}

            {/* Loading indicator */}
            {(isPending || isGeneratingTangent) && (
              <div className="flex justify-start">
                <div className="border-2 border-border bg-surface-elevated px-3 py-2">
                  <span
                    className="text-xs text-foreground-muted animate-pulse"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    {isGeneratingTangent ? "🎙️ Synthesizing 30s Audio Tangent with Speech 2.8 HD..." : "Thinking with MiniMax-M3..."}
                  </span>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="border-2 border-red-600 bg-red-50 px-3 py-2 text-xs text-red-600">
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Grounded suggestions — shown until the viewer starts their own thread */}
          {messages.length === 0 && !input.trim() && suggestions.length > 0 && (
            <div className="border-t-3 border-border bg-background px-4 py-3">
              <div
                className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                Suggested from this episode&apos;s research
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map(sug => (
                  <button
                    key={sug.label}
                    type="button"
                    title={sug.question}
                    onClick={() => handleSend(false, sug.question)}
                    disabled={isPending || isGeneratingTangent}
                    className="border-2 border-border bg-surface px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    {sug.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input controls */}
          <div className="border-t-3 border-border bg-surface">
            <div className="flex">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Ask ${hostName} or request a topic tangent...`}
                disabled={isPending || isGeneratingTangent}
                className="flex-1 bg-surface px-4 py-3 text-sm placeholder:text-foreground-muted focus:outline-none disabled:opacity-50"
                style={{ fontFamily: "var(--font-space-mono)" }}
              />
              <button
                type="button"
                onClick={() => handleSend(false)}
                disabled={isPending || isGeneratingTangent || !input.trim()}
                className="border-l-3 border-border bg-foreground text-surface px-4 py-3 text-sm font-bold transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                Ask
              </button>
              <button
                type="button"
                onClick={() => handleSend(true)}
                disabled={isPending || isGeneratingTangent || !input.trim()}
                title="Generate a spoken reply with Speech 2.8 HD"
                className="border-l-3 border-border bg-accent text-foreground px-3 py-3 text-xs font-bold transition-colors hover:brightness-110 disabled:opacity-50"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                🎙️ Voice
              </button>
            </div>

            {/* Tangent button */}
            <div className="px-3 py-1.5 bg-surface-elevated border-t border-border flex items-center justify-between text-[11px]">
              <span className="text-foreground-muted">Want an on-demand audio deep dive?</span>
              <button
                type="button"
                onClick={handleCreateTangent}
                disabled={isPending || isGeneratingTangent || !input.trim()}
                className="font-bold text-accent hover:underline disabled:opacity-40"
              >
                + Create 30s Audio Tangent ↗
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Suggested prompts come from the show's own research brief. Each chip shows a
 * short topic label (the pill has to stay small), while the message actually sent
 * is the full question.
 */
interface Suggestion {
  label: string;
  question: string;
}

/**
 * Turns a full research sentence into a short pill label. Cutting at a fixed word
 * count produced fragments like "largest national park in", so cut at the first
 * verb instead and drop any trailing filler word.
 */
const LABEL_VERB = /\s(?:is|are|was|were|has|have|had|serves|spans|covers|sits|makes|made|remains|became|reached|connects|gives|saw|deploys|uses)\s/i;
const TRAILING_FILLER = /\s+(?:in|is|of|a|an|the|and|with|to|for|by|at|on|its|their|that|which)$/i;

function toShortLabel(text: string, maxWords = 5): string {
  let cleaned = text
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/[“”"]/g, "")
    .split(/[,;:(]/)[0]
    .trim();

  // Prefer the subject clause, i.e. everything before the first verb.
  const verbCut = cleaned.split(LABEL_VERB)[0];
  if (verbCut && verbCut.split(/\s+/).length >= 2) {
    cleaned = verbCut.trim();
  }

  let label = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
  while (TRAILING_FILLER.test(label)) {
    label = label.replace(TRAILING_FILLER, "");
  }
  return label.replace(/[.\s]+$/, "");
}

function buildSuggestions(researchContext: string, transcript: string, topic: string): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (label: string, question: string) => {
    const key = label.toLowerCase();
    if (!label || label.length < 3 || seen.has(key) || out.length >= 4) {
      return;
    }
    seen.add(key);
    out.push({ label, question });
  };

  try {
    const brief = JSON.parse(researchContext) as {
      groundedFacts?: Array<{ fact?: string; bizarreMetric?: string }>;
      premiseAngles?: Array<{ title?: string }>;
      selectedAngle?: { title?: string };
      incongruitySeeds?: Array<{ contradiction?: string }>;
    };

    const spoken = transcript.toLowerCase();

    // Facts the research surfaced that the script did not actually cover.
    for (const f of brief.groundedFacts ?? []) {
      if (!f.fact) {
        continue;
      }
      const label = toShortLabel(f.fact);
      if (!label || spoken.includes(label.toLowerCase())) {
        continue; // already covered on air
      }
      push(label, `Tell me more about ${label} — you didn't cover that in the episode.`);
    }

    // Angles the episode considered and passed on.
    const taken = brief.selectedAngle?.title;
    for (const a of brief.premiseAngles ?? []) {
      if (!a.title || a.title === taken) {
        continue;
      }
      push(toShortLabel(a.title, 3), `Why didn't you go with the "${a.title}" angle instead?`);
    }

    const seed = (brief.incongruitySeeds ?? [])[0]?.contradiction;
    if (seed) {
      push(toShortLabel(seed, 3), `Can you unpack the contradiction here — ${seed.split(/[,.]/)[0]?.trim()}?`);
    }
  } catch {
    // Older shows stored prose research; fall through to generic prompts.
  }

  push("Most absurd bit", `What's the single most absurd detail about ${topic}?`);
  push("What got cut", "What did you have to cut for time?");
  push("Who benefits", "Who actually benefits from this arrangement?");

  return out.slice(0, 4);
}
