/* eslint-disable node/no-process-env */
import { z } from "zod";

function optionalString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z.string().trim().min(1, message).optional(),
  ).describe(description);
}

function requiredString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" ? value.trim().length > 0 ? value.trim() : undefined : value,
    z.string().trim().min(1, message),
  ).describe(description);
}

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development").describe("Runtime environment."),

  // Mux credentials (required for playback, uploads and the legacy @mux/ai primitives)
  MUX_TOKEN_ID: requiredString("Mux access token ID.", "Required to access Mux APIs"),
  MUX_TOKEN_SECRET: requiredString("Mux access token secret.", "Required to access Mux APIs"),

  // Mux plan capacity (free plan caps stored assets; generation is wasted if we exceed it)
  MUX_ASSET_LIMIT: optionalString("Max stored Mux assets for the current plan (default 10, the free-plan cap)."),

  // Mux signing keys (optional, for signed playback URLs)
  MUX_SIGNING_KEY: optionalString("Mux signing key ID for signed playback URLs."),
  MUX_PRIVATE_KEY: optionalString("Mux signing private key for signed playback URLs."),

  // GMI Cloud. One key drives every model call: MiniMax-M3 (research, scripting,
  // memory, chat), MiniMax-H3 (video), Speech 2.8 HD (voices), Music 3.0 (score).
  GMI_CLOUD_APIKEY: optionalString("GMI Cloud API key. Serves every MiniMax model call. Optional only when REQUIRE_USER_API_KEYS makes visitors bring their own."),
  GMI_TEXT_MODEL: optionalString("Text model id on GMI Cloud (default MiniMaxAI/MiniMax-M3)."),
  H3_RESOLUTION: optionalString("MiniMax-H3 output resolution: 768P or 2K (default 768P)."),
  // How a clip gets its dialogue audio. "reference": attach the Speech 2.8 line
  // as reference audio and keep H3's track when it has one; "native": let H3
  // voice the line itself; "overlay": always replace the clip's audio with the
  // Speech 2.8 line. A silent clip always falls back to the overlay.
  H3_AUDIO_STRATEGY: optionalString("MiniMax-H3 dialogue strategy: reference (default), native, or overlay."),

  // Spend guard. MiniMax-H3 is the only paid model in the pipeline ($0.13 per
  // request); the caps refuse a request rather than silently degrading a show.
  H3_MAX_REQUESTS_PER_RUN: optionalString("Maximum MiniMax-H3 requests a single show may issue (default 14)."),
  H3_SESSION_CAP_USD: optionalString("Maximum cumulative MiniMax-H3 spend recorded in this database, in USD (default 8)."),

  // Bring-your-own-key. On a public deployment the visitor supplies the GMI
  // Cloud key and GMI bills them directly, so strangers cannot spend the
  // owner's inference credits. Leave unset for local development.
  REQUIRE_USER_API_KEYS: optionalString("Set to \"true\" to require visitors to supply their own GMI Cloud API key before generating."),
  KEY_ENCRYPTION_SECRET: optionalString("Secret used to encrypt visitor API keys at rest. Required when REQUIRE_USER_API_KEYS is true. Generate with: openssl rand -base64 32"),

  // ElevenLabs API key (optional; required only by the legacy translateAudio workflow)
  ELEVENLABS_API_KEY: optionalString("ElevenLabs API key for the legacy translateAudio workflow."),

  // S3-compatible storage. Optional: only the legacy @mux/ai translation
  // primitives read these, and those also need ELEVENLABS_API_KEY.
  S3_ENDPOINT: optionalString("S3-compatible endpoint for the legacy translation workflows."),
  S3_REGION: optionalString("S3 region for the legacy translation workflows."),
  S3_BUCKET: optionalString("S3 bucket for the legacy translation workflows."),
  S3_ACCESS_KEY_ID: optionalString("S3 access key ID for the legacy translation workflows."),
  S3_SECRET_ACCESS_KEY: optionalString("S3 secret access key for the legacy translation workflows."),

  // Database (PostgreSQL)
  DATABASE_URL: requiredString("PostgreSQL connection string. Required to store shows, transcripts, memory and the spend ledger.", "Required to connect to the database."),

  // Remotion Lambda (optional; required only if you want to render social clips)
  REMOTION_AWS_ACCESS_KEY_ID: optionalString("Remotion AWS access key ID for rendering social clips."),
  REMOTION_AWS_SECRET_ACCESS_KEY: optionalString("Remotion AWS secret access key for rendering social clips."),

  // Base URL (optional)
  NEXT_PUBLIC_BASE_URL: optionalString("Base URL for public endpoints and workflow callbacks."),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  // Skip validation during Next.js build phase to allow building without runtime env vars
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return process.env as unknown as Env;
  }

  const parsedEnv = EnvSchema.safeParse(process.env);

  if (!parsedEnv.success) {
    // In development, show detailed errors
    // In production, fail fast but don't leak sensitive info
    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      console.error("❌ Invalid environment variables:");
      console.error(JSON.stringify(parsedEnv.error.flatten().fieldErrors, null, 2));
    } else {
      console.error("❌ Invalid environment configuration. Check your environment variables.");
    }

    throw new Error("Environment validation failed");
  }

  return parsedEnv.data;
}

// Parse on module load (server-side only)
const env: Env = parseEnv();

export { env };
export default env;
