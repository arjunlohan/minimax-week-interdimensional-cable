# MiniMax Week rebuild: task list

Brief: rebuild Interdimensional Cable on MiniMax models served through GMI Cloud, in this new repo, and ship one 60 to 120 s episode. The Google-era repo stays untouched.

## Phase 0: prove access

- [x] New public repo `arjunlohan/minimax-week-interdimensional-cable`, history preserved, origin re-pointed, pushed
- [x] Database cloned (`interdimensional_cable_minimax`), migrations 0007 to 0009 applied, 7 templates seeded with MiniMax voice ids
- [x] `ai@7` + `@ai-sdk/gmicloud@3` installed; `@google/genai` removed
- [x] Shared layer: `app/lib/gmi/*`, `app/lib/media.ts`, `env.ts`, `api-keys.ts` (GMI key), schema + migration 0009
- [x] `scripts/gmi-smoke.ts` (`npm run gmi:smoke`, `--video`, `--voices`, `--only=`, `--line=`)
- [x] GMI_CLOUD_APIKEY in .env.local
- [x] Smoke: M3 text + JSON ok (about 5 s), Speech 2.8 HD ok (queue 20 s to 5+ min), Music 3.0 ok after an RPM resubmit (50 s song), upload API ok (signed content types per file type)
- [ ] `--video` smoke ($0.26): BLOCKED, MiniMax-H3 returns HTTP 402 "Insufficient credits" until the GMI account is topped up; the audio-strategy comparison waits on it
- [x] Observations in DOCS/gmi-contracts.md

## Phase 1: swap the model layer

- [x] A. dramaturgy passes + research sources on M3 (115 tests)
- [x] B. speech (tts.ts) + voices + skills on Speech 2.8 HD (120 tests)
- [x] C. memory bank, full-text search, chat/tangents, taskmaster, summarize, social clips on M3 (45 tests)
- [x] D1. workflow on H3, Speech, Music (82 tests); split into workflow / steps / shared so the DevKit bundle stays Node-free
- [x] D2. create flow: format selector, durations with cost, BYOK GMI key, progress labels
- [x] E. rebrand: homepage strip, footer logos, README, CLAUDE.md, AGENTS.md, .env.example, DOCS/submission.md
- [x] api-keys.test.ts ported; app/lib/gmi/gmi.test.ts added
- [x] Whole project: `npx tsc --noEmit` 0 errors, `npm run lint` 0 errors, `npm test` 412 passing in 19 files, `npm run build` clean (20 routes)
- [x] Google grep: only font imports (next/font/google, @remotion/google-fonts), the README provenance line, historical migration comments and this task file

## Phase 2: hero episode

- [x] Mux capacity checked: 4 of 10 used, no cleanup needed
- [x] End-to-end audio episode on the free models (show 4bfa4ea8, Joe Rogan Like, 60 s plan): ready on Mux as a 131.8 s asset (8 s theme + 108.8 s episode + 15 s sung credits), transcript offset by the theme, plays in the watch page and at https://player.mux.com/9n00bwSpEQVU003A3v02r8PLMi5oOAv4p01lQNtqWSH2VlU
- [x] Live on that episode: in-character Q&A (M3, grounded in the brief, memory adapted) and a 35 s audio tangent (M3 script + Speech 2.8 HD) both worked from the watch page
- [x] Fixes from that run: shorter search queries when the topic sentence finds no Hacker News hits; pass 3 tightens lines that would overrun their beat (M3 wrote about 2x the words); video lines voiced four at a time; 15 min speech-queue timeout with an on-disk line cache
- [x] Desk-format audio episode (show 7d1c0a2e, SNL Like, 60 s, the hero topic): 8 beats, 149 words, spoken 55.8 s (one line tightened by the runtime fit), ready on Mux as 78.8 s with theme and sung credits; https://player.mux.com/rxZl11nNnt5c01EcsSZFdq3n53n6BbJzBpXSWTziYTG8
- [ ] 90 s video show through the real workflow (needs GMI credits); verify with ffprobe and the watch page (screenshot)
- [ ] Spend recorded in DOCS/spend-ledger.md (currently $0.00)

## Phase 3: submission surface

- [x] README with model map, shot list, provenance; DOCS/submission.md with the X post drafts
- [ ] Fill `{{HERO_WATCH_URL}}`, `{{HERO_SPEND}}`, `{{DEMO_VIDEO_URL}}` once the hero exists
- [x] Pushed

## Phase 4 (only after 1 to 3)

- [ ] M3 dailies review of each clip (needs H3 clips)
- [ ] FTS + M3 rerank for the memory tier
- [ ] Voice-cloned announcer (needs a recording from the user)
- [x] Vercel deployment live at https://minimax-week-interdimensional-cable.vercel.app: hosted Neon database `interdimensional_cable` migrated and carrying the library; `/api/health` ok (the owner-entered variables had been saved blank and Sensitive; fixed through `npm run vercel:env-push`); `/create` lists the seven templates and `/media` the two audio episodes; the create action now starts the workflow in-process. BYOK stays off for the demo (spend guard caps MiniMax-H3 at $8)

## Deleted tests (with reasons)

- dramaturgy group: none deleted (expectations for video beats moved from 5 × 8 s to 4 × 10 s at 40 s; the 8 s grid is asserted under `format: "audio"`).
- tts.test.ts: six tests that asserted the previous SDK's shapes (speechConfig, multiSpeakerVoiceConfig, model ids, finishReason SAFETY, translation contents); each replaced by a Speech 2.8 equivalent.
- memory-bank.test.ts: "strips markdown code fences" (fence stripping now lives in app/lib/gmi/text extractJsonValue); replaced by three generateJson-contract tests.
- m3-m4-challenger.test.ts: section 1 (six tests, the 40 s clip-cap routing), section 2 (five tests, previous TTS call parameters), section 3 (four tests, RIFF wrapping of raw PCM), section 8 code-fence resilience (same reason as memory-bank).
- app/lib/veo.test.ts, app/lib/m1-challenger.test.ts: deleted whole (they exercised the previous video SDK surface); the content-filter revision loop and prompt sanitising are covered by the new workflow tests.
- app/lib/api-keys.test.ts: three assertions about the previous provider's two key prefixes, replaced by GMI-key equivalents.

## Deviations from the brief

- Nine "ready" rows pointed at Mux assets the previous project had deleted; they are now `archived` with an explanatory error instead of being listed as playable. Three imported video rows without assets were removed. Only the assets Mux still holds (three talks, one 16 s episode) remain.
- Legacy templates (rank 100) stay in the database for the old episodes but are hidden from the create picker; their hosts carry real performers' names.
- The provenance panel reads `engineNotes.engines` and labels pre-rebuild episodes as made by the previous engine rather than crediting MiniMax.
- The workflow file was split three ways (workflow, steps, shared) because the DevKit's workflow bundle traces every exported symbol.
- The hero video episode is blocked on the GMI deposit (HTTP 402); the pipeline was validated end to end on the free models with audio episodes instead, and the video path is covered by tests.
- The legacy caption and audio translation feature (`@mux/ai`, ElevenLabs, S3) was removed: the package exits the process at import when Mux credentials are absent and the DevKit inlines it into its step bundle, which broke every Vercel build without secrets. The imported talks, their player, summaries and social clips stay.

## Review

State at 2026-09-06 21:40 PDT, commit 0c05a00 on `main` (public).

- Verified this session: `npx tsc --noEmit` 0 errors; `npm run lint` 0 errors; `npm test` 412 passing in 19 files; `npm run build` clean, including a build with the env file hidden (18 routes), which is what Vercel runs before variables are set.
- Live on GMI Cloud with the free models: two complete audio episodes (a two-host podcast and a desk show on the hero topic), each with an M3-written script grounded on fetched sources where Hacker News had any, Speech 2.8 HD voices with per-line emotion, a Music 3.0 theme and a sung credits recap, assembled by ffmpeg and published to Mux; in-character chat and a 35 s audio tangent from the watch page; the M3 summary path failing honestly on a talk without a transcript.
- Not verified: MiniMax-H3. Every submission returns HTTP 402 until the GMI account carries credits, so the reference-audio experiment, the audio-strategy decision, the 90 s hero episode, the spend ledger and the README placeholders all wait on the deposit. The video path is covered by 82 workflow tests and the payload builders by unit tests, but no clip has been rendered.
- Deployment: `DOCS/deploy.md` lists the Vercel variables and the hosted Postgres step; the build no longer needs secrets.
- Next actions, in order, once credits exist: `npm run gmi:smoke -- --only=video` ($0.26), pick the audio strategy from the two clips, create a 90 s video show from `/create` with the SNL Like template and the hero topic, fill `{{HERO_WATCH_URL}}` and `{{HERO_SPEND}}`, record the 3-minute demo, submit.
