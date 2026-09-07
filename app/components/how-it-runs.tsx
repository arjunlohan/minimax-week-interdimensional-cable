/**
 * The production pipeline, made visible.
 *
 * Every stage listed here maps to a real `"use step"` boundary in
 * `workflows/generate-show.ts`. Engines named here are the ones that actually
 * execute: no aspirational services, because the architecture claims on this
 * page are checkable against the repo.
 */

interface Engine {
  label: string;
  icon?: string;
  /** True for a MiniMax model served through GMI Cloud, the judged surface. */
  minimax: boolean;
}

const MINIMAX_ICON = "/brand/minimax.svg";

const GMI: Engine = { label: "MiniMax · GMI Cloud", icon: MINIMAX_ICON, minimax: true };
const FFMPEG: Engine = { label: "FFmpeg", minimax: false };
const MUX: Engine = { label: "Mux", minimax: false };
const POSTGRES: Engine = { label: "Postgres · Vercel Workflows", minimax: false };

interface Stage {
  id: string;
  title: string;
  model: string;
  engine: Engine;
  detail: string;
}

const STAGES: Stage[] = [
  {
    id: "preflight",
    title: "Capacity preflight",
    model: "Mux Video API",
    engine: MUX,
    detail:
      "Checks there is somewhere to store the result before anything is generated. A full library stops the run here rather than after the render bill.",
  },
  {
    id: "research",
    title: "Grounded research",
    model: "MiniMax-M3 · 1M context · fetched sources",
    engine: GMI,
    detail:
      "Fetches the pasted article or searches Hacker News for the topic, then M3 reads the sources and returns cited facts and premise angles. A page that cannot be read fails the run instead of being invented.",
  },
  {
    id: "script",
    title: "Three-pass writers' room",
    model: "MiniMax-M3 · research, head writer, voice and prune",
    engine: GMI,
    detail:
      "A head writer drafts structure and jokes in 8 to 12 second beats sized for the video model, then a voice pass rewrites in the host's cadence and prunes to the exact runtime.",
  },
  {
    id: "voice",
    title: "Voices",
    model: "Speech 2.8 HD · one voice per line",
    engine: GMI,
    detail:
      "Every line is synthesized on its own with the emotion the script's acting direction asks for. Each host keeps one fixed voice, stored on the show, so retries keep the same cast.",
  },
  {
    id: "video",
    title: "Video",
    model: "MiniMax-H3 · reference-to-video",
    engine: GMI,
    detail:
      "Each clip carries the host's portrait as a reference image and that line's Speech 2.8 audio as reference audio, so the host looks the same and performs the exact line across clips. A spend guard refuses past the caps rather than degrading the show.",
  },
  {
    id: "score",
    title: "Score",
    model: "Music 3.0 · theme hook and sung credits",
    engine: GMI,
    detail:
      "M3 writes a theme hook in the show's voice and an end-credits song built from the episode's three best jokes. Music 3.0 renders both for this episode.",
  },
  {
    id: "stitch",
    title: "Assembly",
    model: "FFmpeg · title card, clips, end card",
    engine: FFMPEG,
    detail:
      "Joins the clips, mixes the theme under a title card and the credits under an end card, and re-encodes to 48 kHz AAC when streams do not match.",
  },
  {
    id: "publish",
    title: "Publish",
    model: "Mux direct upload · HLS",
    engine: MUX,
    detail:
      "Uploads the master and returns an adaptive-bitrate playback ID. A failed upload keeps the rendered file, so a retry costs nothing.",
  },
];

/**
 * The GMI Cloud wordmark, painted in the current text colour.
 *
 * The SVG fills with `currentColor`, which an <img> cannot inherit, so the
 * file is applied as a mask over a currentColor background instead. That way
 * one asset reads black on the page and white in the footer.
 */
export function GmiCloudWordmark({ className = "h-5 w-[62px]" }: { className?: string }) {
  const mask = "url(/brand/gmi-cloud.svg)";
  return (
    <span
      role="img"
      aria-label="GMI Cloud"
      className={`inline-block shrink-0 ${className}`}
      style={{
        backgroundColor: "currentColor",
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

function EngineChip({ engine }: { engine: Engine }) {
  return (
    <span
      className="badge inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap md:justify-self-end"
      style={{
        fontFamily: "var(--font-space-mono)",
        background: engine.minimax ? "var(--surface)" : "var(--surface-elevated)",
      }}
    >
      {engine.icon ?
          (
            <img src={engine.icon} alt="" aria-hidden="true" className="h-4 w-4" />
          ) :
        null}
      {engine.label}
    </span>
  );
}

export function HowItRuns() {
  return (
    <section>
      <div
        className="section-header-brutal stripes-dark text-white"
        style={{ fontFamily: "var(--font-syne)" }}
      >
        WHAT RUNS WHEN YOU PRESS GENERATE
      </div>

      <p className="mt-6 max-w-3xl text-base leading-relaxed text-foreground-muted">
        Each stage below is a checkpointed step in a durable workflow. If one fails,
        the run resumes from the last completed step instead of starting over, and
        every intermediate result is written to Postgres as it lands. The four
        MiniMax models are served through GMI Cloud; everything else is named.
      </p>

      <ol className="mt-6 space-y-3">
        {STAGES.map((stage, i) => (
          <li key={stage.id} className="card-brutal">
            <div className="grid gap-3 p-5 md:grid-cols-[auto_1fr_auto] md:items-start md:gap-5">
              <span
                className="text-2xl font-extrabold leading-none text-accent md:pt-1"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>

              <div className="min-w-0">
                <h3
                  className="text-lg font-extrabold"
                  style={{ fontFamily: "var(--font-syne)" }}
                >
                  {stage.title}
                </h3>
                <p
                  className="mt-0.5 text-xs font-bold uppercase tracking-[0.15em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  {stage.model}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                  {stage.detail}
                </p>
              </div>

              <EngineChip engine={stage.engine} />
            </div>
          </li>
        ))}
      </ol>

      {/*
        State layer sits under every stage rather than beside them, so it is
        marked dashed. `border-dashed` alone loses to `.card-brutal`'s
        `border: 3px solid` shorthand, hence the inline style.
      */}
      <div className="card-brutal mt-3" style={{ borderStyle: "dashed" }}>
        <div className="grid gap-3 p-5 md:grid-cols-[auto_1fr_auto] md:items-start md:gap-5">
          <span
            className="text-2xl font-extrabold leading-none text-foreground-muted md:pt-1"
            style={{ fontFamily: "var(--font-space-mono)" }}
          >
            ↻
          </span>
          <div className="min-w-0">
            <h3 className="text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
              Throughout · state and durability
            </h3>
            <p
              className="mt-0.5 text-xs font-bold uppercase tracking-[0.15em] text-foreground-muted"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Postgres · Drizzle · Vercel Workflow DevKit
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
              Every stage is a checkpointed Vercel Workflow step. Show rows, transcripts,
              chat, memory and the MiniMax-H3 spend ledger land in Postgres, and
              transcript search runs on Postgres full-text search, so retrieval happens
              in the same query as the show metadata.
            </p>
          </div>
          <EngineChip engine={POSTGRES} />
        </div>
      </div>
    </section>
  );
}

interface Criterion {
  criterion: string;
  claim: string;
  detail: string;
  evidence: string;
}

const CRITERIA: Criterion[] = [
  {
    criterion: "Model usage",
    claim: "Four MiniMax models in one durable pipeline",
    detail:
      "MiniMax-M3 researches and writes, Speech 2.8 HD performs every line with a directed emotion, MiniMax-H3 renders each clip anchored to the host's portrait and that line's audio, and Music 3.0 scores the theme and the credits. All four are served through GMI Cloud.",
    evidence: "app/lib/gmi/ · workflows/generate-show.ts",
  },
  {
    criterion: "Usability",
    claim: "Pick a format, give it a topic, watch it render",
    detail:
      "No prompt engineering. The progress view shows live engine chips that name the model and the service running each step as it executes, and a failed step says why in plain language instead of substituting canned content.",
    evidence: "app/create/ · app/watch/[showId]/",
  },
  {
    criterion: "Originality",
    claim: "The show scores itself and sings its own credits",
    detail:
      "M3 writes a theme hook in the show's voice and an end-credits song that sings the episode's three best jokes; Music 3.0 renders both per episode. Between episodes the host answers questions in character, in its own voice.",
    evidence: "app/lib/gmi/music.ts · workflows/generate-show.ts",
  },
];

export function BuiltForMiniMaxWeek() {
  return (
    <section>
      <div
        className="section-header-brutal stripes-accent text-foreground"
        style={{ fontFamily: "var(--font-syne)" }}
      >
        BUILT FOR MINIMAX WEEK
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <img src={MINIMAX_ICON} alt="" aria-hidden="true" className="h-6 w-6" />
          <span className="text-sm font-bold" style={{ fontFamily: "var(--font-space-mono)" }}>
            MiniMax Week
          </span>
        </span>
        <span className="text-sm font-bold text-foreground-muted" style={{ fontFamily: "var(--font-space-mono)" }}>
          ×
        </span>
        <GmiCloudWordmark className="h-5 w-[62px]" />
        <span
          className="text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
          style={{ fontFamily: "var(--font-space-mono)" }}
        >
          Track · Synthesis · agents that direct
        </span>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {CRITERIA.map(row => (
          <div key={row.criterion} className="card-brutal flex flex-col gap-2 p-5">
            <p
              className="text-xs font-bold uppercase tracking-[0.2em] text-accent"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {row.criterion}
            </p>
            <h3
              className="text-base font-extrabold"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              {row.claim}
            </h3>
            <p className="text-sm leading-relaxed text-foreground-muted">
              {row.detail}
            </p>
            <code
              className="mt-auto pt-1 text-xs text-foreground-muted"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {row.evidence}
            </code>
          </div>
        ))}
      </div>

      <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
        Core generation runs on MiniMax models served through GMI Cloud. The supporting
        infrastructure is named rather than hidden:
        {" "}
        <strong className="text-foreground">Mux</strong>
        {" "}
        hosts and streams the episode,
        {" "}
        <strong className="text-foreground">FFmpeg</strong>
        {" "}
        assembles it,
        {" "}
        <strong className="text-foreground">Postgres</strong>
        {" "}
        holds the state, and
        {" "}
        <strong className="text-foreground">Vercel Workflows</strong>
        {" "}
        makes every step durable.
      </p>
    </section>
  );
}
