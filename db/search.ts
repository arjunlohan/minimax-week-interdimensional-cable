import { and, desc, eq, sql } from "drizzle-orm";

import { getPlaybackIdForAsset } from "@/app/lib/mux";
import { checkRateLimit, getClientIp } from "@/app/lib/rate-limit";

import { db, videoChunks, videos } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Full-text search helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// Retrieval runs on Postgres full-text search; there is no embedding model in
// front of it. `video_chunks.search_vector` is a generated tsvector over each
// chunk's transcript text (db/migrations/0009_minimax_week.sql) with a GIN
// index, so a query is one indexed `@@` match. Postgres owns that column, which
// is why it is absent from the Drizzle schema and referenced with raw `sql`.

/** The user's words as a tsquery. Web-search syntax: quotes, OR, a leading minus. */
function toTsQuery(query: string) {
  return sql`websearch_to_tsquery('english', ${query})`;
}

function matchCondition(query: string) {
  return sql`${videoChunks}.search_vector @@ ${toTsQuery(query)}`;
}

/**
 * Cover-density rank normalised into 0..1. Normalisation flag 32 divides the
 * rank by (rank + 1), so scores stay comparable across queries and the result
 * keeps the `similarity_score` field the callers already read.
 */
function rankExpression(query: string) {
  return sql<number>`ts_rank_cd(${videoChunks}.search_vector, ${toTsQuery(query)}, 32)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result from the video chunk search */
export interface VideoChunkResult {
  chunk_id: string;
  mux_asset_id: string;
  parent_video_tags: string[] | null;
  similarity_score: number;
  video_id: string;
  playback_id: string | null;
  title: string | null;
  summary: string | null;
  start_time: number | null;
  end_time: number | null;
}

/** Result from searching within a specific video's transcript */
export interface ChunkWithinVideoResult {
  chunkId: string;
  startTime: number | null;
  similarityScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rate limit error for search operations.
 */
export class SearchRateLimitError extends Error {
  constructor(
    message: string,
    public readonly resetAt: Date,
    public readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "SearchRateLimitError";
  }
}

/**
 * Searches transcript chunks across every imported video with Postgres
 * full-text search, best match first.
 * @throws {SearchRateLimitError} When rate limit is exceeded.
 */
export async function searchVideoChunks(
  query: string,
  limit: number = 10,
): Promise<VideoChunkResult[]> {
  if (!query.trim()) {
    return [];
  }

  // Check rate limit for search
  const clientIp = await getClientIp();
  const rateLimitResult = await checkRateLimit(clientIp, "search");

  if (!rateLimitResult.allowed) {
    const retryAfterSeconds = Math.ceil((rateLimitResult.resetAt.getTime() - Date.now()) / 1000);
    throw new SearchRateLimitError(
      `Search rate limit exceeded. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
      rateLimitResult.resetAt,
      retryAfterSeconds,
    );
  }

  const rank = rankExpression(query);

  const results = await db
    .select({
      chunkId: videoChunks.id,
      videoId: videoChunks.videoId,
      startTime: videoChunks.startTime,
      endTime: videoChunks.endTime,
      muxAssetId: videos.muxAssetId,
      title: videos.title,
      summary: videos.summary,
      tags: videos.tags,
      rank,
    })
    .from(videoChunks)
    .innerJoin(videos, eq(videoChunks.videoId, videos.id))
    .where(matchCondition(query))
    .orderBy(desc(rank))
    .limit(limit);

  // Fetch playback IDs from Mux (in parallel)
  const uniqueAssetIds = [...new Set(results.map(r => r.muxAssetId))];
  const playbackResults = await Promise.all(
    uniqueAssetIds.map(async (assetId) => {
      try {
        const result = await getPlaybackIdForAsset(assetId);
        return { assetId, playbackId: result.playbackId };
      } catch {
        return { assetId, playbackId: null };
      }
    }),
  );
  const playbackMap = new Map(playbackResults.map(r => [r.assetId, r.playbackId]));

  // Map to expected format
  return results.map(result => ({
    chunk_id: result.chunkId,
    mux_asset_id: result.muxAssetId,
    parent_video_tags: result.tags,
    similarity_score: Number(result.rank),
    video_id: result.videoId,
    playback_id: playbackMap.get(result.muxAssetId) ?? null,
    title: result.title,
    summary: result.summary,
    start_time: result.startTime,
    end_time: result.endTime,
  }));
}

/**
 * Searches one video's transcript chunks with Postgres full-text search.
 * Returns matching chunks with start times for transcript scrolling.
 */
export async function searchChunksWithinVideo(
  query: string,
  muxAssetId: string,
  limit: number = 10,
): Promise<ChunkWithinVideoResult[]> {
  if (!query.trim()) {
    return [];
  }

  const rank = rankExpression(query);

  const results = await db
    .select({
      chunkId: videoChunks.id,
      startTime: videoChunks.startTime,
      rank,
    })
    .from(videoChunks)
    .innerJoin(videos, eq(videoChunks.videoId, videos.id))
    .where(and(
      eq(videos.muxAssetId, muxAssetId),
      matchCondition(query),
    ))
    .orderBy(desc(rank))
    .limit(limit);

  return results.map(result => ({
    chunkId: result.chunkId,
    startTime: result.startTime,
    similarityScore: Number(result.rank),
  }));
}
