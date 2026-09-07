# AGENTS.md

Guidance for AI coding assistants working on this project. `CLAUDE.md` carries the short version; this file carries the patterns and the code shapes.

---

## What this project is

**Interdimensional Cable** is an autonomous AI showrunner built for MiniMax Week × GMI Cloud (track: Synthesis). A visitor picks a late-night format and gives it a topic; a durable workflow researches it, writes it, performs every line, renders the host on camera, scores a theme, sings the credits and publishes the episode to Mux. Afterwards the host answers questions in character, a memory bank remembers the listener, and a coordinator script can choose the next episode from Hacker News.

Two rules shape every change:

1. **Core generation runs on MiniMax models served through GMI Cloud.** Supporting infrastructure (Vercel Workflows, Postgres, Mux, FFmpeg) is fine and is named in the UI, never hidden.
2. **Every model call goes through `app/lib/gmi/`.** No other provider, no model ids or GMI fetches elsewhere.

The codebase started on 2026-08-29 for another event on a different model stack and was rebuilt on MiniMax during MiniMax Week (the README's provenance section names the original). The previous provider's SDK is gone; do not bring it back.

**Read next:**

- `context/application-explained.md`, `context/design-explained.md`, `context/implementation-explained.md`: the imported-talk features (`/media/[slug]`) that came with the original template and still exist as legacy layers.
- `README.md`: the model map, the pipeline, the demo shot list.

---

## Model map

| Model                                     | Id                                        | Role                                                                                                                                            | Module                                                             |
| :---------------------------------------- | :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| MiniMax-M3 (1M context)                   | `MiniMaxAI/MiniMax-M3` (`GMI_TEXT_MODEL`) | Research on fetched sources, three-pass writers' room, memory extraction, in-character chat and tangents, Taskmaster ranking, summaries, lyrics | `app/lib/gmi/text.ts` (Vercel AI SDK, `@ai-sdk/gmicloud`)          |
| MiniMax-H3 (video, 4 to 15 s, 768P or 2K) | `MiniMax-H3`                              | Every clip of a video episode, reference-to-video. $0.13 per request, the only paid model.                                                      | `app/lib/gmi/video.ts`, guarded by `app/lib/gmi/spend.ts`          |
| Speech 2.8 HD                             | `minimax-tts-speech-2.8-hd`               | One voice per line, emotion from the acting direction; podcasts; chat replies                                                                   | `app/lib/gmi/speech.ts`, `app/lib/tts.ts`, `app/lib/gmi/voices.ts` |
| Music 3.0                                 | `minimax-music-3.0`                       | Theme hook and sung end credits per episode                                                                                                     | `app/lib/gmi/music.ts`, mixed by `app/lib/assemble.ts`             |
| Voice clone 2.8 HD                        | `minimax-audio-voice-clone-speech-2.8-hd` | Optional, wired                                                                                                                                 | `app/lib/gmi/speech.ts` (`cloneVoiceAndSpeak`)                     |

Two GMI Cloud surfaces, one key: an OpenAI-compatible LLM endpoint (M3, through the AI SDK provider) and a request queue (`console.gmicloud.ai/api/v1/ie/requestqueue`) for the media models. Media inputs (portraits, a line of audio) must be public URLs, which `app/lib/gmi/upload.ts` provides.

---

## The shared GMI layer

```typescript
import { generateH3Clip, generateJson, generateMusic, generateText, synthesizeSpeechWav } from "@/app/lib/gmi";
```

- **Text:** `generateText({ system, prompt | messages, maxOutputTokens, temperature })` returns the reply with M3's reasoning stripped. `generateJson({ schema, label, ... })` validates with Zod and runs one repair round that feeds the validation error back. Always use `generateJson` for structured output; never regex a JSON blob out of a reply elsewhere.
- **Speech:** `synthesizeSpeech` (mp3) or `synthesizeSpeechWav` (24 kHz mono WAV, what the audio pipeline concatenates). One voice per request, so dialogue is synthesized a turn at a time. Emotions: `calm`, `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`.
- **Video:** `generateH3Clip({ prompt, durationSeconds, referenceImageUrls, referenceAudioUrls, showId })`. Reference inputs and first/last-frame inputs cannot be mixed in one request; `buildH3Payload` enforces that and the 4 to 15 s window. `buildClipPrompt` composes the shot; `referencePortraitUrls` uploads the template portrait once per process.
- **Music:** `generateMusic({ lyrics, prompt })`. Lyrics carry structure tags (`[Intro] [Verse] [Chorus] [Bridge] [Outro] [Hook] [Inst]`), the prompt carries genre and mood.
- **Errors:** `GmiApiError` (HTTP), `GmiRequestFailedError` (queue), `GmiContentFilterError` (a refusal; revise and retry), `BudgetExceededError` (the spend guard), `MissingApiKeyError` (no key in scope).

### Spend guard

`generateH3Clip` calls `assertH3Budget(showId)` and writes a `gmi_spend` row on submission, before the request can succeed or fail. Caps: `H3_MAX_REQUESTS_PER_RUN` (default 14) per show, `H3_SESSION_CAP_USD` (default 8) for the whole database. Both refuse. `getH3SpendSummary()` is what the UI and the ledger read. Never issue an H3 request outside `generateH3Clip`.

### Honesty rule

No canned content for a failed model call. Concretely:

- Research on a URL that cannot be fetched or is too short to read throws with the reason. It does not hand the model a bare URL.
- An empty or truncated model reply throws with the finish reason. There is no mock brief, mock script, or sample transcript.
- A refused clip may have its line rewritten by M3 and retried (at most twice). It is never replaced with a stock shot or a silent clip.
- A failed step writes its reason to `generated_shows.error`; `markFailedStep` keeps a specific stored reason over a generic one.

If you find yourself writing a fallback that produces plausible content without the model, stop: throw instead.

---

## Code style (ESLint)

`@antfu/eslint-config` with the rules in `eslint.config.mjs`:

- 2-space indent, semicolons always, double quotes, cuddled braces (`} else {`), operators at end of line.
- kebab-case file names (all-caps `.md` files excepted).
- `console.log` warns. Prefix logs (`[gmi:speech]`, `[workflow:upload]`).
- `node/no-process-env` is an error: read `env` from `app/lib/env.ts`.
- No em dashes anywhere. Commas, colons, parentheses; a middot in labels ("Score · Music 3.0").

Run `npx eslint --fix <files>` before finishing.

---

## Environment variables

Validated at startup by `app/lib/env.ts` (Zod). `.env.example` mirrors it.

```bash
# Required
GMI_CLOUD_APIKEY=          # every MiniMax model call (optional only with REQUIRE_USER_API_KEYS)
DATABASE_URL=              # Postgres, no extensions
MUX_TOKEN_ID=
MUX_TOKEN_SECRET=

# Tuning (optional)
GMI_TEXT_MODEL=            # default MiniMaxAI/MiniMax-M3
H3_RESOLUTION=             # 768P (default) | 2K
H3_AUDIO_STRATEGY=         # reference (default) | native | overlay
H3_MAX_REQUESTS_PER_RUN=   # default 14
H3_SESSION_CAP_USD=        # default 8
MUX_ASSET_LIMIT=           # default 10

# Public deployments: visitors bring their own GMI Cloud key
REQUIRE_USER_API_KEYS=true
KEY_ENCRYPTION_SECRET=     # openssl rand -base64 32

# Optional
NEXT_PUBLIC_BASE_URL=
MUX_SIGNING_KEY=  MUX_PRIVATE_KEY=
REMOTION_AWS_ACCESS_KEY_ID=  REMOTION_AWS_SECRET_ACCESS_KEY=                                        # legacy social clips
```

```typescript
import { env } from "@/app/lib/env";

const cap = env.H3_SESSION_CAP_USD; // correct
// process.env.H3_SESSION_CAP_USD    // wrong: bypasses validation, lint error
```

### Bring-your-own-key

`app/lib/api-keys.ts` scopes a visitor's GMI Cloud key with AsyncLocalStorage (`withUserApiKeys`) and encrypts it onto the show row for the life of the run. `resolveGmiKey()` prefers the scoped key, then `GMI_CLOUD_APIKEY`, unless `REQUIRE_USER_API_KEYS=true` forbids the server key. Durable steps do not share an async context, so every model-calling step in `workflows/generate-show.ts` wraps its body in `runWithShowKeys(showId, ...)`.

---

## Mux client (`app/lib/mux.ts`)

One shared `Mux` instance with typed helpers: `createDirectUpload`, `waitForUploadAssetId`, `waitForAssetReady`, `getMuxCapacity` (the preflight), asset and track lookups. Never construct `new Mux(...)` elsewhere.

---

## Vercel Workflow patterns

### Directive placement

```typescript
export async function generateShowWorkflow(showId: string) {
  "use workflow";
  await researchStep(progress, showId);
  // ...
}

async function researchStep(progress: WritableStream<ProgressEvent>, showId: string) {
  "use step";
  return runWithShowKeys(showId, () => researchStepImpl(progress, showId));
}
```

- Node modules (`node:fs`, `pg`, ffmpeg) exist only inside steps: `await import(...)` them there, never at the top of a workflow file.
- Each stage is one step and one retry unit. Persist results to Postgres before the step returns so a retry resumes instead of regenerating (and re-paying).
- Progress goes through `getWritable<ProgressEvent>({ namespace: "progress" })` and `workflows/workflow-progress.ts`; the UI polls `generated_shows.status`.

### Starting a workflow

```typescript
import { start } from "workflow/api";

import { generateShowWorkflow } from "@/workflows/generate-show";

await start(generateShowWorkflow, [showId]); // returns immediately
```

### The show pipeline

Video: research, script, voices, generate-clips, music, stitch, upload. Audio: research, script, voices, music, stitch, upload. Statuses: `researching`, `scripting`, `voicing`, `generating`, `scoring`, `stitching`, `uploading`, `ready`, `failed`. A capacity preflight against Mux runs before anything paid is generated.

### Resumability in the UI

`app/lib/workflow-state.ts` keeps in-flight runs in localStorage (`workflow:${assetId}:${workflowType}:${targetLang?}` for the legacy talk workflows) so a refresh rehydrates progress; the create flow polls the show row directly.

---

## Key routes

```
/                       # homepage: pitch, the pipeline, "Built for MiniMax Week"
/create                 # pick a format, give a topic, choose video or audio
/create/[showId]        # live progress with engine chips per step
/templates              # the show formats and their hosts
/watch/[showId]         # player, synced transcript, in-character chat, tangents, memory card, provenance
/media                  # library: generated shows and imported talks
/search                 # full-text transcript search
```

---

## Data model (Postgres via Drizzle)

`db/schema.ts`; migrations in `db/migrations/` (`0009_minimax_week.sql` is the rebuild).

- `show_templates`: name, show type, host list, reference portrait, notes, display order.
- `generated_shows`: topic, format (`video` | `audio`), duration, status, `voice_assignments` (host to MiniMax voice id, fixed at first voicing), `theme_lyrics`, `credits_lyrics`, `music_prompt`, `engine_notes`, `research_context`, transcript and segments, `local_render_path`, Mux ids, `encrypted_api_keys` (cleared on any terminal state), `error`.
- `video_clips`: per clip prompt, status, GMI request id, thumbnail, `audio_source` (`h3` | `tts-overlay`), measured duration.
- `gmi_spend`: the MiniMax-H3 ledger (show, model, request id, cents, status).
- `chat_messages`, `show_tangents`, `user_memories` (concept mastery, humor preference, interests, question patterns; confidence decays), `user_settings`.
- Legacy talks: `videos`, `video_chunks` (generated `search_vector` tsvector, GIN index), `rate_limits`, `feature_metrics`.

Mux stays the source of truth for playback; Postgres holds everything the product reasons about.

---

## Common tasks

### Adding a model capability

1. Add it to the right module under `app/lib/gmi/` (or a new one per model), exporting the model id constant and a typed request/response.
2. Route it through `runQueued` (media) or `generateText` / `generateJson` (M3).
3. If it costs money, put it behind the spend guard.
4. Re-export from `app/lib/gmi/index.ts`, probe it in `scripts/gmi-smoke.ts`, and note what the platform returned in `DOCS/gmi-contracts.md`.

### Adding a pipeline stage

1. One `"use step"` function in `workflows/generate-show.ts`, wrapped in `runWithShowKeys` if it calls a model.
2. A status value on `generated_shows.status`, a `GenerationStepId` and an engine chip entry in `app/create/[showId]/constants.ts`.
3. A row in the homepage stage list (`app/components/how-it-runs.tsx`) naming the model and the service.

### Adding an env var

Add it to `EnvSchema` in `app/lib/env.ts` with `requiredString` or `optionalString`, then to `.env.example` with a one-line comment.

### Running locally

```bash
npm run dev            # workflows execute locally; npx workflow web inspects runs
npm run gmi:smoke      # prove model access before touching the pipeline
npm test               # vitest
```

---

## Design principles

From `context/design-explained.md`, applied to the show product:

- Brutalist: thick black borders, sharp corners, hard shadows; Syne headings, Space Mono labels.
- The pipeline is visible: engine chips name the model and the service per step, on the homepage and in the create flow. Keep them truthful.
- Failures are shown verbatim, inline, never as toasts and never dressed up.
- Brand marks: `public/brand/minimax.svg` (coloured), `public/brand/gmi-cloud.svg` (`currentColor`, used as a CSS mask through `GmiCloudWordmark`).
