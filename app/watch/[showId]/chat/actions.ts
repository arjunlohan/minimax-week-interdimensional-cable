"use server";

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/app/lib/env";
import { generateText } from "@/app/lib/gmi/text";
import { buildPersonalizedPromptContext, getMemorySummary, getUserMemories, getUserTangents, updateMemoryFromInteraction } from "@/app/lib/memory-bank";
import { generateSingleVoiceClip } from "@/app/lib/tts";
import * as schema from "@/db/schema";
import type { ChatMessage, ShowTangent } from "@/db/schema";

const pool = new Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool, { schema });

// ─────────────────────────────────────────────────────────────────────────────
// Get Messages & Memory
// ─────────────────────────────────────────────────────────────────────────────

export async function getChatMessagesAction(showId: string): Promise<ChatMessage[]> {
  try {
    return await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.showId, showId))
      .orderBy(asc(schema.chatMessages.createdAt));
  } catch (error) {
    console.error("Failed to fetch chat messages:", error);
    return [];
  }
}

/**
 * A one-line account of what the memory bank has learned from.
 *
 * The profile card showed what the agent knows but never where it came from,
 * which made a genuinely multi-source learning loop look like a static list.
 */
export async function getMemorySourcesAction(userId: string = "default_user") {
  try {
    const [memories, tangents] = await Promise.all([
      getUserMemories(userId),
      getUserTangents(userId, 50),
    ]);

    const byType = memories.reduce<Record<string, number>>((acc, m) => {
      acc[m.memoryType] = (acc[m.memoryType] ?? 0) + 1;
      return acc;
    }, {});

    return {
      topicsRequested: byType.interest_topic ?? 0,
      conceptsTracked: byType.concept_mastery ?? 0,
      questionPatterns: byType.question_pattern ?? 0,
      humorSignals: byType.humor_preference ?? 0,
      preferences: byType.custom_note ?? 0,
      tangents: tangents.length,
      // Distinct shows that contributed at least one memory.
      showsContributing: new Set(memories.map(m => m.sourceShowId).filter(Boolean)).size,
    };
  } catch (error) {
    console.error("Failed to fetch memory sources:", error);
    return null;
  }
}

export async function getUserMemorySummaryAction(userId: string = "default_user") {
  try {
    return await getMemorySummary(userId);
  } catch (error) {
    console.error("Failed to fetch memory summary:", error);
    return {
      conceptMastery: [],
      interests: [],
      humorPreference: "Balanced comedic insight",
      recentQuestions: [],
      totalMemories: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grounding: what the show already knows
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no live search behind the host. Every answer is grounded in the
// episode's own record: the research brief the research pass persisted, the
// transcript that was actually performed, the listener's memory bank, and the
// host persona from the template. When the record does not cover a question,
// the host says so instead of inventing a source.

interface ResearchBriefLike {
  summary?: string;
  selectedAngle?: { title?: string; logline?: string };
  groundedFacts?: Array<{ fact?: string; sourceTitle?: string; sourceUrl?: string; bizarreMetric?: string }>;
  searchMetadata?: { searchQueriesUsed?: string[] };
}

/**
 * Renders the stored research brief for the prompt. A compact listing of the
 * facts and their sources gives the host something to cite; the raw JSON
 * mostly gives it keys to parrot. Shows from before the structured brief
 * stored prose, which passes through unchanged.
 */
function formatResearchBrief(raw: string | null | undefined): string {
  const text = raw?.trim();
  if (!text) {
    return "(No research brief was stored for this episode.)";
  }

  let brief: ResearchBriefLike;
  try {
    brief = JSON.parse(text) as ResearchBriefLike;
  } catch {
    return text;
  }
  if (!brief || typeof brief !== "object") {
    return text;
  }

  const lines: string[] = [];
  if (brief.selectedAngle?.title) {
    lines.push(`Angle: ${brief.selectedAngle.title}${brief.selectedAngle.logline ? ` (${brief.selectedAngle.logline})` : ""}`);
  }
  if (brief.summary) {
    lines.push(`Summary: ${brief.summary}`);
  }

  const facts = (brief.groundedFacts ?? []).filter(f => f.fact);
  if (facts.length > 0) {
    lines.push("Grounded facts:");
    for (const f of facts) {
      const source = f.sourceTitle || f.sourceUrl ?
        ` [source: ${[f.sourceTitle, f.sourceUrl].filter(Boolean).join(", ")}]` :
        " [no source recorded]";
      lines.push(`- ${f.fact}${f.bizarreMetric ? ` (${f.bizarreMetric})` : ""}${source}`);
    }
  }

  const queries = brief.searchMetadata?.searchQueriesUsed ?? [];
  if (queries.length > 0) {
    lines.push(`Research queries the show ran: ${queries.join("; ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : text;
}

interface TemplateHost {
  name?: string;
  personality?: string;
  position?: string;
  role?: string;
}

interface ShowGrounding {
  hostName: string;
  showName: string;
  persona: string;
  topic: string;
  transcript: string;
  researchBrief: string;
}

/** Loads the show row and the host's persona from its template. */
async function loadShowGrounding(
  showId: string,
  requestedHost: string | undefined,
  overrides: { topic?: string; transcript?: string; researchContext?: string } = {},
): Promise<ShowGrounding> {
  const show = await db.query.generatedShows.findFirst({
    where: eq(schema.generatedShows.id, showId),
  });
  if (!show) {
    throw new Error(`Show ${showId} was not found, so there is nothing to ground the host's answer in.`);
  }

  const template = await db.query.showTemplates.findFirst({
    where: eq(schema.showTemplates.id, show.templateId),
  });
  const hosts = (template?.hosts ?? []) as TemplateHost[];
  // A persona only when it belongs to the named host; a name the template
  // does not know keeps its name and speaks without one, rather than wearing
  // the first host's personality.
  const host = requestedHost ? hosts.find(h => h.name === requestedHost) : hosts[0];

  return {
    hostName: requestedHost || host?.name || "Host",
    showName: template?.name ?? "the show",
    persona: [host?.personality, host?.position ? `Position: ${host.position}` : undefined].filter(Boolean).join(" "),
    topic: overrides.topic?.trim() || show.topic,
    transcript: overrides.transcript?.trim() || show.transcript?.trim() || "(No transcript was stored for this episode.)",
    researchBrief: formatResearchBrief(overrides.researchContext?.trim() || show.researchContext),
  };
}

function buildHostSystemPrompt(grounding: ShowGrounding, memoryContext: string): string {
  return `You are ${grounding.hostName}, host of "${grounding.showName}", talking to a viewer about this episode on "${grounding.topic}".
${grounding.persona ? `Your persona: ${grounding.persona}\n` : ""}Stay completely in character with your signature humor, wit, pacing, and comedic worldview.

${memoryContext}

WHAT THIS SHOW KNOWS
Answer from the episode's research brief and transcript below. They are your only sources: there is no live search behind you. If the brief does not cover something, say what the show did not research rather than inventing a fact or a source. Joke freely around what is here, and label any speculation as speculation.

RESEARCH BRIEF:
${grounding.researchBrief}

TRANSCRIPT:
${grounding.transcript}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Send Message (with Memory Bank & Voice Synthesis)
// ─────────────────────────────────────────────────────────────────────────────

interface ChatContext {
  topic: string;
  transcript: string;
  researchContext: string;
  userId?: string;
  hostName?: string;
  generateVoice?: boolean;
}

interface SendMessageResult {
  message?: ChatMessage;
  audioData?: string;
  error?: string;
}

export async function sendChatMessageAction(
  showId: string,
  userMessage: string,
  context: ChatContext,
): Promise<SendMessageResult> {
  if (!userMessage.trim()) {
    return { error: "Message cannot be empty." };
  }

  const effectiveUserId = context.userId || "default_user";

  try {
    // Save user message
    await db
      .insert(schema.chatMessages)
      .values({
        showId,
        role: "user",
        content: userMessage.trim(),
      });

    // Fetch conversation history for context
    const history = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.showId, showId))
      .orderBy(asc(schema.chatMessages.createdAt));

    // Load Memory Bank personalization for this listener
    const memoryContext = await buildPersonalizedPromptContext(effectiveUserId);

    // The page passes the show's own transcript and brief; the row is the
    // source of truth when it does not.
    const grounding = await loadShowGrounding(showId, context.hostName, {
      topic: context.topic,
      transcript: context.transcript,
      researchContext: context.researchContext,
    });
    const hostName = grounding.hostName;

    const systemPrompt = `${buildHostSystemPrompt(grounding, memoryContext)}

Guidelines:
- Speak directly in the first person ("I think...", "Look, here's the deal...")
- Cite the brief's facts when they answer the question, naming the source when one is recorded
- Keep responses conversational, witty, and punchy (2-4 sentences unless the user explicitly asks for a deep dive)
- Adapt your delivery to the listener's known preferences from the Memory Bank without mentioning it`;

    const messages = history.map(msg => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    const responseText = await generateText({
      system: systemPrompt,
      messages,
      temperature: 0.8,
      maxOutputTokens: 1024,
    });
    const result = { text: responseText };

    // Save assistant response
    const [savedAssistantMsg] = await db
      .insert(schema.chatMessages)
      .values({
        showId,
        role: "assistant",
        content: result.text,
      })
      .returning();

    // Generate a voice clip in the host's voice if requested
    let audioData: string | undefined;
    if (context.generateVoice) {
      try {
        audioData = await generateSingleVoiceClip(result.text, hostName);
      } catch (ttsErr) {
        console.warn("[chat] Optional TTS generation skipped:", ttsErr);
      }
    }

    // Autonomously update user memory bank in background
    void updateMemoryFromInteraction(
      effectiveUserId,
      userMessage,
      result.text,
      grounding.topic,
      showId,
    );

    return { message: savedAssistantMsg, audioData };
  } catch (error) {
    console.error("Chat error:", error);
    const message = error instanceof Error ? error.message : "Failed to generate response.";
    return { error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// On-Demand Tangent Generation (Spin-off Audio Deep Dives)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTangentResult {
  tangent?: ShowTangent;
  audioData?: string;
  error?: string;
}

export async function createShowTangentAction(
  showId: string,
  question: string,
  hostName: string = "John Olive",
  topic: string,
  userId: string = "default_user",
): Promise<CreateTangentResult> {
  try {
    const memoryContext = await buildPersonalizedPromptContext(userId, { showType: "tangent" });
    const grounding = await loadShowGrounding(showId, hostName, { topic });

    const systemPrompt = `${buildHostSystemPrompt(grounding, memoryContext)}

You are writing a spoken mini-tangent, not a chat reply. Return ONLY the spoken words: no sound effects, stage directions, or speaker labels.`;

    const tangentPrompt = `A listener just interrupted your show to ask:
"${question}"

Write a 30-45 second mini-tangent audio monologue (approx 60-80 words).
Requirements:
- Jump straight in with high energy and host humor
- Deliver a concise, hilarious, and enlightening answer built on the research brief and transcript
- If the show never researched this, say so on air and riff on what it did find instead of inventing facts
- End with a punchy sign-off back to the main broadcast`;

    const scriptText = (await generateText({
      system: systemPrompt,
      prompt: tangentPrompt,
      temperature: 0.9,
      maxOutputTokens: 512,
    })).trim();
    const audioData = await generateSingleVoiceClip(scriptText, grounding.hostName);

    const [savedTangent] = await db
      .insert(schema.showTangents)
      .values({
        showId,
        userId,
        question,
        hostName: grounding.hostName,
        scriptText,
        audioData,
        durationSeconds: 35,
      })
      .returning();

    // Learn from this tangent question
    void updateMemoryFromInteraction(
      userId,
      question,
      scriptText,
      grounding.topic,
      showId,
    );

    return { tangent: savedTangent, audioData };
  } catch (error) {
    console.error("Failed to create show tangent:", error);
    const message = error instanceof Error ? error.message : "Tangent creation failed";
    return { error: message };
  }
}
