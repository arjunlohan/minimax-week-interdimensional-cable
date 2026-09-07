export type ShowFormat = "video" | "audio";

/**
 * MiniMax-H3 is the only paid model in the pipeline: one request per clip.
 * Text, speech and music calls ride on the same GMI Cloud key at no per-call
 * charge, so a video estimate is simply clips × this figure.
 */
export const H3_COST_PER_REQUEST_USD = 0.13;

export interface DurationOption {
  value: number;
  label: string;
  description: string;
  /** Video only: MiniMax-H3 requests this duration needs, one per clip. */
  clips?: number;
  /** The option to land on first; the showcase setting for that format. */
  recommended?: boolean;
}

export const FORMAT_OPTIONS = [
  {
    value: "video",
    label: "Video episode · MiniMax-H3",
    description: "Every line becomes a 4 to 15 s clip anchored to the host portrait. Speech 2.8 HD voices each line, Music 3.0 scores the theme and credits.",
  },
  {
    value: "audio",
    label: "Audio episode · Speech 2.8 HD",
    description: "The hosts perform the whole episode one line at a time, with emotion. Music 3.0 adds the theme and a sung end-credits recap. No video spend.",
  },
] as const satisfies readonly { value: ShowFormat; label: string; description: string }[];

export const VIDEO_DURATION_OPTIONS = [
  { value: 30, label: "30 s", description: "about 3 clips", clips: 3 },
  { value: 60, label: "60 s", description: "about 6 clips", clips: 6 },
  { value: 90, label: "90 s", description: "about 9 clips", clips: 9, recommended: true },
  { value: 120, label: "120 s", description: "about 12 clips", clips: 12 },
] as const satisfies readonly DurationOption[];

export const AUDIO_PODCAST_DURATION_OPTIONS = [
  { value: 60, label: "1 min", description: "Quick Brief" },
  { value: 120, label: "2 min", description: "Short Episode" },
  { value: 180, label: "3 min", description: "Standard Podcast", recommended: true },
  { value: 240, label: "4 min", description: "Deep Discussion" },
  { value: 300, label: "5 min (Max)", description: "Full Podcast" },
] as const satisfies readonly DurationOption[];

export const DEFAULT_FORMAT: ShowFormat = "video";

export function durationOptionsFor(format: ShowFormat): readonly DurationOption[] {
  return format === "audio" ? AUDIO_PODCAST_DURATION_OPTIONS : VIDEO_DURATION_OPTIONS;
}

export function defaultDurationFor(format: ShowFormat): number {
  const options = durationOptionsFor(format);
  return (options.find(o => o.recommended) ?? options[0]).value;
}

export function isValidDuration(format: ShowFormat, seconds: number): boolean {
  return durationOptionsFor(format).some(o => o.value === seconds);
}

/**
 * "about $1.20". Rounded to the nearest ten cents because the clip count is
 * itself an estimate: the script decides how many lines the episode has.
 */
export function estimatedH3CostUsd(clips: number): string {
  const rounded = Math.round(clips * H3_COST_PER_REQUEST_USD * 10) / 10;
  return `about $${rounded.toFixed(2)}`;
}

export const FAMILIARITY_OPTIONS = [
  { value: "beginner", label: "New to this", description: "Explain like I'm hearing about this for the first time" },
  { value: "familiar", label: "Familiar", description: "I know the basics, give me the interesting details" },
  { value: "expert", label: "Expert", description: "I follow this closely, give me the deep cuts" },
] as const;

export const TOPIC_TYPES = {
  freetext: "freetext",
  news_link: "news_link",
  hacker_news: "hacker_news",
} as const;
