import Link from "next/link";

import { Footer } from "@/app/components/footer";
import { Header } from "@/app/components/header";
import { BuiltForMiniMaxWeek, GmiCloudWordmark, HowItRuns } from "@/app/components/how-it-runs";
import { listShowSkills } from "@/app/lib/skills/registry";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header currentPath="/" />

      <main className="flex-1 px-6 py-12 md:py-16">
        <div className="mx-auto max-w-6xl space-y-12">
          {/* Hero */}
          <section className="panel-brutal overflow-hidden">
            <div className="p-8 md:p-12">
              <div className="space-y-6">
                <p
                  className="text-xs font-bold uppercase tracking-[0.3em] text-foreground-muted"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  AI TALK SHOWS
                </p>

                <h1
                  className="text-4xl font-extrabold tracking-tight md:text-6xl"
                  style={{ fontFamily: "var(--font-syne)" }}
                >
                  Your topic.
                  <br />
                  Their personality.
                  <br />
                  <span className="text-accent">Your show.</span>
                </h1>

                <p className="max-w-2xl text-lg leading-relaxed text-foreground-muted md:text-xl">
                  Pick a late-night format: investigative desk, political dissection, dual-anchor news, variety monologue, apocalyptic report, venture panel, or long-form podcast.
                  Give it any topic. An agent researches it, writes it, casts the voices, renders the clips, scores the theme and sings the credits, unattended.
                </p>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Link href="/create" className="btn-action group inline-flex items-center justify-center">
                    Create a Show
                    <span className="arrow-icon ml-2">↗</span>
                  </Link>

                  <Link
                    href="/media"
                    className="btn-outlined inline-flex items-center justify-center"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Browse shows
                  </Link>
                </div>

                {/* Every service named here executes on the show path. */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t-[3px] border-border pt-6">
                  <span
                    className="text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                    style={{ fontFamily: "var(--font-space-mono)" }}
                  >
                    Running on
                  </span>
                  <span className="flex items-center gap-2">
                    <img src="/brand/minimax.svg" alt="" aria-hidden="true" className="h-6 w-6" />
                    <span className="text-sm font-bold" style={{ fontFamily: "var(--font-space-mono)" }}>
                      MiniMax-M3 · MiniMax-H3 · Speech 2.8 HD · Music 3.0
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className="text-xs font-bold uppercase tracking-[0.2em] text-foreground-muted"
                      style={{ fontFamily: "var(--font-space-mono)" }}
                    >
                      served through
                    </span>
                    <GmiCloudWordmark className="h-6 w-[74px]" />
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* How It Works */}
          <section>
            <div
              className="section-header-brutal stripes-dark text-white"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              HOW IT WORKS
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-3">
              <div className="card-brutal flex flex-col p-6">
                <div
                  className="mb-3 text-3xl font-extrabold text-accent"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  01
                </div>
                <h3 className="mb-2 text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
                  Pick a show
                </h3>
                <p className="text-sm leading-relaxed text-foreground-muted">
                  Choose a talk show format. Each has its own hosts, humor style and running order, and every host keeps one fixed voice.
                </p>
              </div>

              <div className="card-brutal flex flex-col p-6">
                <div
                  className="mb-3 text-3xl font-extrabold text-accent"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  02
                </div>
                <h3 className="mb-2 text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
                  Give it a topic
                </h3>
                <p className="text-sm leading-relaxed text-foreground-muted">
                  Paste a news link or a Hacker News story, or describe what the show should cover. MiniMax-M3 reads the sources and researches the topic before a joke is written.
                </p>
              </div>

              <div className="card-brutal flex flex-col p-6">
                <div
                  className="mb-3 text-3xl font-extrabold text-accent"
                  style={{ fontFamily: "var(--font-space-mono)" }}
                >
                  03
                </div>
                <h3 className="mb-2 text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
                  Watch your episode
                </h3>
                <p className="text-sm leading-relaxed text-foreground-muted">
                  The pipeline writes the script, performs every line, renders the clips, scores the theme, sings the credits and publishes a watchable episode. Every step is named while it runs.
                </p>
              </div>
            </div>
          </section>

          <HowItRuns />

          <BuiltForMiniMaxWeek />

          {/* Show Templates Preview */}
          <section>
            <div
              className="section-header-brutal stripes-accent text-foreground"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              AVAILABLE SHOWS
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-3">
              {listShowSkills().map(skill => ({
                name: skill.name,
                type: skill.showType === "conversation" ? "CONVERSATION" : "MONOLOGUE",
                image: skill.referenceImageUrl ?? "/templates/investigative-desk.jpg",
                description: skill.description ?? "",
              })).map(show => (
                <div key={show.name} className="card-brutal overflow-hidden">
                  <div className="relative h-32 overflow-hidden">
                    <img
                      src={show.image}
                      alt={show.name}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                    <span
                      className="absolute bottom-3 left-4 text-sm font-bold uppercase tracking-[0.2em] text-white"
                      style={{ fontFamily: "var(--font-space-mono)" }}
                    >
                      {show.name}
                    </span>
                  </div>
                  <div className="p-5">
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-lg font-extrabold" style={{ fontFamily: "var(--font-syne)" }}>
                        {show.name}
                      </h3>
                      <span className="badge badge-sync">{show.type}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-foreground-muted">
                      {show.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>

      <Footer variant="full" />
    </div>
  );
}
