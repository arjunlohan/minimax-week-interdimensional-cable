# Deploying to Vercel

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

### Setting the values without seeing them

Pasting an `.env.example` block into the dashboard creates every name with an empty value, and once the project marks variables Sensitive nothing in the dashboard or `vercel env pull` can show that they are empty (they read back as `[SENSITIVE]`). The runtime tells the truth: `GET /api/health` reports each variable's `defined` flag and `length` (never the value). `defined: true, length: 0` means blank.

The reliable way in is the CLI, which pushes the values straight from `.env.local` and never prints them (run from the repo, after `vercel link`):

```bash
for name in MUX_TOKEN_ID MUX_TOKEN_SECRET GMI_CLOUD_APIKEY; do grep "^$name=" .env.local | cut -d= -f2- | tr -d '"\n' | vercel env add "$name" production --force; done
printf '%s' 'postgresql://user:password@host/db?sslmode=require' | vercel env add DATABASE_URL production --force
vercel redeploy https://<your-deployment>.vercel.app
```

Then confirm `ok: true` at `/api/health` before opening `/create`.

## 2. Database

Add Postgres from the Vercel Marketplace (Neon is the quickest; Supabase also works; no extensions are needed since search is Postgres full-text). The integration injects `DATABASE_URL`. Copy that value (Project Settings, Environment Variables, reveal) and prepare the database from your machine with the real URL, not a placeholder:

```bash
npm run db:prepare-hosted -- "postgresql://user:password@host/db?sslmode=require"
```

To carry the local library (episodes, transcripts, memory) across instead of starting empty, the target must be a brand-new empty database:

```bash
npm run db:prepare-hosted -- "postgresql://user:password@host/db?sslmode=require" --copy-local
```

The script checks the connection first, applies the migrations and seeds the templates (or copies the local database), then lists the tables. If you use the Vercel CLI, `vercel link` followed by `vercel env pull .env.vercel.local` writes the injected `DATABASE_URL` to a local file you can copy from.

## 3. Function duration

Each workflow step runs as one Vercel function invocation. Steps that wait on GMI's queues (a MiniMax-H3 clip can take minutes; Speech 2.8 lines have queued for over five) can run past Vercel's default 300 s limit, in which case the DevKit retries the step. For the hackathon the episodes are rendered from a local `npm run dev` and published to Mux, and the deployment serves the library, the watch pages, in-character chat and audio tangents. If you want generation on Vercel itself, raise the function `maxDuration` for the project (800 s on Pro) and prefer audio episodes.

## 4. ffmpeg

`ffmpeg-static` ships a Linux binary and `next.config.ts` traces it into the API and workflow functions, so assembly works on Vercel without a system ffmpeg.
