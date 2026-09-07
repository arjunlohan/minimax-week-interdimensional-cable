import { Header } from "@/app/components/header";
import { requiresUserApiKeys } from "@/app/lib/api-keys";
import { generationDispatch, workerPresence } from "@/app/lib/render-worker";

import { getTemplatesAction } from "./actions";
import { CreateForm } from "./create-form";

// Templates come from the database, so this page must not be prerendered at
// build time (a build has no database, and Vercel builds without secrets).
export const dynamic = "force-dynamic";

export default async function CreatePage() {
  const templates = await getTemplatesAction();
  // Rendering runs on a worker off the web host; say so when it is away
  // rather than letting a visitor queue an episode that will not start.
  const workerOffline = generationDispatch() === "queue" && !(await workerPresence()).online;

  return (
    <div className="flex min-h-screen flex-col">
      <Header currentPath="/create" />

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">
          {/* Page Header */}
          <div className="mb-10">
            <p
              className="mb-2 text-xs font-bold uppercase tracking-[0.3em] text-foreground-muted"
              style={{ fontFamily: "var(--font-space-mono)" }}
            >
              Interdimensional Cable
            </p>
            <h2
              className="text-4xl font-extrabold tracking-tight md:text-5xl"
              style={{ fontFamily: "var(--font-syne)" }}
            >
              Create a Show
            </h2>
          </div>

          {workerOffline && (
            <div className="mb-8 border-3 border-amber-600 bg-amber-50 p-4">
              <div
                className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-700"
                style={{ fontFamily: "var(--font-space-mono)" }}
              >
                Render worker offline
              </div>
              <p className="text-sm text-foreground-muted">
                Episodes render on a worker outside the web host, because one voice line can wait minutes in the model queue.
                It is not running right now: a show you create is saved and starts when it returns. The finished episodes still play.
              </p>
            </div>
          )}

          <CreateForm templates={templates} requiresApiKey={requiresUserApiKeys()} />
        </div>
      </main>
    </div>
  );
}
