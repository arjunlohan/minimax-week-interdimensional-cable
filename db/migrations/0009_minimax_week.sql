-- Migration: 0009_minimax_week.sql
-- The MiniMax Week rebuild. Four changes:
--   1. Shows carry an explicit format instead of inferring it from duration
--      (MiniMax-H3 renders 60 to 120 s episodes, so "over 40 s means audio" no longer holds).
--   2. Per-show voice assignments and the lyrics Music 3.0 was given, for the watch page.
--   3. A spend ledger for MiniMax-H3, the only paid model, so the caps are enforced from data.
--   4. Semantic search moves from Google embeddings (pgvector) to Postgres full-text search.

-- 1. Explicit format
ALTER TABLE "generated_shows"
  ADD COLUMN IF NOT EXISTS "format" text NOT NULL DEFAULT 'video';

UPDATE "generated_shows" SET "format" = 'audio' WHERE "duration_seconds" > 40;

-- 2. Voices and music provenance
ALTER TABLE "generated_shows"
  ADD COLUMN IF NOT EXISTS "voice_assignments" jsonb,
  ADD COLUMN IF NOT EXISTS "theme_lyrics" text,
  ADD COLUMN IF NOT EXISTS "credits_lyrics" text,
  ADD COLUMN IF NOT EXISTS "music_prompt" text,
  ADD COLUMN IF NOT EXISTS "engine_notes" jsonb;

ALTER TABLE "video_clips"
  ADD COLUMN IF NOT EXISTS "gmi_request_id" text,
  ADD COLUMN IF NOT EXISTS "thumbnail_url" text,
  ADD COLUMN IF NOT EXISTS "audio_source" text,
  ADD COLUMN IF NOT EXISTS "measured_duration_seconds" real;

-- 3. Spend ledger
CREATE TABLE IF NOT EXISTS "gmi_spend" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "show_id" uuid REFERENCES "generated_shows"("id") ON DELETE SET NULL,
  "model" text NOT NULL,
  "request_id" text NOT NULL,
  "cost_cents" integer NOT NULL DEFAULT 0,
  "status" text,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "gmi_spend_model_idx" ON "gmi_spend" USING btree ("model");
CREATE INDEX IF NOT EXISTS "gmi_spend_show_id_idx" ON "gmi_spend" USING btree ("show_id");

-- 4. Full-text search over transcript chunks
DROP INDEX IF EXISTS "video_chunks_embedding_idx";

ALTER TABLE "video_chunks"
  DROP COLUMN IF EXISTS "embedding",
  ADD COLUMN IF NOT EXISTS "text" text;

ALTER TABLE "video_chunks"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce("text", ''))) STORED;

CREATE INDEX IF NOT EXISTS "video_chunks_search_idx" ON "video_chunks" USING gin ("search_vector");
