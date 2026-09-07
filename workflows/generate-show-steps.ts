/* eslint-disable no-console */
import type { AudioStrategy, ClipAudioSource, ClipMode, ClipNote, EngineNotes, Host, MusicStepResult, ProgressEvent, ShowPlan, TranscriptSegment, VoicedLine, VoicesStepResult } from "./generate-show-shared";
import { apportionSegmentsByWords, assignVoices, audioStrategyFrom, clipSecondsForLine, ENGINES, ensureLyricTags, firstLyricLine, MAX_CONTENT_REVISIONS, MAX_TRANSIENT_RETRIES, needsTtsOverlay, offsetSegments, referenceAudioUsable, resolveShowFormat, StorageFullError, timeSegmentsFromDurations, transcriptFromSegments } from "./generate-show-shared";
import { closeStream, writeToStream } from "./workflow-progress";

/**
 * The Node-dependent half of the show pipeline: one implementation per
 * durable step, plus the helpers they share. Every function here runs inside
 * a "use step" boundary (see generate-show.ts), which is the only place the
 * Workflow DevKit allows Node.js modules, ffmpeg, the database and GMI Cloud.
 *
 * Kept separate from the workflow file on purpose: the workflow bundle traces
 * every module the workflow file references, and these implementations are
 * exported for the tests, so they cannot live next to the workflow function.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Lazy DB helper (Node.js modules only available inside step functions)
// ─────────────────────────────────────────────────────────────────────────────

async function getDb() {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const { env } = await import("@/app/lib/env");
  const schema = await import("@/db/schema");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return { db: drizzle(pool, { schema }), schema, pool };
}

type Db = Awaited<ReturnType<typeof getDb>>["db"];
type Schema = Awaited<ReturnType<typeof getDb>>["schema"];

async function loadShow(db: Db, schema: Schema, showId: string) {
  const { eq } = await import("drizzle-orm");
  const show = await db.query.generatedShows.findFirst({
    where: eq(schema.generatedShows.id, showId),
  });
  if (!show) {
    throw new Error("Show not found");
  }
  return show;
}

async function loadTemplate(db: Db, schema: Schema, templateId: string) {
  const { eq } = await import("drizzle-orm");
  const template = await db.query.showTemplates.findFirst({
    where: eq(schema.showTemplates.id, templateId),
  });
  if (!template) {
    throw new Error("Template not found");
  }
  return template;
}

async function setStatus(db: Db, schema: Schema, showId: string, status: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await db.update(schema.generatedShows)
    .set({ status })
    .where(eq(schema.generatedShows.id, showId));
}

/** Read-modify-write of the free-form run notes. */
async function patchEngineNotes(db: Db, schema: Schema, showId: string, patch: Partial<EngineNotes>): Promise<EngineNotes> {
  const { eq } = await import("drizzle-orm");
  const row = await db.query.generatedShows.findFirst({
    where: eq(schema.generatedShows.id, showId),
    columns: { engineNotes: true },
  });
  const current = (row?.engineNotes && typeof row.engineNotes === "object" ? row.engineNotes : {}) as EngineNotes;
  const next: EngineNotes = { ...current, ...patch };
  await db.update(schema.generatedShows)
    .set({ engineNotes: next })
    .where(eq(schema.generatedShows.id, showId));
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handler step
// ─────────────────────────────────────────────────────────────────────────────

export async function markFailedStepImpl(showId: string, errorMessage: string): Promise<void> {
  console.log("[workflow:markFailed] Marking show as failed:", showId, "error:", errorMessage);
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();

  // Step errors can lose their message crossing the workflow boundary, which is
  // why failures used to surface as a bare "Show generation failed". Steps that
  // already recorded a specific, user-actionable reason keep it.
  const existing = await db.query.generatedShows.findFirst({
    where: eq(schema.generatedShows.id, showId),
  });
  const stored = existing?.error ?? "";
  const isSpecific = stored.length > 0 && stored !== "Show generation failed";

  await db.update(schema.generatedShows)
    // Terminal state: the visitor's API key has no further use, so it stops
    // being stored at all.
    .set({ status: "failed", error: isSpecific ? stored : errorMessage, encryptedApiKeys: null })
    .where(eq(schema.generatedShows.id, showId));
}

/**
 * Verifies Mux has room for the finished asset before any generation happens.
 *
 * Without this the pipeline would render every clip, assemble them, and only
 * then hit "Free plan is limited to 10 assets" at upload, throwing away the
 * entire MiniMax-H3 spend.
 */
export async function checkStorageCapacityStepImpl(showId: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { getMuxCapacity } = await import("@/app/lib/mux");

  const capacity = await getMuxCapacity();
  console.log(`[workflow:preflight] Mux storage ${capacity.used}/${capacity.limit} used, ${capacity.available} free`);

  if (capacity.hasRoom) {
    return;
  }

  const message = `Mux storage is full (${capacity.used}/${capacity.limit} assets). ` +
    "Delete a show from the library to free a slot, then try again. " +
    "Generation was stopped before starting so no render time was spent.";

  await db.update(schema.generatedShows)
    .set({ status: "failed", error: message })
    .where(eq(schema.generatedShows.id, showId));

  throw new StorageFullError(message);
}

/** Thrown when Mux has no capacity; surfaced to the user verbatim. */
export async function checkShowFormatStepImpl(showId: string): Promise<ShowPlan> {
  const { db, schema } = await getDb();
  const show = await loadShow(db, schema, showId);
  return {
    format: resolveShowFormat(show),
    useFrameChaining: Boolean(show.useFrameChaining),
    durationSeconds: show.durationSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API key scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs `fn` with the show's own GMI Cloud key in scope.
 *
 * A durable run spans multiple invocations, so AsyncLocalStorage set when the
 * run was created is long gone by the time a later step executes. Each
 * model-calling step therefore reloads and decrypts the key itself. Falls
 * through to the server's own key when the show carries none, which is what
 * local development does.
 */
export async function runWithShowKeys<T>(showId: string, fn: () => Promise<T>): Promise<T> {
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { decryptApiKeys, withUserApiKeys } = await import("@/app/lib/api-keys");

  const row = await db.query.generatedShows.findFirst({
    where: eq(schema.generatedShows.id, showId),
    columns: { encryptedApiKeys: true },
  });

  const keys = decryptApiKeys(row?.encryptedApiKeys);

  try {
    return await (keys ? withUserApiKeys(keys, fn) : fn());
  } catch (err) {
    // A step error loses its message crossing the workflow boundary, which is
    // why failures surfaced as a bare "Show generation failed" with no way to
    // tell a content refusal from a budget cap. Record the real reason here,
    // where every model-calling step already passes through.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.update(schema.generatedShows)
        .set({ error: message.slice(0, 1000) })
        .where(eq(schema.generatedShows.id, showId));
    } catch {
      // Never let error reporting mask the original failure.
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Research
// ─────────────────────────────────────────────────────────────────────────────

export async function researchStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
): Promise<void> {
  await writeToStream(progress, { type: "current", step: "research" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { runPass1Research } = await import("@/app/lib/dramaturgy/pass1-research");
  const { resolveSkillForShow } = await import("@/app/lib/skills/registry");

  await setStatus(db, schema, showId, "researching");

  const show = await loadShow(db, schema, showId);
  console.log("[workflow:research] Show found:", show.id, "topic:", show.topic, "type:", show.topicType, "format:", resolveShowFormat(show));

  const template = show.templateId ?
      await db.query.showTemplates.findFirst({
        where: eq(schema.showTemplates.id, show.templateId),
      }) :
    null;

  const skill = resolveSkillForShow(template?.name);

  // Fetch URL content if needed
  let topicContent = show.topic;
  let extractedChars = 0;
  if (show.topicType === "news_link" || show.topicType === "hacker_news") {
    let extracted = "";
    let failure = "";

    try {
      const response = await fetch(show.topic, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "InterdimensionalCable/1.0 (+show-research)" },
      });

      if (!response.ok) {
        failure = `the site returned HTTP ${response.status}`;
      } else {
        const html = await response.text();
        extracted = html
          // Drop script/style bodies before stripping tags. Tag-stripping alone
          // leaves their contents behind, so minified JS reaches the research
          // prompt as if it were article prose.
          .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]*>/g, " ")
          .replace(/&(nbsp|amp|quot|#39|lt|gt);/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (extracted.length < 400) {
          failure = `only ${extracted.length} characters of readable text came back, which usually means a paywall or a JavaScript-rendered page`;
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure) {
      // Fail loudly. Handing the model a bare URL it cannot read makes it invent
      // an entire episode and present the fabrication as grounded research,
      // which is far worse than refusing the run.
      throw new Error(
        `Could not read ${show.topic}: ${failure}. Paste the article text directly, or try a different link.`,
      );
    }

    extractedChars = extracted.length;
    console.log(`[workflow:research] Extracted ${extracted.length} chars from ${show.topic}`);
    topicContent = `URL: ${show.topic}\n\nContent: ${extracted.slice(0, 5000)}`;
  }

  console.log("[workflow:research] Running Pass 1 grounded research with MiniMax-M3...");
  const pass1Output = await runPass1Research({
    topic: topicContent,
    topicType: show.topicType as "custom" | "news_link" | "hacker_news" | "trend" | "freetext",
    familiarity: (show.familiarity as "beginner" | "familiar" | "expert") || "familiar",
    showSkill: skill,
  });

  console.log("[workflow:research] Pass 1 completed, grounded facts:", pass1Output.brief.groundedFacts.length, "angles:", pass1Output.brief.premiseAngles.length);

  await db.update(schema.generatedShows)
    .set({ researchContext: JSON.stringify(pass1Output.brief) })
    .where(eq(schema.generatedShows.id, showId));

  // The script step re-runs the writers' room from the same material, so the
  // article text it read is kept: a bare URL would send MiniMax-M3 writing blind.
  await patchEngineNotes(db, schema, showId, {
    engines: { ...ENGINES, video: resolveShowFormat(show) === "video" ? ENGINES.video : undefined },
    format: resolveShowFormat(show),
    research: {
      source: show.topicType,
      ...(extractedChars > 0 ? { topicContent, extractedChars } : {}),
    },
  });

  await writeToStream(progress, { type: "completed", step: "research" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Script
// ─────────────────────────────────────────────────────────────────────────────

export async function scriptStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
): Promise<void> {
  await writeToStream(progress, { type: "current", step: "script" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { runDramaturgyPipeline } = await import("@/app/lib/dramaturgy/orchestrator");

  await setStatus(db, schema, showId, "scripting");

  const show = await loadShow(db, schema, showId);
  const template = show.templateId ?
      await db.query.showTemplates.findFirst({
        where: eq(schema.showTemplates.id, show.templateId),
      }) :
    null;

  const format = resolveShowFormat(show);
  const notes = (show.engineNotes ?? {}) as EngineNotes;
  const topic = notes.research?.topicContent ?? show.topic;

  // The research step already produced and stored the brief; hand it over so
  // pass 1 is not run a second time on the same topic.
  let researchBriefInput: Record<string, unknown> | undefined;
  if (show.researchContext) {
    try {
      researchBriefInput = JSON.parse(show.researchContext) as Record<string, unknown>;
    } catch {
      researchBriefInput = undefined;
    }
  }

  console.log(`[workflow:script] Running the three writers'-room passes on MiniMax-M3 for show ${showId} (${format})${researchBriefInput ? ", reusing the stored research brief" : ""}`);
  const dramaturgyResult = await runDramaturgyPipeline({
    showId: show.id,
    topic,
    researchBrief: researchBriefInput as never,
    topicType: show.topicType as "custom" | "news_link" | "hacker_news" | "trend" | "freetext",
    templateId: show.templateId,
    skillIdOrSlug: template?.name,
    durationSeconds: show.durationSeconds,
    familiarity: show.familiarity as "beginner" | "familiar" | "expert",
    userId: show.userId ?? undefined,
    language: show.language ?? "en",
    format,
  });

  const { finalScript, researchBrief, executionMetrics } = dramaturgyResult;
  console.log("[workflow:script] Dramaturgy completed in", executionMetrics.totalDurationMs, "ms. Segments:", finalScript.segments.length, "Table-read score:", executionMetrics.tableReadAvgScore);
  if (finalScript.segments.length === 0) {
    throw new Error("MiniMax-M3 returned a script with no segments; nothing to voice or render. Try the topic again or pick a different template.");
  }

  await db.update(schema.generatedShows)
    .set({
      researchContext: JSON.stringify(researchBrief),
      transcript: finalScript.transcriptPlainText,
      transcriptSegments: finalScript.segments,
    })
    .where(eq(schema.generatedShows.id, showId));

  await patchEngineNotes(db, schema, showId, {
    script: {
      title: finalScript.title,
      showType: finalScript.showType,
      archetype: finalScript.archetype,
      totalDurationSeconds: finalScript.totalDurationSeconds,
      tableReadAvgScore: executionMetrics.tableReadAvgScore,
      dramaturgyMs: executionMetrics.totalDurationMs,
    },
  });

  await writeToStream(progress, { type: "completed", step: "script" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Voices (Speech 2.8 HD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesizes one line with the speaker's assigned voice, keeps the mp3 on
 * disk, and (under the "reference" strategy) uploads it so MiniMax-H3 can
 * perform it. Shared by the voices step and the content-revision path, which
 * must re-voice a rewritten line so the attached audio matches the prompt.
 */
async function voiceLine(
  segment: TranscriptSegment,
  segmentIndex: number,
  assignments: Record<string, string>,
  hosts: Host[],
  strategy: AudioStrategy,
): Promise<VoicedLine> {
  const { synthesizeSpeech } = await import("@/app/lib/gmi/speech");
  const { uploadToGmi } = await import("@/app/lib/gmi/upload");
  const { tmpPath } = await import("@/app/lib/gmi/queue");
  const { emotionForSegment } = await import("@/app/lib/tts");
  const fs = await import("node:fs");

  const voiceId = assignments[segment.speaker] ?? (hosts[0] ? assignments[hosts[0].name] : undefined) ?? Object.values(assignments)[0];
  if (!voiceId) {
    throw new Error(`No MiniMax voice is assigned to ${segment.speaker}; the template has no hosts to voice`);
  }
  const emotion = emotionForSegment(segment.actingDirection, segment.acousticTags);
  const speech = await synthesizeSpeech({ text: segment.text, voiceId, emotion });

  const audioPath = tmpPath(`line-${segmentIndex}`, "mp3");
  fs.writeFileSync(audioPath, speech.audio);
  const durationSeconds = Number((speech.durationMs / 1000).toFixed(3));

  let referenceAudioUrl: string | null = null;
  if (strategy === "reference") {
    if (referenceAudioUsable(speech.durationMs)) {
      referenceAudioUrl = await uploadToGmi(speech.audio, "mp3");
    } else {
      console.warn(`[workflow:voices] Line ${segmentIndex} is ${durationSeconds}s, outside MiniMax-H3's 2 to 15 s reference window; the clip will carry the line as an overlay instead`);
    }
  }

  return {
    segmentIndex,
    speaker: segment.speaker,
    voiceId,
    emotion: String(emotion),
    text: segment.text,
    audioPath,
    durationSeconds,
    referenceAudioUrl,
    requestId: speech.requestId,
  };
}

export async function voicesStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
): Promise<VoicesStepResult> {
  await writeToStream(progress, { type: "current", step: "voices" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { voiceForHost } = await import("@/app/lib/tts");
  const { env } = await import("@/app/lib/env");

  await setStatus(db, schema, showId, "voicing");

  const show = await loadShow(db, schema, showId);
  const template = await loadTemplate(db, schema, show.templateId);
  const segments = (show.transcriptSegments ?? []) as TranscriptSegment[];
  if (segments.length === 0) {
    throw new Error("The script has no segments to voice; the head writer returned an empty episode.");
  }
  const hosts = (template.hosts ?? []) as Host[];
  const format = resolveShowFormat(show);

  const assignments = assignVoices(show.voiceAssignments, hosts, voiceForHost);
  await db.update(schema.generatedShows)
    .set({ voiceAssignments: assignments })
    .where(eq(schema.generatedShows.id, showId));
  console.log(`[workflow:voices] Cast: ${Object.entries(assignments).map(([name, id]) => `${name} -> ${id}`).join(", ")}`);

  if (format === "audio") {
    await synthesizeAudioEpisode(db, schema, showId, segments, hosts, assignments, show.language ?? "en");
    await writeToStream(progress, { type: "completed", step: "voices" });
    return { format };
  }

  const strategy = audioStrategyFrom(env.H3_AUDIO_STRATEGY);
  console.log(`[workflow:voices] Synthesizing ${segments.length} lines with Speech 2.8 HD (strategy: ${strategy})`);
  const lines: VoicedLine[] = [];
  for (const [i, segment] of segments.entries()) {
    lines.push(await voiceLine(segment, i, assignments, hosts, strategy));
  }

  await patchEngineNotes(db, schema, showId, {
    audioStrategy: strategy,
    voices: {
      assignments,
      lines: lines.map(l => ({
        segmentIndex: l.segmentIndex,
        speaker: l.speaker,
        voiceId: l.voiceId,
        emotion: l.emotion,
        durationSeconds: l.durationSeconds,
        referenceAudio: Boolean(l.referenceAudioUrl),
      })),
    },
  });

  await writeToStream(progress, { type: "completed", step: "voices" });
  return { format, lines };
}

/**
 * Audio episodes: the whole script a turn at a time (Speech 2.8 is one voice
 * per request), timed from the measured durations rather than the plan.
 */
async function synthesizeAudioEpisode(
  db: Db,
  schema: Schema,
  showId: string,
  segments: TranscriptSegment[],
  hosts: Host[],
  assignments: Record<string, string>,
  language: string,
): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { generateTtsPerTurn } = await import("@/app/lib/tts");
  const { wavDurationSeconds } = await import("@/app/lib/stitch");
  const { tmpPath } = await import("@/app/lib/gmi/queue");
  const fs = await import("node:fs");

  console.log(`[workflow:voices] Synthesizing ${segments.length} turns with Speech 2.8 HD`);
  const castHosts = hosts.map(host => ({ ...host, ttsVoice: assignments[host.name] ?? host.ttsVoice }));
  const turns = segments.map(s => ({
    speaker: s.speaker,
    text: s.text,
    actingDirection: s.actingDirection,
    acousticTags: s.acousticTags,
  }));
  const { wav, durations } = await generateTtsPerTurn(turns, castHosts, language);

  const audioPath = tmpPath(`episode-${showId}`, "wav");
  fs.writeFileSync(audioPath, wav);
  console.log(`[workflow:voices] Episode audio written to ${audioPath} (${wav.length} bytes)`);

  // The script plans uniform slots; speech never lands on them. Retime from
  // what was measured so the transcript highlight tracks the audio.
  let timedSegments = segments;
  if (durations.length === segments.length) {
    timedSegments = timeSegmentsFromDurations(segments, durations);
    console.log(`[workflow:voices] Transcript timed from measured per-turn audio (${durations.reduce((a, b) => a + b, 0).toFixed(1)}s total)`);
  } else {
    const actualDuration = wavDurationSeconds(wav);
    if (actualDuration && actualDuration > 0) {
      timedSegments = apportionSegmentsByWords(segments, actualDuration);
      console.log(`[workflow:voices] Retimed transcript against real audio (${actualDuration.toFixed(1)}s) by word count`);
    } else {
      console.warn("[workflow:voices] Could not measure the episode audio; keeping planned segment timings.");
    }
  }

  await db.update(schema.generatedShows)
    .set({ localRenderPath: audioPath, transcriptSegments: timedSegments })
    .where(eq(schema.generatedShows.id, showId));

  await patchEngineNotes(db, schema, showId, {
    voices: {
      assignments,
      lines: timedSegments.map((s, i) => ({
        segmentIndex: i,
        speaker: s.speaker,
        voiceId: assignments[s.speaker] ?? "",
        emotion: "auto",
        durationSeconds: s.durationSeconds ?? 0,
        referenceAudio: false,
      })),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Generate video clips (MiniMax-H3)
// ─────────────────────────────────────────────────────────────────────────────

function describeClipFailure(clipIndex: number, err: unknown, refusedOnContent: boolean, revisions: number): string {
  if (refusedOnContent) {
    const reasons = ((err as { reasons?: string[] })?.reasons ?? []).join("; ") || (err instanceof Error ? err.message : String(err));
    return `MiniMax-H3 refused clip ${clipIndex} on content grounds after ${revisions} rewrite${revisions === 1 ? "" : "s"} (${reasons}). ` +
      "Soften the topic or the template notes and try again.";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Clip ${clipIndex} failed: ${message}. ` +
    "The episode was not assembled because a missing beat would leave a hole in the show; fix the cause and retry.";
}

/**
 * One MiniMax-H3 request per beat, sequentially.
 *
 * Reference mode (default): every request carries the template portrait so
 * the host looks the same in every clip, and under the "reference" audio
 * strategy the line's Speech 2.8 mp3 so H3 performs it in that voice.
 *
 * Frame chaining: clip 0 is rendered as above, then each next clip starts on
 * the previous clip's tail frame. H3 forbids mixing frame inputs with
 * reference images or audio in one request, so chained clips get neither:
 * continuity comes from the frame alone, and the line is laid over the clip
 * afterwards (`needsTtsOverlay`) so the cast stays consistent. The trade-off
 * is lip-sync (H3 cannot perform audio it was not given) for a seamless cut.
 */
export async function generateClipsStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
  lines: VoicedLine[],
): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { env } = await import("@/app/lib/env");
  const video = await import("@/app/lib/gmi/video");
  const { BudgetExceededError } = await import("@/app/lib/gmi/spend");
  const { uploadToGmi } = await import("@/app/lib/gmi/upload");
  const { cleanupTempFiles, extractFrame } = await import("@/app/lib/stitch");
  const { fitAudioToDuration, replaceAudioTrack } = await import("@/app/lib/media");
  const fs = await import("node:fs");

  const show = await loadShow(db, schema, showId);
  const template = await loadTemplate(db, schema, show.templateId);
  const segments = (show.transcriptSegments ?? []) as TranscriptSegment[];
  const hosts = (template.hosts ?? []) as Host[];
  const assignments = assignVoices(show.voiceAssignments, hosts, () => "");
  const strategy = audioStrategyFrom(env.H3_AUDIO_STRATEGY);
  const resolution = video.defaultResolution();
  const chaining = Boolean(show.useFrameChaining);

  const linesByIndex = new Map(lines.map(line => [line.segmentIndex, line]));
  const missing = segments.map((_, i) => i).filter(i => !linesByIndex.has(i));
  if (segments.length === 0 || missing.length > 0) {
    throw new Error(
      `The voices step produced ${lines.length} lines for ${segments.length} segments (missing: ${missing.join(", ") || "none"}); ` +
      "refusing to render a show with missing beats.",
    );
  }

  const portraitUrls = await video.referencePortraitUrls(template.referenceImageUrl);
  const promptContext = (mode: ClipMode, line: VoicedLine) => ({
    hosts,
    showType: template.showType,
    notes: template.notes,
    hasReferencePortrait: mode === "reference" && portraitUrls.length > 0,
    hasReferenceAudio: mode === "reference" && Boolean(line.referenceAudioUrl),
  });
  const modeFor = (clipIndex: number, line: VoicedLine): ClipMode => {
    if (chaining && clipIndex > 0) {
      return "frame";
    }
    return portraitUrls.length > 0 || line.referenceAudioUrl ? "reference" : "prompt";
  };

  await writeToStream(progress, { type: "current", step: chaining ? "frame-chain" : "generate-clips" });
  await setStatus(db, schema, showId, "generating");

  // Rows are rebuilt on every attempt so a retried step never doubles the clips.
  await db.delete(schema.videoClips).where(eq(schema.videoClips.showId, showId));
  await db.insert(schema.videoClips).values(segments.map((segment, i) => {
    const line = linesByIndex.get(i)!;
    const mode = modeFor(i, line);
    return {
      showId,
      clipIndex: i,
      durationSeconds: clipSecondsForLine(line.durationSeconds),
      prompt: video.buildClipPrompt(segment, promptContext(mode, line)),
      status: "pending" as const,
    };
  }));
  const clips = await db.query.videoClips.findMany({
    where: eq(schema.videoClips.showId, showId),
    orderBy: (vc, { asc }) => [asc(vc.clipIndex)],
  });

  console.log(`[workflow:generate-clips] Rendering ${clips.length} clips with MiniMax-H3 at ${resolution}, audio strategy "${strategy}", ${portraitUrls.length} reference portrait(s)${chaining ? ", frame chaining" : ""}`);

  const tempFiles: string[] = [];
  const clipNotes: ClipNote[] = [];
  let previousTailFrameUrl: string | null = null;

  try {
    for (const clip of clips) {
      const clipIndex = clip.clipIndex;
      let segment = segments[clipIndex];
      let line = linesByIndex.get(clipIndex)!;
      const mode = modeFor(clipIndex, line);
      const isLast = clipIndex === clips.length - 1;

      await db.update(schema.videoClips)
        .set({ status: "generating" })
        .where(eq(schema.videoClips.id, clip.id));

      let revisions = 0;
      let transientRetries = 0;

      for (;;) {
        const prompt = video.buildClipPrompt(segment, promptContext(mode, line));
        const requestedSeconds = clipSecondsForLine(line.durationSeconds);
        const referenceAudioAttached = mode === "reference" && Boolean(line.referenceAudioUrl);
        console.log(`[workflow:generate-clips] Clip ${clipIndex} (${clipIndex + 1}/${clips.length}): ${requestedSeconds}s, ${mode} mode${referenceAudioAttached ? " with line audio" : ""}`);

        try {
          const result = await video.generateH3Clip({
            prompt,
            durationSeconds: requestedSeconds,
            resolution,
            ratio: "16:9",
            showId,
            ...(mode === "reference" ?
                {
                  referenceImageUrls: portraitUrls,
                  referenceAudioUrls: line.referenceAudioUrl ? [line.referenceAudioUrl] : undefined,
                } :
                {}),
            ...(mode === "frame" && previousTailFrameUrl ? { firstFrameUrl: previousTailFrameUrl } : {}),
          });

          let clipPath = result.localPath;
          let audioSource: ClipAudioSource = "h3";
          if (needsTtsOverlay({ strategy, hasAudio: result.hasAudio, referenceAudioAttached })) {
            const fitted = await fitAudioToDuration(line.audioPath, result.durationSeconds);
            clipPath = await replaceAudioTrack(result.localPath, fitted);
            tempFiles.push(result.localPath, fitted);
            audioSource = "tts-overlay";
            console.log(`[workflow:generate-clips] Clip ${clipIndex}: ${result.hasAudio ? "replaced H3 audio with" : "silent clip, added"} the Speech 2.8 line`);
          }

          if (chaining && !isLast) {
            const framePath = await extractFrame(clipPath, Math.max(0, result.durationSeconds - 0.25));
            tempFiles.push(framePath);
            previousTailFrameUrl = await uploadToGmi(fs.readFileSync(framePath), "png");
          }

          await db.update(schema.videoClips)
            .set({
              status: "ready",
              prompt,
              durationSeconds: requestedSeconds,
              videoUrl: clipPath,
              gmiRequestId: result.requestId,
              thumbnailUrl: result.thumbnailUrl ?? null,
              measuredDurationSeconds: result.durationSeconds,
              audioSource,
              error: null,
            })
            .where(eq(schema.videoClips.id, clip.id));

          clipNotes.push({
            clipIndex,
            mode,
            requestId: result.requestId,
            requestedSeconds,
            measuredDurationSeconds: result.durationSeconds,
            generationMs: result.generationMs,
            audioSource,
            hadAudio: result.hasAudio,
            revisions,
          });
          console.log(`[workflow:generate-clips] Clip ${clipIndex} ready in ${Math.round(result.generationMs / 1000)}s: ${clipPath} (${result.durationSeconds.toFixed(1)}s, audio: ${audioSource})`);

          if (chaining && clipIndex === 0) {
            await writeToStream(progress, { type: "completed", step: "frame-chain" });
            await writeToStream(progress, { type: "current", step: "generate-clips" });
          }
          break;
        } catch (err) {
          const name = (err as { name?: string })?.name;
          if (err instanceof BudgetExceededError || name === "BudgetExceededError") {
            const message = err instanceof Error ? err.message : String(err);
            await db.update(schema.videoClips)
              .set({ status: "failed", error: message })
              .where(eq(schema.videoClips.id, clip.id));
            throw err;
          }

          const refusedOnContent = err instanceof video.GmiContentFilterError || name === "GmiContentFilterError";
          if (refusedOnContent && revisions < MAX_CONTENT_REVISIONS) {
            revisions++;
            const reasons = (err as { reasons?: string[] }).reasons ?? [err instanceof Error ? err.message : String(err)];
            console.warn(`[workflow:generate-clips] Clip ${clipIndex} refused on content grounds; MiniMax-M3 is rewriting the line (revision ${revisions}/${MAX_CONTENT_REVISIONS})`, reasons);

            const revisedText = await reviseSegmentText(segment.text, reasons);
            console.log(`[workflow:generate-clips] Revised line: ${revisedText}`);
            segment = {
              ...segment,
              text: revisedText,
              visualPrompt: segment.visualPrompt ? video.sanitizeVisualPrompt(segment.visualPrompt) : undefined,
            };
            segments[clipIndex] = segment;
            // The attached audio must say what the prompt says.
            line = await voiceLine(segment, clipIndex, assignments, hosts, strategy);
            linesByIndex.set(clipIndex, line);

            await db.update(schema.generatedShows)
              .set({ transcriptSegments: segments })
              .where(eq(schema.generatedShows.id, showId));
            continue;
          }

          const transient = !refusedOnContent &&
            (err instanceof video.GmiRequestFailedError || name === "GmiRequestFailedError") &&
            transientRetries < MAX_TRANSIENT_RETRIES;
          if (transient) {
            transientRetries++;
            console.warn(`[workflow:generate-clips] Clip ${clipIndex} failed on the GMI Cloud side (${err instanceof Error ? err.message : String(err)}); retrying once`);
            continue;
          }

          const message = describeClipFailure(clipIndex, err, refusedOnContent, revisions);
          console.error(`[workflow:generate-clips] ${message}`);
          await db.update(schema.videoClips)
            .set({ status: "failed", error: message })
            .where(eq(schema.videoClips.id, clip.id));
          throw new Error(message);
        }
      }
    }

    // Persist any revised lines to the display transcript.
    await db.update(schema.generatedShows)
      .set({ transcript: transcriptFromSegments(segments), transcriptSegments: segments })
      .where(eq(schema.generatedShows.id, showId));

    await patchEngineNotes(db, schema, showId, {
      audioStrategy: strategy,
      resolution,
      frameChaining: chaining,
      referencePortrait: portraitUrls.length > 0,
      clips: clipNotes,
    });

    await writeToStream(progress, { type: "completed", step: "generate-clips" });
  } finally {
    // Intermediate files only: the clips themselves live until the stitch step.
    try {
      cleanupTempFiles(tempFiles);
    } catch (cleanErr) {
      console.warn("[workflow:generate-clips] Error during temp file cleanup:", cleanErr);
    }
  }
}

/**
 * Asks MiniMax-M3 to rewrite a line MiniMax-H3 refused on content grounds,
 * keeping the joke. If M3 cannot answer, the deterministic name sanitizer is
 * the fallback; when even that changes nothing, retrying would only spend
 * another request on the same refusal, so the failure is raised instead.
 */
export async function reviseSegmentText(
  originalText: string,
  filterReasons: string[],
): Promise<string> {
  const { generateText } = await import("@/app/lib/gmi/text");
  const { sanitizeVisualPrompt } = await import("@/app/lib/gmi/video");

  const prompt = `You are revising a line of dialogue for a talk show script. The line was rejected by a video generation model because it contained words or references that triggered a content filter.

ORIGINAL LINE:
"${originalText}"

FILTER REASON:
${filterReasons.join("\n")}

Rewrite this line to avoid triggering the filter. Rules:
- Keep the same comedic intent, tone, and approximate length
- Remove or rephrase any celebrity names, real people's names, real institution names, or specific references that could be flagged
- Replace specific names with generic equivalents (e.g., "Harvard" becomes "an Ivy League school", "Colin" becomes "the anchor")
- Do NOT add any explanation. Output ONLY the revised line, nothing else`;

  try {
    const result = await generateText({
      system: "You are a comedy writer. Output only the revised line.",
      prompt,
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
    const cleaned = result.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    if (!cleaned) {
      throw new Error("MiniMax-M3 returned an empty revision");
    }
    return sanitizeVisualPrompt(cleaned);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[workflow:reviseSegmentText] MiniMax-M3 revision failed, falling back to deterministic name sanitization:", reason);
    const sanitized = sanitizeVisualPrompt(originalText);
    if (sanitized === originalText) {
      throw new Error(`MiniMax-H3 refused a line and MiniMax-M3 could not rewrite it (${reason}). Retry the show once MiniMax-M3 is reachable.`);
    }
    return sanitized;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Music (Music 3.0, lyrics by MiniMax-M3)
// ─────────────────────────────────────────────────────────────────────────────

export async function musicStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
): Promise<MusicStepResult> {
  await writeToStream(progress, { type: "current", step: "music" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { generateJson } = await import("@/app/lib/gmi/text");
  const { generateMusic } = await import("@/app/lib/gmi/music");
  const { resolveSkillForShow } = await import("@/app/lib/skills/registry");
  const { z } = await import("zod");

  await setStatus(db, schema, showId, "scoring");

  const show = await loadShow(db, schema, showId);
  const template = await loadTemplate(db, schema, show.templateId);
  const hosts = (template.hosts ?? []) as Host[];
  const segments = (show.transcriptSegments ?? []) as TranscriptSegment[];
  const notes = (show.engineNotes ?? {}) as EngineNotes;
  const skill = resolveSkillForShow(template.name);
  const isDeskShow = skill.archetype === "writers_room_desk";
  const houseStyle = isDeskShow ?
    "late-night big band: brassy horns, walking bass, swing drums, a TV-theme sting" :
    "lo-fi or acoustic podcast bumper: warm guitar or piano, soft beat, unhurried";

  const MusicPlanSchema = z.object({
    theme: z.object({
      lyrics: z.string().trim().min(8).max(3500),
      style: z.string().trim().min(8).max(2000),
    }),
    credits: z.object({
      lyrics: z.string().trim().min(8).max(3500),
      style: z.string().trim().min(8).max(2000),
    }),
  });

  const transcript = segments.map(s => `${s.speaker}: ${s.text}`).join("\n").slice(0, 6000);
  console.log("[workflow:music] Asking MiniMax-M3 for the theme and credits lyrics");
  const plan = await generateJson({
    schema: MusicPlanSchema,
    label: "music-plan",
    system: "You are the music director of a comedy show. You write short, singable lyrics in the show's own voice and precise style prompts for a music generation model.",
    prompt: `Write two songs for tonight's episode.

SHOW: ${template.name} (${template.showType}${isDeskShow ? ", desk show" : ", podcast"})
HOSTS: ${hosts.map(h => h.name).join(", ") || "one host"}
${template.notes ? `SHOW NOTES: ${template.notes}\n` : ""}EPISODE TITLE: ${notes.script?.title ?? show.topic}
TOPIC: ${show.topic}
HOUSE STYLE: ${houseStyle}

TRANSCRIPT:
${transcript}

1. "theme": the opening hook. 2 to 4 lines that name the show "${template.name}". Use the tags [Intro] and [Hook].
2. "credits": the end-credits recap. 4 to 8 lines that sing the episode's three best jokes back to the audience. Use the tags [Verse] and [Outro].

For each song also write "style": genre, tempo, instrumentation, vocal style and mood in one or two sentences, following the house style. Keep every lyric family-broadcast clean and free of real people's names.

Reply as JSON: {"theme": {"lyrics": "...", "style": "..."}, "credits": {"lyrics": "...", "style": "..."}}`,
    temperature: 0.9,
    maxOutputTokens: 4096,
  });

  const themeLyrics = ensureLyricTags(plan.theme.lyrics, "[Intro]", "[Hook]");
  const creditsLyrics = ensureLyricTags(plan.credits.lyrics, "[Verse]", "[Outro]");
  const musicPrompt = `Theme: ${plan.theme.style.trim()}\n\nCredits: ${plan.credits.style.trim()}`;
  await db.update(schema.generatedShows)
    .set({ themeLyrics, creditsLyrics, musicPrompt })
    .where(eq(schema.generatedShows.id, showId));

  const render = async (label: "theme" | "credits", lyrics: string, style: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        console.log(`[workflow:music] Rendering the ${label} with Music 3.0${attempt ? " (retry)" : ""}`);
        return await generateMusic({ lyrics, prompt: style });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt < 1) {
          console.warn(`[workflow:music] Music 3.0 failed on the ${label} (${reason}); retrying once`);
          continue;
        }
        throw new Error(`Music 3.0 could not render the ${label} song (${reason}). The run was stopped rather than shipping a silent ${label}; retry the show.`);
      }
    }
  };

  const theme = await render("theme", themeLyrics, plan.theme.style);
  const credits = await render("credits", creditsLyrics, plan.credits.style);

  await patchEngineNotes(db, schema, showId, {
    music: {
      theme: { requestId: theme.requestId, durationMs: theme.durationMs, prompt: plan.theme.style.trim() },
      credits: { requestId: credits.requestId, durationMs: credits.durationMs, prompt: plan.credits.style.trim() },
    },
  });

  await writeToStream(progress, { type: "completed", step: "music" });
  return {
    themePath: theme.localPath,
    creditsPath: credits.localPath,
    themeDurationMs: theme.durationMs,
    creditsDurationMs: credits.durationMs,
    themeLyrics,
    creditsLyrics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Stitch (ffmpeg assembly)
// ─────────────────────────────────────────────────────────────────────────────

export async function stitchStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
  music: MusicStepResult,
): Promise<void> {
  await writeToStream(progress, { type: "current", step: "stitch" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { cleanupTempFiles } = await import("@/app/lib/stitch");

  await setStatus(db, schema, showId, "stitching");

  const show = await loadShow(db, schema, showId);
  const template = await loadTemplate(db, schema, show.templateId);
  const segments = (show.transcriptSegments ?? []) as TranscriptSegment[];
  const notes = (show.engineNotes ?? {}) as EngineNotes;

  if (resolveShowFormat(show) === "audio") {
    const { assembleAudioEpisode } = await import("@/app/lib/assemble");
    const episodePath = show.localRenderPath;
    if (!episodePath) {
      throw new Error("The voiced episode file is missing; the voices step did not record it.");
    }
    const result = await assembleAudioEpisode({
      episodePath,
      themeMusicPath: music.themePath,
      creditsMusicPath: music.creditsPath,
    });
    const timed = offsetSegments(segments, result.layout.episodeOffsetSeconds);
    await db.update(schema.generatedShows)
      .set({ localRenderPath: result.outputPath, transcriptSegments: timed })
      .where(eq(schema.generatedShows.id, showId));
    await patchEngineNotes(db, schema, showId, { layout: result.layout, assemblyMs: result.assemblyMs });
    cleanupTempFiles([episodePath, music.themePath, music.creditsPath]);
    console.log(`[workflow:stitch] Audio episode assembled: ${result.outputPath}`);
  } else {
    const { assembleEpisode } = await import("@/app/lib/assemble");
    const clips = await db.query.videoClips.findMany({
      where: eq(schema.videoClips.showId, showId),
      orderBy: (vc, { asc }) => [asc(vc.clipIndex)],
    });
    if (clips.length === 0) {
      throw new Error("No video clips were recorded for this show; nothing to assemble.");
    }
    const notReady = clips.filter(c => c.status !== "ready" || !c.videoUrl);
    if (notReady.length > 0) {
      throw new Error(
        `Clip${notReady.length === 1 ? "" : "s"} ${notReady.map(c => c.clipIndex).join(", ")} ${notReady.length === 1 ? "is" : "are"} not ready; ` +
        "refusing to assemble an episode with missing beats.",
      );
    }

    const result = await assembleEpisode({
      clips: clips.map(c => ({
        path: c.videoUrl!,
        durationSeconds: c.measuredDurationSeconds ?? c.durationSeconds,
      })),
      showName: template.name,
      episodeTitle: notes.script?.title ?? show.topic,
      creditsLine: firstLyricLine(music.creditsLyrics),
      themeMusicPath: music.themePath,
      creditsMusicPath: music.creditsPath,
    });

    // One clip per segment, so the transcript follows the measured layout.
    const timed = segments.length === result.layout.clipDurations.length ?
        timeSegmentsFromDurations(segments, result.layout.clipDurations, result.layout.titleCardSeconds) :
      segments;
    if (timed === segments) {
      console.warn(`[workflow:stitch] ${segments.length} segments vs ${clips.length} clips; transcript timings left as planned`);
    }

    await db.update(schema.generatedShows)
      .set({ localRenderPath: result.outputPath, transcriptSegments: timed })
      .where(eq(schema.generatedShows.id, showId));
    await patchEngineNotes(db, schema, showId, { layout: result.layout, assemblyMs: result.assemblyMs });
    cleanupTempFiles([...clips.map(c => c.videoUrl!), music.themePath, music.creditsPath]);
    console.log(`[workflow:stitch] Episode assembled: ${result.outputPath} (${result.layout.totalSeconds}s)`);
  }

  await writeToStream(progress, { type: "completed", step: "stitch" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 7: Upload to Mux
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadStepImpl(
  progress: WritableStream<ProgressEvent>,
  showId: string,
): Promise<void> {
  await writeToStream(progress, { type: "current", step: "upload" });

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await getDb();
  const { createDirectUpload, waitForAssetReady, waitForUploadAssetId } = await import("@/app/lib/mux");

  await setStatus(db, schema, showId, "uploading");

  const show = await loadShow(db, schema, showId);

  const renderPath = show.localRenderPath ?? null;
  if (!renderPath) {
    throw new Error("Rendered episode path not found");
  }

  // Upload to Mux via direct upload. If Mux has filled up between the preflight
  // check and now, keep the rendered file on disk and tell the user where it is
  // rather than discarding a completed (and paid-for) render.
  console.log("[workflow:upload] Creating Mux direct upload...");
  let uploadId: string;
  let uploadUrl: string;
  try {
    ({ uploadId, uploadUrl } = await createDirectUpload());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/limited to \d+ assets|exceeding this limit/i.test(detail)) {
      const msg = `Mux storage filled up before upload. Your rendered show was kept at: ${renderPath}. ` +
        "Delete a show from the library to free a slot, then use Retry upload. " +
        "The render is complete, so retrying costs nothing to regenerate.";
      console.error("[workflow:upload] Mux full; preserving local render at", renderPath);
      await db.update(schema.generatedShows)
        .set({ status: "failed", error: msg })
        .where(eq(schema.generatedShows.id, showId));
      throw new Error(msg);
    }
    throw error;
  }
  console.log("[workflow:upload] Upload URL created, uploadId:", uploadId);

  const fs = await import("node:fs");
  const fileBuffer = fs.readFileSync(renderPath);

  const contentType = renderPath.endsWith(".wav") ? "audio/wav" : "video/mp4";
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    console.error("[workflow:upload] Mux upload failed:", uploadResponse.status, body);
    throw new Error(`Failed to upload to Mux: ${uploadResponse.status}`);
  }
  console.log("[workflow:upload] File uploaded to Mux, waiting for asset ID...");

  const assetId = await waitForUploadAssetId(uploadId);
  console.log("[workflow:upload] Asset ID resolved:", assetId, "waiting for asset ready...");

  const readyAsset = await waitForAssetReady(assetId, 5 * 60 * 1000);
  console.log("[workflow:upload] Asset ready, playback IDs:", readyAsset.playback_ids?.length);

  const playbackId = readyAsset.playback_ids?.[0]?.id;
  if (!playbackId) {
    throw new Error("Mux asset ready but no playback ID found");
  }

  // Update the show record, clearing the stashed path now that upload succeeded.
  await db.update(schema.generatedShows)
    .set({
      status: "ready",
      // Terminal state: stop storing the visitor's key.
      encryptedApiKeys: null,
      muxAssetId: assetId,
      muxPlaybackId: playbackId,
      error: null,
      localRenderPath: null,
    })
    .where(eq(schema.generatedShows.id, showId));

  const { cleanupTempFiles } = await import("@/app/lib/stitch");
  cleanupTempFiles([renderPath]);

  await writeToStream(progress, { type: "completed", step: "upload" });
  await closeStream(progress);
}
