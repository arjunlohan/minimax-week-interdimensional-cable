/**
 * What produced this specific episode.
 *
 * Deliberately driven by the show's own record rather than a static list: the
 * counts below are read off the stored research brief and transcript, so the
 * panel cannot claim work that did not happen. A show generated without
 * grounding shows no grounded sources, and a show without a score shows no
 * Music 3.0 row.
 */

interface ProvenanceFact {
  sourceUrl?: string;
  sourceTitle?: string;
}

interface ProvenanceBrief {
  groundedFacts?: ProvenanceFact[];
  searchMetadata?: { searchQueriesUsed?: string[] };
}

interface ProvenancePanelProps {
  researchContext: string | null;
  segmentCount: number;
  durationSeconds: number;
  isAudio: boolean;
  hasMux: boolean;
  language: string;
  /** Music 3.0 was asked for a theme under the title card. */
  hasTheme?: boolean;
  /** Music 3.0 was asked for a sung end-credits recap. */
  hasCredits?: boolean;
}

const MINIMAX_ICON = "/brand/minimax.svg";

function parseBrief(raw: string | null): ProvenanceBrief | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as ProvenanceBrief;
  } catch {
    return null;
  }
}

interface Row {
  stage: string;
  engine: string;
  icon?: string;
  service: string;
  detail: string;
}

export function ProvenancePanel({
  researchContext,
  segmentCount,
  durationSeconds,
  isAudio,
  hasMux,
  language,
  hasTheme = false,
  hasCredits = false,
}: ProvenancePanelProps) {
  const brief = parseBrief(researchContext);
  const facts = brief?.groundedFacts ?? [];
  const sourced = facts.filter(f => f.sourceUrl).length;
  const queries = brief?.searchMetadata?.searchQueriesUsed ?? [];

  const scoreParts = [
    hasTheme ? "theme under the title card" : null,
    hasCredits ? "sung end-credits recap" : null,
  ].filter((part): part is string => part !== null);

  const rows: Row[] = [
    {
      stage: "Research",
      engine: "MiniMax-M3",
      icon: MINIMAX_ICON,
      service: "GMI Cloud",
      detail: facts.length > 0 ?
        `${facts.length} grounded fact${facts.length === 1 ? "" : "s"}${sourced > 0 ? `, ${sourced} with a cited source` : ""}${queries.length > 0 ? ` from ${queries.length} research quer${queries.length === 1 ? "y" : "ies"}` : ""}` :
        "No stored research brief for this episode",
    },
    {
      stage: "Script",
      engine: "MiniMax-M3",
      icon: MINIMAX_ICON,
      service: "GMI Cloud",
      detail: `${segmentCount} beat${segmentCount === 1 ? "" : "s"} across three passes: research, head writer, voice`,
    },
    isAudio ?
        {
          stage: "Voices",
          engine: "Speech 2.8 HD",
          icon: MINIMAX_ICON,
          service: "GMI Cloud",
          detail: `One request per line in each host's voice, ${durationSeconds}s, ${language.toUpperCase()}`,
        } :
        {
          stage: "Video",
          engine: "MiniMax-H3",
          icon: MINIMAX_ICON,
          service: "GMI Cloud",
          detail: `${segmentCount} clip${segmentCount === 1 ? "" : "s"} of 4 to 15 s, each voiced by Speech 2.8 HD, stitched with ffmpeg`,
        },
    ...(scoreParts.length > 0 ?
        [{
          stage: "Score",
          engine: "Music 3.0",
          icon: MINIMAX_ICON,
          service: "GMI Cloud",
          detail: scoreParts.join(" and "),
        }] :
        []),
    {
      stage: "State",
      engine: "PostgreSQL + full-text search",
      service: "Postgres",
      detail: "Transcript, memory, retrieval index and every step checkpoint",
    },
    {
      stage: "Delivery",
      engine: hasMux ? "Direct upload, HLS" : "Local render",
      service: "Mux",
      detail: hasMux ? "Adaptive bitrate streaming" : "Not yet uploaded",
    },
  ];

  return (
    <div className="card-flat p-4">
      <div
        className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-muted"
        style={{ fontFamily: "var(--font-space-mono)" }}
      >
        How this was made
      </div>
      <p className="mb-4 text-xs leading-relaxed text-foreground-muted">
        Every figure below is read from this episode&apos;s own record.
      </p>

      <div className="space-y-3">
        {rows.map(row => (
          <div key={row.stage} className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="text-xs font-bold uppercase tracking-[0.1em]"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                {row.stage}
                {" · "}
                {row.engine}
              </span>
              <span className="text-[11px] leading-tight text-foreground-muted">
                {row.detail}
              </span>
            </div>

            <span
              className="inline-flex shrink-0 items-center gap-1.5 border-2 border-border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{ fontFamily: "var(--font-space-mono)", background: "var(--surface-elevated)" }}
            >
              {row.icon ?
                  (
                    // eslint-disable-next-line next/no-img-element
                    <img src={row.icon} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
                  ) :
                null}
              {row.service}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
