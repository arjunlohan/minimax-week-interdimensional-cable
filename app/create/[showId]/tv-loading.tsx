"use client";

interface TVLoadingProps {
  templateName: string;
  topic: string;
  status: string;
  isAudio?: boolean;
}

/** One line per `generated_shows.status`, naming the engine at work. */
const STATUS_MESSAGES: Record<string, string> = {
  pending: "Warming up...",
  researching: "MiniMax-M3 is researching the topic...",
  scripting: "MiniMax-M3 is writing the script...",
  voicing: "Speech 2.8 HD is recording the hosts...",
  generating: "MiniMax-H3 is generating the clips...",
  scoring: "Music 3.0 is scoring the theme and credits...",
  stitching: "FFmpeg is cutting the episode together...",
  uploading: "Uploading to Mux...",
  ready: "Your show is ready!",
  failed: "Something went wrong.",
};

/** Audio episodes have no clips: the hosts perform the whole thing. */
const AUDIO_STATUS_MESSAGES: Record<string, string> = {
  ...STATUS_MESSAGES,
  voicing: "Speech 2.8 HD is recording the episode...",
  stitching: "FFmpeg is assembling the episode...",
};

export function TVLoading({ templateName, topic, status, isAudio = false }: TVLoadingProps) {
  const message = (isAudio ? AUDIO_STATUS_MESSAGES : STATUS_MESSAGES)[status] ?? "Processing...";
  const isActive = !["ready", "failed"].includes(status);

  return (
    <div className="mx-auto max-w-2xl">
      {/* TV Frame */}
      <div className="border-3 border-border bg-background-dark shadow-[8px_8px_0_var(--border)]">
        {/* Screen */}
        <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-[#1a1a1a]">
          {/* Static noise effect */}
          {isActive && (
            <div
              className="absolute inset-0 opacity-10"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.5'/%3E%3C/svg%3E")`,
                backgroundSize: "256px 256px",
                animation: "static 0.3s steps(10) infinite",
              }}
            />
          )}

          {/* Content */}
          <div className="relative z-10 px-8 text-center">
            <div
              className="mb-4 text-xs font-bold uppercase tracking-[0.3em] text-foreground-light"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {templateName}
            </div>

            <div
              className={`mb-6 text-xl font-extrabold text-white md:text-2xl ${isActive ? "animate-pulse" : ""}`}
              style={{ fontFamily: "var(--font-syne)" }}
            >
              {message}
            </div>

            <div
              className="line-clamp-2 text-sm text-foreground-light"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {topic}
            </div>

            {/* Loading dots */}
            {isActive && (
              <div className="mt-6 flex items-center justify-center gap-2">
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    className="h-2 w-2 bg-accent"
                    style={{
                      animation: `blink 1.4s ${i * 0.2}s infinite`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* TV Bottom Bar */}
        <div className="flex items-center justify-between border-t-3 border-border bg-[#2d2d2d] px-4 py-2">
          <div
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-foreground-light"
            style={{ fontFamily: "var(--font-space-mono)" }}
          >
            Interdimensional Cable
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 ${isActive ? "animate-pulse bg-accent" : status === "ready" ? "bg-green-500" : "bg-red-500"}`} />
            <span
              className="text-[10px] font-bold uppercase tracking-[0.15em] text-foreground-light"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              {status}
            </span>
          </div>
        </div>
      </div>

      <style jsx>
        {`
        @keyframes static {
          0% { transform: translate(0, 0); }
          10% { transform: translate(-5%, -5%); }
          20% { transform: translate(5%, 5%); }
          30% { transform: translate(-5%, 5%); }
          40% { transform: translate(5%, -5%); }
          50% { transform: translate(-5%, 0); }
          60% { transform: translate(5%, 0); }
          70% { transform: translate(0, 5%); }
          80% { transform: translate(0, -5%); }
          90% { transform: translate(5%, 5%); }
          100% { transform: translate(0, 0); }
        }
        @keyframes blink {
          0%, 80%, 100% { opacity: 0.2; }
          40% { opacity: 1; }
        }
      `}
      </style>
    </div>
  );
}
