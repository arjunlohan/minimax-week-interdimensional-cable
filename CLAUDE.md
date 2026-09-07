# CLAUDE.md: Interdimensional Cable (MiniMax Week × GMI Cloud)

## What this project is

An autonomous AI showrunner. Pick a late-night format, give it a topic or a link, and a durable workflow researches it, writes it, performs every line, renders the host on camera, scores a theme, sings the credits and publishes a 60 to 120 second video episode (or an audio podcast up to five minutes). The host then answers questions in character and remembers the listener across sessions; a coordinator script can pick the next episode from Hacker News on its own.

Built for the MiniMax Week × GMI Cloud hackathon (track: Synthesis). The rule that shapes the code: **core generation runs on MiniMax models served through GMI Cloud; supporting infrastructure can come from anywhere and is named, not hidden.**

The architecture was started on 2026-08-29 for another event on a different model stack and rebuilt on MiniMax during MiniMax Week (the README's provenance section names the original). The previous provider's SDK is gone from the dependency tree. Do not reintroduce it or any other model provider.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · PostgreSQL + Drizzle (full-text search, no extensions) · Vercel Workflow DevKit · Mux · FFmpeg · Remotion (legacy social clips only)

---

## Model map

| Model                                                    | Used for                                                                                                                                                      | Where                                                                                                                                                                               |
| :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MiniMax-M3** (`MiniMaxAI/MiniMax-M3`, 1M context)      | Research on fetched sources, the three-pass writers' room, memory extraction, in-character chat and tangents, Taskmaster ranking, talk summaries, song lyrics | `app/lib/gmi/text.ts` via `@ai-sdk/gmicloud`; callers in `app/lib/dramaturgy/`, `app/lib/memory-bank.ts`, `app/watch/[showId]/chat/actions.ts`, `scripts/autonomous-trend-agent.ts` |
| **MiniMax-H3** (video, 4 to 15 s, 768P or 2K, $0.13/req) | Every clip of a video episode, reference-to-video: host portrait + that line's audio. The only paid model.                                                    | `app/lib/gmi/video.ts`, driven by `workflows/generate-show.ts`                                                                                                                      |
| **Speech 2.8 HD** (`minimax-tts-speech-2.8-hd`)          | One voice per line with emotion from the acting direction; fixed voice per host stored on the show; podcast episodes; chat replies                            | `app/lib/gmi/speech.ts`, `app/lib/tts.ts`, catalog in `app/lib/gmi/voices.ts`                                                                                                       |
| **Music 3.0** (`minimax-music-3.0`)                      | Theme hook and the sung end credits, rendered per episode                                                                                                     | `app/lib/gmi/music.ts`, mixed by `app/lib/assemble.ts`                                                                                                                              |
| **Voice clone 2.8 HD**                                   | Wired, optional                                                                                                                                               | `app/lib/gmi/speech.ts` (`cloneVoiceAndSpeak`)                                                                                                                                      |

---

## The shared GMI layer: `app/lib/gmi/`

**Every model call goes through this directory.** No `fetch` to GMI Cloud or MiniMax anywhere else, no other provider SDK, no model ids outside it.

- `client.ts`: the key (`requireGmiKey`), both base URLs (OpenAI-compatible LLM endpoint; request queue for media), `gmiFetchJson` with 429 and 5xx retry and GMI's nested error unwrapping.
- `text.ts`: `generateText` and `generateJson` (Zod schema, one repair round, M3's thinking stripped). Use `generateJson` for anything structured; never parse model output by hand elsewhere.
- `queue.ts`: submit, poll, download for the request queue. Content refusals become `GmiContentFilterError`; everything else `GmiRequestFailedError`.
- `upload.ts`: bytes to a public URL (content-addressed, cached per process). H3 inputs must be URLs.
- `speech.ts`, `music.ts`, `video.ts`, `voices.ts`: one module per model, each exporting its model id constant.
- `spend.ts`: the H3 spend guard (below).
- `index.ts` re-exports the public surface. Import from `@/app/lib/gmi`.

Key resolution: `resolveGmiKey()` in `app/lib/api-keys.ts` prefers the visitor's key (AsyncLocalStorage, bring-your-own-key) over `GMI_CLOUD_APIKEY`. Workflow steps do not share an async context, so each model-calling step re-establishes the scope through `runWithShowKeys`.

## Spend guard

MiniMax-H3 is the only paid model. `assertH3Budget(showId)` runs before every submission and `recordH3Request` writes the row to `gmi_spend` before the request is sent, so a crash after submission still counts. Two caps, both throwing `BudgetExceededError` rather than degrading the show: per run (`H3_MAX_REQUESTS_PER_RUN`, default 14) and all-time for the database (`H3_SESSION_CAP_USD`, default 8). Do not add H3 calls that bypass `generateH3Clip`.

## Honesty rule

**Never substitute canned content for a failed model call.** No mock research, placeholder scripts, silent clips, stock music, or "sample" transcripts. A URL that cannot be read fails the research step with the reason. An empty model reply throws with the finish reason. A refused clip may get a rewritten line and a retry (at most twice), never a stock shot. Every failing step stores its real reason on `generated_shows.error` so the UI can show it. A fallback that silently fabricates data is worse than a crash.

## Vercel Workflows

- `"use workflow"` is the first line inside the workflow function; `"use step"` the first line inside each step function.
- Node modules (`fs`, `pg`, ffmpeg) are only available inside steps: import them dynamically there, never at the top of `workflows/*.ts`.
- Trigger with `start()` from `workflow/api` in a route handler or server action; it returns immediately.
- A step boundary is the retry unit. Keep each stage one step; write intermediate results to Postgres before returning so a retry resumes rather than repeats.
- Progress is streamed with `getWritable` (`workflows/workflow-progress.ts`) and polled from `generated_shows.status`.

---

## Working rules

- Plan before non-trivial work (three or more steps, or anything architectural); write the plan to `tasks/todo.md` and keep it current. If something goes sideways, stop and re-plan.
- Never mark work done without proving it: `npx tsc --noEmit`, `npm run lint`, `npm test`, and for pipeline changes a real run with the smoke script or a generated show.
- Simplicity first, minimal impact, root causes over patches. Ask "is there a more elegant way?" on non-trivial changes and skip that question for obvious fixes.
- After any correction from the user, record the pattern in `tasks/lessons.md`.
- No em dashes in code, copy or docs. Use commas, colons or parentheses; in UI labels use a middot separator ("Voices · Speech 2.8 HD").

---

## Commands

```bash
npm run dev                    # http://localhost:3000
npm run build                  # production build
npm run lint                   # ESLint (antfu config); lint:fix to auto-fix
npm test                       # vitest
npm run db:generate            # migration from schema changes
npm run db:migrate             # apply migrations
npm run db:studio              # Drizzle Studio on :4983
npm run seed-templates         # show formats and hosts
npm run gmi:smoke              # M3 + Speech 2.8 + Music 3.0 (free); --video adds two H3 clips ($0.26); --voices probes every voice
npm run agent:taskmaster       # the autonomous coordinator
npm run import-mux-assets      # import Mux assets as browsable talks
npm run remotion:studio        # legacy social clips
```

---

## Conventions

- kebab-case file names. 2-space indent, double quotes, semicolons, cuddled braces, operators at line end. Imports sorted by `perfectionist/sort-imports` (side-effect styles, built-ins, external, internal, parent, sibling; blank lines between groups).
- Never read `process.env`; import `env` from `app/lib/env.ts` (Zod-validated). Add new variables to `EnvSchema` with `requiredString` or `optionalString`, then to `.env.example`.
- One Mux client: `app/lib/mux.ts`. Never construct `new Mux()` elsewhere.
- ffmpeg through `app/lib/media.ts` and `app/lib/stitch.ts` (`ffmpegBinary` resolves the bundled or system binary).
- `console.log` warns; keep logs prefixed (`[gmi:h3]`, `[workflow:stitch]`) and remove noise before committing.
- Client-side workflow progress lives in localStorage via `app/lib/workflow-state.ts`.

---

## Key directories

```
app/                        # Next.js App Router
app/lib/gmi/                # the shared MiniMax / GMI Cloud layer (every model call)
app/lib/dramaturgy/         # three-pass writers' room on M3
app/lib/skills/             # show formats: hosts, structure, guardrails
app/lib/memory-bank.ts      # cross-session listener memory (M3 extraction, Ebbinghaus decay)
app/lib/tts.ts              # per-line speech on Speech 2.8 HD
app/lib/media.ts, stitch.ts # ffmpeg helpers
app/create/                 # create flow and live progress with engine chips
app/watch/[showId]/         # player, synced transcript, chat, tangents, memory, provenance
workflows/generate-show.ts  # the durable pipeline
db/                         # Drizzle schema + migrations (0009 is the MiniMax Week schema)
scripts/                    # gmi-smoke, autonomous-trend-agent, seed-templates, import-mux-assets
public/brand/               # minimax.svg, gmi-cloud.svg
DOCS/                       # submission, spend ledger, gmi-contracts (from the smoke script), rate limits
tasks/                      # todo.md, lessons.md
```

---

## Database

- PostgreSQL via Drizzle (`db/schema.ts`). No extensions: transcript search is a generated `tsvector` column with a GIN index on `video_chunks`.
- Show pipeline tables: `show_templates`, `generated_shows` (format, status, `voice_assignments`, `theme_lyrics`, `credits_lyrics`, `music_prompt`, `engine_notes`, `local_render_path`, encrypted visitor key), `video_clips` (per clip: GMI request id, audio source, measured duration), `gmi_spend` (the H3 ledger), `chat_messages`, `show_tangents`, `user_memories`, `user_settings`.
- Legacy talk tables: `videos`, `video_chunks`, `rate_limits`, `feature_metrics`.

---

## Design system

- Brutalist: thick black borders, sharp corners, hard shadows. Syne for headings, Space Mono for labels and code.
- Engine chips name the model and the service running each step; keep them truthful to `workflows/generate-show.ts`.
- Brand marks in `public/brand/`: `minimax.svg` is coloured; `gmi-cloud.svg` fills with `currentColor` and is applied as a CSS mask (`GmiCloudWordmark` in `app/components/how-it-runs.tsx`) so it takes the text colour.
- Status UI: inline progress indicators, not toasts. Failures show the stored reason verbatim.
