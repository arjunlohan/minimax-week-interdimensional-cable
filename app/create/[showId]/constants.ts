/**
 * The pipeline contract shared with `workflows/generate-show.ts`.
 *
 * Video runs: research, script, voices, (frame-chain only when frame chaining
 * is on), generate-clips, music, stitch, upload.
 * Audio runs: research, script, voices, music, stitch, upload.
 */
export type GenerationStepId = "research" | "script" | "voices" | "frame-chain" | "generate-clips" | "music" | "stitch" | "upload";

/**
 * What each step actually runs on.
 *
 * The progress view used to show only a verb ("Researching topic"), which hid
 * the entire model stack doing the work. Naming the model and the service per
 * step makes the pipeline legible while it executes, and every entry here is
 * the engine that genuinely runs that step in `workflows/generate-show.ts`.
 */
export interface StepEngine {
  /** Model or service performing the work. */
  model: string;
  /** Brand mark shown beside the service name, when the step runs on GMI Cloud. */
  icon?: string;
  /** Short service name shown beside the icon. */
  service: string;
}

const MINIMAX_ICON = "/brand/minimax.svg";
const GMI_CLOUD = "GMI Cloud";

function gmi(model: string): StepEngine {
  return { model, icon: MINIMAX_ICON, service: GMI_CLOUD };
}

export interface GenerationStep {
  id: GenerationStepId;
  label: string;
  engine: StepEngine;
}

export const GENERATION_STEPS: GenerationStep[] = [
  {
    id: "research",
    label: "Researching topic",
    engine: gmi("MiniMax-M3 · grounded research"),
  },
  {
    id: "script",
    label: "Writing the script",
    engine: gmi("MiniMax-M3 · three-pass writers' room"),
  },
  {
    id: "voices",
    label: "Recording the hosts",
    engine: gmi("Speech 2.8 HD · one voice per line"),
  },
  {
    id: "frame-chain",
    label: "Chaining boundary frames",
    engine: gmi("MiniMax-H3 · boundary frame"),
  },
  {
    id: "generate-clips",
    label: "Generating video clips",
    engine: gmi("MiniMax-H3 · reference-to-video"),
  },
  {
    id: "music",
    label: "Scoring theme and credits",
    engine: gmi("Music 3.0 · theme and credits"),
  },
  {
    id: "stitch",
    label: "Stitching the episode",
    engine: { model: "FFmpeg · title card, clips, credits", service: "Local" },
  },
  {
    id: "upload",
    label: "Uploading to Mux",
    engine: { model: "Direct upload · HLS", service: "Mux" },
  },
];

/** Audio episodes never render video, so the clip wording would be misleading. */
const AUDIO_STEP_LABELS: Partial<Record<GenerationStepId, string>> = {
  voices: "Recording the episode",
  stitch: "Assembling the episode",
};

/** The audio path voices whole turns and stitches audio where video stitches clips. */
const AUDIO_STEP_ENGINES: Partial<Record<GenerationStepId, StepEngine>> = {
  voices: gmi("Speech 2.8 HD · full episode per turn"),
  stitch: { model: "FFmpeg · theme, episode, credits", service: "Local" },
};

/** Steps that only exist on the video path. */
const VIDEO_ONLY_STEPS: ReadonlySet<GenerationStepId> = new Set(["frame-chain", "generate-clips"]);

export interface GenerationStepsOptions {
  /** Video only: whether the frame-chain step runs before generate-clips. */
  useFrameChaining?: boolean;
}

/**
 * The steps that actually run for a show, in order. Steps that never run for
 * the format (or for this show's settings) are dropped rather than shown as
 * forever pending.
 */
export function generationSteps(isAudio: boolean, options: GenerationStepsOptions = {}): GenerationStep[] {
  if (isAudio) {
    return GENERATION_STEPS
      .filter(s => !VIDEO_ONLY_STEPS.has(s.id))
      .map(s => ({
        ...s,
        label: AUDIO_STEP_LABELS[s.id] ?? s.label,
        engine: AUDIO_STEP_ENGINES[s.id] ?? s.engine,
      }));
  }
  return GENERATION_STEPS.filter(s => s.id !== "frame-chain" || options.useFrameChaining === true);
}

export const POLL_INTERVAL = 2000;
