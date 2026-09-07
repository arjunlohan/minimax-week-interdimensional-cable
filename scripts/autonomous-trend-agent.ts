/* eslint-disable no-console, node/no-process-env */
/**
 * Autonomous Trend Ingestion Agent (The Taskmaster Track Showcase)
 *
 * Demonstrates an event-driven autonomous agent coordinator that:
 * 1. Monitors trending topics / Hacker News feeds
 * 2. Evaluates relevance against the User Memory Bank
 * 3. Autonomously assigns the optimal show persona & template
 * 4. Triggers the durable multi-step show generation workflow
 *
 * Run: tsx scripts/autonomous-trend-agent.ts
 */

import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import { AUDIO_PODCAST_DURATION_OPTIONS, defaultDurationFor, isValidDuration, VIDEO_DURATION_OPTIONS } from "../app/create/constants";
import * as schema from "../db/schema";

dotenv.config({ path: ".env.local" });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

interface TrendingStory {
  title: string;
  url: string;
  score: number;
}

async function fetchHackerNewsTopStories(): Promise<TrendingStory[]> {
  console.log("[taskmaster] Fetching top stories from Hacker News API...");
  const topIdsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!topIdsRes.ok) {
    throw new Error(`Hacker News top stories request failed (${topIdsRes.status}). Check network access and retry; the agent does not invent trends.`);
  }
  const topIds = (await topIdsRes.json() as number[]).slice(0, 5);

  const stories: TrendingStory[] = [];
  for (const id of topIds) {
    const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (itemRes.ok) {
      const item = await itemRes.json() as { title: string; url?: string; score: number };
      if (item.title) {
        stories.push({
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          score: item.score || 0,
        });
      }
    }
  }

  if (stories.length === 0) {
    throw new Error("Hacker News returned no usable stories. Retry later; the agent does not invent trends.");
  }
  return stories;
}

async function runAutonomousIngestionAgent() {
  console.log("\n=======================================================");
  console.log("  TASKMASTER: Autonomous Ingestion & Routing Agent     ");
  console.log("=======================================================\n");

  const stories = await fetchHackerNewsTopStories();
  console.log(`[taskmaster] Discovered ${stories.length} candidate stories.`);

  // Fetch available templates
  const templates = await db.select().from(schema.showTemplates);
  if (templates.length === 0) {
    console.error("[taskmaster] No show templates found. Run 'npm run seed-templates' first.");
    return;
  }

  // Fetch user memories to match interests
  const memories = await db.select().from(schema.userMemories);
  const memoryContext = memories.map(m => `${m.key}: ${m.value}`).join("; ") || "General interest in tech breakthroughs, satire, and AI";

  console.log("[taskmaster] Evaluating stories with the MiniMax-M3 router...");

  // Imported after dotenv so app/lib/env validates the loaded values.
  const { generateJson } = await import("../app/lib/gmi/text");

  // The model chooses among what was actually discovered and seeded. Encoding
  // the choices as enums means a hallucinated id or title fails validation and
  // goes back to the model for repair instead of being silently remapped.
  const storyTitles = stories.map(s => s.title) as [string, ...string[]];
  const templateIds = templates.map(t => t.id) as [string, ...string[]];

  const RoutingDecisionSchema = z.object({
    selectedStoryTitle: z.enum(storyTitles),
    selectedTemplateId: z.enum(templateIds),
    reasoning: z.string().min(1),
    format: z.enum(["video", "audio"]).default("video"),
    durationSeconds: z.number().int().positive(),
    familiarity: z.enum(["beginner", "familiar", "expert"]).default("familiar"),
  });

  const routingPrompt = `You have discovered the following trending stories:
${JSON.stringify(stories, null, 2)}

Available Show Templates:
${JSON.stringify(templates.map(t => ({ id: t.id, name: t.name, type: t.showType })), null, 2)}

User Memory Profile:
${memoryContext}

Select the single BEST story to produce an on-demand episode for this user right now.
Assign the most suitable template (e.g. an investigative desk show for tech deep-dives, a rapid-headlines desk for breaking news).
Pick the format and length: "video" episodes run ${VIDEO_DURATION_OPTIONS.map(o => o.value).join(", ")} seconds (MiniMax-H3 clips); "audio" episodes run ${AUDIO_PODCAST_DURATION_OPTIONS.map(o => o.value).join(", ")} seconds (Speech 2.8 HD).

Return valid JSON in this format:
{
  "selectedStoryTitle": "exactly one of the discovered story titles",
  "selectedTemplateId": "exactly one of the template ids",
  "reasoning": "why this matches user memory and which comedy angle fits best",
  "format": "video" | "audio",
  "durationSeconds": 90,
  "familiarity": "beginner" | "familiar" | "expert"
}`;

  const decision = await generateJson({
    schema: RoutingDecisionSchema,
    label: "taskmaster-routing",
    system: "You are the Autonomous Program Director Agent for Interdimensional Cable.",
    prompt: routingPrompt,
    temperature: 0.4,
    maxOutputTokens: 2048,
  });

  const story = stories.find(s => s.title === decision.selectedStoryTitle)!;
  const matchedTemplate = templates.find(t => t.id === decision.selectedTemplateId)!;
  const durationSeconds = isValidDuration(decision.format, decision.durationSeconds) ?
    decision.durationSeconds :
      defaultDurationFor(decision.format);

  console.log("\n[taskmaster] Autonomous Routing Decision:");
  console.log("  Topic:", story.title);
  console.log("  Source:", story.url);
  console.log("  Template:", matchedTemplate.name, `(${matchedTemplate.id})`);
  console.log("  Format:", decision.format, `${durationSeconds}s`, decision.durationSeconds !== durationSeconds ? `(model asked for ${decision.durationSeconds}s, snapped to a valid length)` : "");
  console.log("  Reasoning:", decision.reasoning);

  // Insert show record
  console.log("\n[taskmaster] Provisioning show record in Postgres...");
  const [show] = await db.insert(schema.generatedShows).values({
    templateId: matchedTemplate.id,
    topic: story.title,
    topicType: story.url ? "news_link" : "freetext",
    format: decision.format,
    durationSeconds,
    familiarity: decision.familiarity,
    status: "pending",
    userId: "default_user",
  }).returning();

  console.log(`✓ Show record created (ID: ${show.id})`);

  // Dispatch over HTTP rather than calling start() directly. The workflow id is
  // injected by the Next.js bundler plugin (next.config.ts `withWorkflow`), which
  // never runs under tsx, so start() throws in a bare script process.
  console.log("[taskmaster] Dispatching durable workflow execution...");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/workflows/generate-show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showId: show.id }),
  });
  const dispatch = await res.json();

  if (!dispatch.runId) {
    // Never leave an orphaned `pending` row behind when dispatch fails.
    await db.delete(schema.generatedShows).where(eq(schema.generatedShows.id, show.id));
    throw new Error(
      `Workflow dispatch failed (${res.status}): ${dispatch.error ?? "no runId returned"}`,
    );
  }

  await db.update(schema.generatedShows)
    .set({ workflowRunId: dispatch.runId })
    .where(eq(schema.generatedShows.id, show.id));

  console.log(`✓ Durable workflow started! Run ID: ${dispatch.runId}`);
  console.log(`✓ Inspect progress at: /create/${show.id}`);
  console.log("\n[taskmaster] Autonomous coordination cycle complete.\n");

  await pool.end();
}

runAutonomousIngestionAgent().catch((err) => {
  console.error("[taskmaster] Fatal error:", err);
  process.exit(1);
});
