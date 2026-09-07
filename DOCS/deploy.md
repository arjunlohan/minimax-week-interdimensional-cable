# Deploying to Vercel

The app deploys as a normal Next.js 16 project with the Workflow DevKit. The build itself needs no secrets, but two modules validate their configuration the moment they are imported (`@mux/ai`, used by the legacy caption and audio translation workflows, and `app/lib/env.ts` at runtime), so a deployment without the variables below fails at "Collecting page data" with `Invalid env: MUX_TOKEN_ID ... MUX_TOKEN_SECRET`.

## 1. Environment variables (Project Settings, Environment Variables, all environments)

| Variable                                                                              | Value                                                                     | Why                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GMI_CLOUD_APIKEY`                                                                    | your GMI Cloud key                                                        | Every MiniMax call. Leave it out only if `REQUIRE_USER_API_KEYS=true`                                                            |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`                                                    | from dashboard.mux.com                                                    | Playback, uploads, the capacity preflight, and the build                                                                         |
| `DATABASE_URL`                                                                        | a hosted Postgres connection string                                       | Shows, transcripts, memory, the spend ledger. Local Postgres is not reachable from Vercel; see step 2                            |
| `KEY_ENCRYPTION_SECRET`                                                               | `openssl rand -base64 32`                                                 | Encrypts visitor keys at rest; required when the next variable is on                                                             |
| `REQUIRE_USER_API_KEYS`                                                               | `true` on a public deployment, unset to let visitors spend the server key | Strangers cannot spend your GMI credits. With it off, the spend guard still caps MiniMax-H3 at `H3_SESSION_CAP_USD` (default $8) |
| `NEXT_PUBLIC_BASE_URL`                                                                | the deployment URL                                                        | Workflow callbacks from the create action                                                                                        |
| `H3_RESOLUTION`, `H3_AUDIO_STRATEGY`, `H3_MAX_REQUESTS_PER_RUN`, `H3_SESSION_CAP_USD` | optional                                                                  | Defaults: 768P, reference, 14, 8                                                                                                 |
| `MUX_ASSET_LIMIT`                                                                     | optional                                                                  | Free plan is 10                                                                                                                  |

`ELEVENLABS_API_KEY`, `S3_*` and `REMOTION_AWS_*` are only for the legacy translation and social-clip features and can stay unset.

## 2. Database

Add Postgres from the Vercel Marketplace (Neon or Supabase both work; no extensions are needed since search is Postgres full-text). The integration injects `DATABASE_URL`. Then, from your machine, point at it and prepare it:

```bash
DATABASE_URL="<hosted url>" npm run db:migrate
DATABASE_URL="<hosted url>" npm run seed-templates
```

To carry the local library (episodes, transcripts, memory) across, dump and restore instead of re-seeding:

```bash
pg_dump --no-owner --no-acl -h 127.0.0.1 -p 5432 interdimensional_cable_minimax | psql "<hosted url>"
```

## 3. Function duration

Each workflow step runs as one Vercel function invocation. Steps that wait on GMI's queues (a MiniMax-H3 clip can take minutes; Speech 2.8 lines have queued for over five) can run past Vercel's default 300 s limit, in which case the DevKit retries the step. For the hackathon the episodes are rendered from a local `npm run dev` and published to Mux, and the deployment serves the library, the watch pages, in-character chat and audio tangents. If you want generation on Vercel itself, raise the function `maxDuration` for the project (800 s on Pro) and prefer audio episodes.

## 4. ffmpeg

`ffmpeg-static` ships a Linux binary and `next.config.ts` traces it into the API and workflow functions, so assembly works on Vercel without a system ffmpeg.
