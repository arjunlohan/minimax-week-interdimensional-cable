# MiniMax Week rebuild: task list

Brief: rebuild Interdimensional Cable on MiniMax models served through GMI Cloud, in this new repo, and ship one 60 to 120 s episode. The Google-era repo stays untouched.

## Phase 0: prove access
- [x] New public repo `arjunlohan/minimax-week-interdimensional-cable`, history preserved, origin re-pointed, pushed
- [x] Database cloned (`interdimensional_cable_minimax`), migrations 0007 to 0009 applied, 7 templates seeded
- [x] `ai@7` + `@ai-sdk/gmicloud@3` installed; `@google/genai` removed
- [x] Shared layer: `app/lib/gmi/*`, `app/lib/media.ts`, `env.ts`, `api-keys.ts` (GMI key), schema + migration 0009
- [x] `scripts/gmi-smoke.ts` written (`npm run gmi:smoke`, `--video`, `--voices`)
- [x] GMI_CLOUD_APIKEY in .env.local
- [x] Smoke: M3 text + JSON ok (5 s), Speech 2.8 HD ok (22 to 144 s queue), Music 3.0 ok after RPM resubmit (50 s song)
- [ ] `--video` smoke ($0.26): upload signature fixed (image/jpg); H3 comparison running
- [ ] Record observations in DOCS/gmi-contracts.md and the audio strategy decision

## Phase 1: swap the model layer
- [x] A. dramaturgy passes + research sources on M3 (116 tests)
- [x] B. speech (tts.ts) + voices + skills on Speech 2.8 HD (120 tests)
- [x] C. memory bank, full-text search, chat/tangents, taskmaster, summarize, social clips on M3 (45 tests)
- [ ] D1. workflow: H3 clips in reference mode, music step, assembly, podcast path (agent)
- [x] D2. create flow: format selector, durations, BYOK GMI key, progress labels
- [x] E. rebrand: homepage strip, footer logos, README, CLAUDE.md, AGENTS.md, .env.example, DOCS/submission.md
- [x] api-keys.test.ts ported; app/lib/gmi/gmi.test.ts added (34 tests)
- [ ] Whole project: `npx tsc --noEmit` 0 errors, `npm run lint` clean, `npm test` green, `npm run build` clean
- [ ] Google grep returns only font imports and the README provenance line

## Phase 2: hero episode
- [ ] Free a Mux slot if the preflight says the plan is full
- [ ] 90 s video show through the real workflow; verify with ffprobe and the watch page (screenshot)
- [ ] Spend recorded in DOCS/spend-ledger.md

## Phase 3: submission surface
- [ ] README with model map, shot list, provenance; DOCS/submission.md with the X post draft
- [ ] Push

## Phase 4 (only after 1 to 3)
- [ ] M3 dailies review of each clip
- [ ] FTS + M3 rerank for the memory tier
- [ ] Voice-cloned announcer
- [ ] Vercel deployment with BYOK on

## Deleted tests (with reasons)
- dramaturgy group: none deleted (expectations for video beats moved from 5 × 8 s to 4 × 10 s at 40 s; the 8 s grid is asserted under `format: "audio"`).
- tts.test.ts: six tests that asserted Gemini SDK shapes (speechConfig, multiSpeakerVoiceConfig, model ids, finishReason SAFETY, Gemini translation contents); each replaced by a Speech 2.8 equivalent.
- memory-bank.test.ts: "strips markdown code fences" (fence stripping now lives in app/lib/gmi/text extractJsonValue); replaced by three generateJson-contract tests.
- m3-m4-challenger.test.ts: section 1 (six tests, the 40 s Veo clip-cap routing), section 2 (five tests, Gemini TTS call parameters), section 3 (four tests, RIFF wrapping of Gemini PCM), section 8 code-fence resilience (same reason as memory-bank).
- app/lib/veo.test.ts, app/lib/m1-challenger.test.ts: deleted whole (they exercised the Google Omni/Veo SDK surface); behaviours that survive (content-filter revision, prompt sanitising) are re-homed by the workflow agent.
- app/lib/api-keys.test.ts: three assertions about resolveGeminiDeveloperKey and the two Google key prefixes, replaced by GMI-key equivalents.

## Deviations from the brief
(none yet)

## Review
(filled in at the end)
