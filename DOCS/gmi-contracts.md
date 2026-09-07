# GMI Cloud contracts, as observed

Documented shapes (docs.gmicloud.ai, read 2026-09-06) come first; every smoke run appends what the platform actually returned. Trust the observations over the documentation when they differ.

## Documented

| Surface            | Endpoint                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax-M3         | `POST https://api.gmi-serving.com/v1/chat/completions` (OpenAI-compatible), model `MiniMaxAI/MiniMax-M3`                   | Driven by `@ai-sdk/gmicloud`. `response_format: {type: "json_object"}` and `tools` documented. Reasoning may come as `reasoning_content`. Free during MiniMax Week.                                                                                                                                        |
| Request queue      | `POST https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests` with `{model, payload}`; `GET .../requests/{id}` | Statuses: created, queued, dispatched, processing, success, failed, cancelled. Results in `outcome`.                                                                                                                                                                                                       |
| Upload             | `POST .../requestqueue/apikey/upload-url` with `{file_type}` then `PUT` bytes to `upload_url`                              | Returns `public_url` (stable). Types: jpeg, jpg, png, mp4, mp3, wav.                                                                                                                                                                                                                                       |
| MiniMax-H3         | model `MiniMax-H3`                                                                                                         | `prompt` (<= 7000), `resolution` 768P or 2K, `duration` 4..15, `ratio`, `first_frame_image`, `last_frame_image`, `reference_images` (<= 9), `reference_videos` (<= 3), `reference_audios` (<= 3). Frames and references cannot mix. `outcome.video_url`, `outcome.thumbnail_image_url`. $0.13 per request. |
| Speech 2.8 HD      | model `minimax-tts-speech-2.8-hd`                                                                                          | Sync. `text`, `voice_id`, `speed`, `vol`, `pitch`, `emotion`, `language_boost`, `format` mp3 or flac, `audio_sample_rate`, `bitrate`, `channel`. `outcome.media_urls[]`. Free during the week.                                                                                                             |
| Voice clone 2.8 HD | model `minimax-audio-voice-clone-speech-2.8-hd`                                                                            | Sync, one shot: `text` + `source_audio` (URL), optional `voice_id`, `prompt_audio` + `prompt_text`.                                                                                                                                                                                                        |
| Music 3.0          | model `minimax-music-3.0`                                                                                                  | Sync, 30 to 60 s. `lyrics` (1..3500, structure tags), `prompt` (<= 2000), `sample_rate`, `bitrate`, `format`. `outcome.audio_url`, `duration_ms`. Free during the week.                                                                                                                                    |
| Rate limits        |                                                                                                                            | LLM: 1M tokens per minute at Tier 1. Video: requests per hour at the org level, number undocumented.                                                                                                                                                                                                       |

## Audio strategy

To be settled by `npm run gmi:smoke -- --video`: whether GMI's H3 output carries audio, and whether a Speech 2.8 line attached as `reference_audios` is performed by the character. Until then `H3_AUDIO_STRATEGY` defaults to `reference`, and any silent clip gets the line overlaid.

## Observations

## Smoke run 2026-09-07T03:16:51.345Z

- Music 3.0 (theme hook): ok in 67.2 s
  music: 1594399 bytes, 49763 ms, /var/folders/dj/tq15mfnn4hb406dsp0m80ts40000gn/T/interdimensional-cable/music-1788751078495-cp592.mp3
  probe: {"duration":49.76,"audio":true}

### Upload API (observed 2026-09-06)

- `POST /upload-url {file_type}` returns a V4 presigned `upload_url` on GMI's storage bucket (expires in 899 s, signed headers: content-type and host) and a stable `public_url` on storage.googleapis.com.
- The signed Content-Type must match exactly: `png` image/png, `jpg` the literal image/jpg (image/jpeg is a 403 SignatureDoesNotMatch), `jpeg` image/jpeg, `mp3` audio/mpeg (audio/mp3 is a 403), `wav` audio/wav, `mp4` video/mp4. Omitting Content-Type is a 400 MalformedSecurityHeader.
- Results and inputs are served from the same bucket; result URLs have been stable across the session.

### Speech 2.8 HD (observed)

- Synchronous from the client's point of view but queued server-side: 22 s to 144 s for a 6 s line. `outcome.duration_ms` is populated. mp3 at 44.1 kHz, ~16 KB per second.

### Music 3.0 (observed)

- A 151-character hook produced a 49.8 s song (1.6 MB mp3) in about 45 s of generation. The model reports RPM rate limits as a terminal `failed` record with `outcome.error = "Music generation failed: rate limit exceeded(RPM)"`; the queue resubmits after 20 s and succeeds.

### MiniMax-M3 (observed)

- Plain text in 5.6 s, JSON in 4.8 s for short prompts through `@ai-sdk/gmicloud`. No `<think>` text leaked into `result.text`.

### MiniMax-H3 (observed 2026-09-06, before credits)
- With uploads working (portrait as image/jpg, line as audio/mpeg), the submission returned HTTP 402 `{"error": "Insufficient credits. Please add more credits to your account."}`. H3 is pay-as-you-go even during MiniMax Week; the free models kept working. The audio-strategy comparison is deferred until the account carries credits.
