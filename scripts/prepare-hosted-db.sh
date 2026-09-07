#!/usr/bin/env bash
# Prepares a hosted Postgres for the deployment.
#
#   scripts/prepare-hosted-db.sh "postgresql://user:password@host/db?sslmode=require"
#       fresh database: applies the migrations and seeds the show templates
#
#   scripts/prepare-hosted-db.sh "postgresql://..." --copy-local
#       empty database: copies the local library (episodes, transcripts, memory)
#       from interdimensional_cable_minimax on 127.0.0.1:5432, schema included
#
# The URL is the DATABASE_URL your Postgres provider gave you (Neon, Supabase,
# any Postgres 14+). Nothing here reads .env.local.
set -euo pipefail

URL="${1:-}"
MODE="${2:-}"

if [[ -z "$URL" || "$URL" != postgres* ]]; then
  echo "usage: $0 'postgresql://user:password@host/db?sslmode=require' [--copy-local]" >&2
  echo "The first argument must be the real connection string, not a placeholder." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "Checking the connection..."
psql "$URL" -Atc "select version()" >/dev/null || { echo "Could not connect with that URL." >&2; exit 1; }

if [[ "$MODE" == "--copy-local" ]]; then
  existing="$(psql "$URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
  if [[ "$existing" != "0" ]]; then
    echo "The target already has $existing public tables; --copy-local needs an empty database (or run without the flag)." >&2
    exit 1
  fi
  echo "Copying the local library into the hosted database..."
  pg_dump --no-owner --no-acl -h 127.0.0.1 -p 5432 interdimensional_cable_minimax | psql "$URL" -q -v ON_ERROR_STOP=1
else
  echo "Applying migrations..."
  DATABASE_URL="$URL" npm run db:migrate
  echo "Seeding show templates..."
  DATABASE_URL="$URL" npm run seed-templates
fi

echo
echo "Ready. Tables:"
psql "$URL" -Atc "select table_name from information_schema.tables where table_schema = 'public' order by 1" | tr '\n' ' '
echo
echo "Now set DATABASE_URL to this URL in Vercel (Project Settings, Environment Variables) and redeploy."
