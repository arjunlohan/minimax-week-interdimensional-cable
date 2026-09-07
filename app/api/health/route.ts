/* eslint-disable node/no-process-env */
import { NextResponse } from "next/server";
import { Pool } from "pg";

/**
 * Deployment self-check. Reports which required variables are absent and
 * whether the database answers and carries the migrations, by name only, so a
 * 500 on the create or library page can be diagnosed from the outside without
 * reading server logs. Nothing here imports app/lib/env.ts, which throws at
 * load when the configuration is incomplete.
 */

export const dynamic = "force-dynamic";

const REQUIRED = ["DATABASE_URL", "MUX_TOKEN_ID", "MUX_TOKEN_SECRET"] as const;
const OPTIONAL = ["GMI_CLOUD_APIKEY", "KEY_ENCRYPTION_SECRET", "REQUIRE_USER_API_KEYS", "NEXT_PUBLIC_BASE_URL"] as const;

async function checkDatabase(url: string | undefined): Promise<{ ok: boolean; detail: string; tables?: string[] }> {
  if (!url) {
    return { ok: false, detail: "DATABASE_URL is not set" };
  }
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000, max: 1 });
  try {
    const result = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('generated_shows', 'show_templates', 'gmi_spend', 'video_chunks') order by 1",
    );
    const tables = result.rows.map(r => r.table_name);
    const missing = ["generated_shows", "gmi_spend", "show_templates"].filter(t => !tables.includes(t));
    if (missing.length > 0) {
      return { ok: false, detail: `connected, but migrations have not been applied (missing ${missing.join(", ")}); run npm run db:migrate against this database`, tables };
    }
    return { ok: true, detail: "connected, migrations present", tables };
  } catch (err) {
    return { ok: false, detail: `connection failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function GET() {
  const missing = REQUIRED.filter(name => !process.env[name]?.trim());
  const optionalPresent = OPTIONAL.filter(name => Boolean(process.env[name]?.trim()));
  const database = await checkDatabase(process.env.DATABASE_URL);
  const ok = missing.length === 0 && database.ok;

  // Names only, never values: enough to see whether the variables landed on
  // this deployment under the expected names and environment.
  const configuredNames = Object.keys(process.env)
    .filter(name => /URL|MUX|GMI|KEY|SECRET|POSTGRES|PGHOST|PGUSER|PGDATABASE|H3_/i.test(name) && !/^(npm_|NEXT_|__)/.test(name))
    .sort();
  const deployment = {
    environment: process.env.VERCEL_ENV ?? "local",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    url: process.env.VERCEL_URL ?? null,
    region: process.env.VERCEL_REGION ?? null,
  };

  return NextResponse.json(
    {
      ok,
      deployment,
      missingRequiredEnv: missing,
      optionalEnvPresent: optionalPresent,
      configuredNames,
      database,
      hint: ok ? undefined : "See DOCS/deploy.md: add the variables in Vercel Project Settings and point DATABASE_URL at a migrated Postgres.",
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
