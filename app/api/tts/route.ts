import { NextResponse } from "next/server";

import { recordMemorySignal } from "@/app/lib/memory-bank";
import { generateShowAudio } from "@/app/lib/tts";
import type { TtsHost } from "@/app/lib/tts";

interface TtsRequestBody {
  transcript: string;
  hosts: TtsHost[];
  /**
   * Per-turn breakdown of the transcript. MiniMax Speech 2.8 HD voices one
   * speaker per request, so a multi-host show is synthesized a turn at a time;
   * without segments the transcript is split on its "Speaker: line" labels.
   */
  segments?: Array<{ speaker: string; text: string }>;
  targetLang?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TtsRequestBody;

    if (!body.transcript || typeof body.transcript !== "string") {
      return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    }
    if (!Array.isArray(body.hosts) || body.hosts.length === 0) {
      return NextResponse.json({ error: "hosts array is required" }, { status: 400 });
    }

    const segments = (body.segments ?? []).filter(
      s => s && typeof s.speaker === "string" && typeof s.text === "string" && s.text.trim().length > 0,
    );

    const wav = await generateShowAudio(body.transcript, body.hosts, segments, body.targetLang);

    // Dubbing into a language is a clear preference signal, and the only place
    // the memory bank can learn it.
    if (body.targetLang && body.targetLang !== "en") {
      void recordMemorySignal("default_user", {
        memoryType: "custom_note",
        key: `language-${body.targetLang}`,
        value: `Dubs episodes into ${body.targetLang.toUpperCase()}`,
      });
    }

    return new Response(new Uint8Array(wav), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": wav.length.toString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TTS generation failed";
    console.error("[api/tts] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
