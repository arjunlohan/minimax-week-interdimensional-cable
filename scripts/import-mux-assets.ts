/* eslint-disable no-console, node/no-process-env */
import Mux from "@mux/mux-node";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../db/schema";

// Load environment variables first
dotenv.config({ path: ".env.local" });

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LANGUAGE = "en";

/** Rows per INSERT. Five bound parameters per chunk keeps this far under pg's limit. */
const CHUNK_INSERT_BATCH = 500;

// Parse command line args
const args = process.argv.slice(2);
const languageIndex = args.indexOf("--language");
const languageCode = languageIndex !== -1 ? args[languageIndex + 1] : DEFAULT_LANGUAGE;

console.log(`Using language code: ${languageCode}`);

// ─────────────────────────────────────────────────────────────────────────────
// Database setup
// ─────────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool, { schema });

// ─────────────────────────────────────────────────────────────────────────────
// Mux client
// ─────────────────────────────────────────────────────────────────────────────

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// Main import function
// ─────────────────────────────────────────────────────────────────────────────

async function importMuxAssets() {
  console.log("Fetching Mux assets...");

  // Fetch all assets from Mux (paginated)
  const allAssets: Mux.Video.Asset[] = [];
  let page: Awaited<ReturnType<typeof mux.video.assets.list>> | undefined;

  do {
    page = await mux.video.assets.list({
      limit: 100,
    });
    allAssets.push(...page.data);
    console.log(`Fetched ${allAssets.length} assets so far...`);
  } while (page.data.length === 100);

  console.log(`\nTotal assets found: ${allAssets.length}`);

  // Filter to only ready assets with playback IDs
  const readyAssets = allAssets.filter(
    asset => asset.status === "ready" && asset.playback_ids && asset.playback_ids.length > 0,
  );

  console.log(`Ready assets with playback IDs: ${readyAssets.length}\n`);

  // Process each asset
  for (const asset of readyAssets) {
    console.log(`\n─────────────────────────────────────────────────────────`);
    console.log(`Processing: ${asset.meta?.title || asset.id}`);
    console.log(`Asset ID: ${asset.id}`);

    try {
      // Get the first public playback ID, or any playback ID
      const playbackId = asset.playback_ids?.find(p => p.policy === "public")?.id ||
        asset.playback_ids?.[0]?.id;

      // Fetch transcript VTT if available
      let transcriptVtt: string | null = null;
      const transcriptTrack = asset.tracks?.find(
        t => t.type === "text" && t.text_type === "subtitles" && t.status === "ready" && t.language_code === languageCode,
      );

      if (transcriptTrack && playbackId) {
        try {
          const vttUrl = `https://stream.mux.com/${playbackId}/text/${transcriptTrack.id}.vtt`;
          const vttResponse = await fetch(vttUrl);
          if (vttResponse.ok) {
            transcriptVtt = await vttResponse.text();
            console.log(`✓ Fetched transcript VTT (${transcriptVtt.length} chars)`);
          }
        } catch (e) {
          console.log(`  Could not fetch transcript: ${e}`);
        }
      }

      // Insert or update video record
      const [video] = await db
        .insert(schema.videos)
        .values({
          muxAssetId: asset.id,
          muxPlaybackId: playbackId,
          title: (asset.meta as { title?: string })?.title || null,
          meta: asset as unknown as Record<string, unknown>,
          aspectRatio: asset.aspect_ratio || null,
          duration: asset.duration || null,
          transcriptVtt,
        })
        .onConflictDoUpdate({
          target: schema.videos.muxAssetId,
          set: {
            muxPlaybackId: playbackId,
            title: (asset.meta as { title?: string })?.title || null,
            meta: asset as unknown as Record<string, unknown>,
            aspectRatio: asset.aspect_ratio || null,
            duration: asset.duration || null,
            transcriptVtt,
            updatedAt: new Date(),
          },
        })
        .returning();

      console.log(`✓ Video record saved (ID: ${video.id})`);

      // Parse VTT into chunks if available
      interface ChunkData {
        text: string;
        startTime?: number;
        endTime?: number;
      }
      const rawChunks: ChunkData[] = [];

      if (transcriptVtt) {
        // Simple VTT cue parser
        const cueBlocks = transcriptVtt.split(/\n\s*\n/);
        for (const block of cueBlocks) {
          const lines = block.trim().split("\n");
          const timeLine = lines.find(l => l.includes("-->"));
          if (timeLine) {
            const [startStr, endStr] = timeLine.split("-->").map(s => s.trim());
            const parseVttTime = (t: string) => {
              const parts = t.split(":");
              if (parts.length === 3) {
                return Number.parseFloat(parts[0]) * 3600 + Number.parseFloat(parts[1]) * 60 + Number.parseFloat(parts[2]);
              }
              if (parts.length === 2) {
                return Number.parseFloat(parts[0]) * 60 + Number.parseFloat(parts[1]);
              }
              return 0;
            };
            const textLines = lines.filter(l => !l.includes("-->") && !/^\d+$/.test(l.trim())).join(" ");
            if (textLines.trim()) {
              rawChunks.push({
                text: textLines.trim(),
                startTime: parseVttTime(startStr),
                endTime: parseVttTime(endStr),
              });
            }
          }
        }
      }

      // Without a transcript the title is the only searchable text, so index
      // that as a single chunk covering the whole asset.
      if (rawChunks.length === 0) {
        rawChunks.push({
          text: `${(asset.meta as { title?: string })?.title || "Video"} - ${asset.id}`,
          startTime: 0,
          endTime: asset.duration ? Math.round(asset.duration) : 60,
        });
      }

      console.log(`✓ Prepared ${rawChunks.length} chunks for full-text indexing`);

      // Delete existing chunks for this video (in case of re-import)
      await db
        .delete(schema.videoChunks)
        .where(eq(schema.videoChunks.videoId, video.id));

      // Store each chunk's text with its timings. Postgres derives the
      // tsvector (`search_vector`) from `text` on insert, so search needs no
      // model call at import or query time.
      const rows = rawChunks.map((chunk, i) => ({
        videoId: video.id,
        chunkIndex: i,
        startTime: chunk.startTime ?? null,
        endTime: chunk.endTime ?? null,
        text: chunk.text,
      }));

      for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
        await db.insert(schema.videoChunks).values(rows.slice(offset, offset + CHUNK_INSERT_BATCH));
      }
      console.log(`✓ Saved ${rows.length} transcript chunks for Postgres full-text search`);
    } catch (error) {
      console.error(`✗ Error processing asset ${asset.id}:`, error);
    }
  }

  console.log(`\n─────────────────────────────────────────────────────────`);
  console.log(`Import complete!`);

  await pool.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

importMuxAssets().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
