import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { gmiFetchJson } from "./client";

import type { Buffer } from "node:buffer";

/**
 * GMI Cloud upload API. Media inputs (reference portraits, a TTS line for
 * MiniMax-H3, a voice sample for cloning) must be reachable by URL, so bytes go
 * up here first:
 *
 *   POST /upload-url { file_type }  -> { upload_url (presigned, ~15 min), public_url (stable) }
 *   PUT  upload_url  <raw bytes>    with the matching Content-Type
 */

// The presigned URL signs the Content-Type, so it must match what GMI signed:
// the standard MIME types, except that "jpg" is signed as the literal
// image/jpg (image/jpeg is a 403 SignatureDoesNotMatch). Probed against the
// live upload-url endpoint on 2026-09-06 for every type below.
const CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpg",
  jpeg: "image/jpeg",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
} as const;

export type GmiUploadFileType = keyof typeof CONTENT_TYPES;

interface UploadUrlResponse {
  upload_url: string;
  public_url: string;
}

// The same portrait is referenced by every clip of a show; upload it once per process.
const uploadCache = new Map<string, string>();

export function fileTypeFromPath(filePath: string): GmiUploadFileType {
  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  if (ext in CONTENT_TYPES) {
    return ext as GmiUploadFileType;
  }
  throw new Error(`Cannot upload ${filePath} to GMI Cloud: unsupported file type "${ext}" (accepted: ${Object.keys(CONTENT_TYPES).join(", ")})`);
}

export async function uploadToGmi(bytes: Buffer, fileType: GmiUploadFileType): Promise<string> {
  if (bytes.length === 0) {
    throw new Error("Refusing to upload an empty file to GMI Cloud");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const cached = uploadCache.get(digest);
  if (cached) {
    return cached;
  }

  const { upload_url, public_url } = await gmiFetchJson<UploadUrlResponse>("/upload-url", {
    method: "POST",
    body: JSON.stringify({ file_type: fileType }),
  });
  if (!upload_url || !public_url) {
    throw new Error("GMI Cloud upload-url returned no upload_url/public_url pair");
  }

  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": CONTENT_TYPES[fileType] },
    // A fresh copy: fetch wants an ArrayBuffer-backed body, not Node's pooled Buffer slab.
    body: new Uint8Array(bytes).buffer,
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!put.ok) {
    throw new Error(`GMI Cloud upload failed with status ${put.status}: ${(await put.text()).slice(0, 300)}`);
  }

  uploadCache.set(digest, public_url);
  return public_url;
}

export async function uploadFileToGmi(filePath: string): Promise<string> {
  return uploadToGmi(fs.readFileSync(filePath), fileTypeFromPath(filePath));
}

/** Test seam. */
export function _resetUploadCache(): void {
  uploadCache.clear();
}
