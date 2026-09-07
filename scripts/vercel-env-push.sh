#!/usr/bin/env bash
# Push the deployment secrets to the linked Vercel project's Production
# environment straight from .env.local, so no value is ever typed, pasted or
# printed. Requires `vercel login` and `vercel link` once.
#
#   npm run vercel:env-push              # push, then rebuild production
#   npm run vercel:env-push -- --dry-run # only report which names have values
#
# Source names in .env.local:
#   MUX_TOKEN_ID, MUX_TOKEN_SECRET, GMI_CLOUD_APIKEY   pushed under the same name
#   VERCEL_DATABASE_URL                                pushed as DATABASE_URL
#   VERCEL_PRODUCTION_URL                              the deployment to rebuild
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found; run this from the repository root." >&2
  exit 1
fi

value_of() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  # strip one pair of surrounding quotes
  case "$line" in
    \"*\") line=${line#\"}; line=${line%\"} ;;
    \'*\') line=${line#\'}; line=${line%\'} ;;
  esac
  printf '%s' "$line"
}

push() {
  local target=$1 source=$2 value
  value=$(value_of "$source")
  if [ -z "$value" ]; then
    echo "skip  $target: $source is empty in $ENV_FILE"
    return
  fi
  echo "push  $target: ${#value} characters from $source"
  if [ "$DRY_RUN" = 1 ]; then
    return
  fi
  printf '%s' "$value" | vercel env add "$target" production --force >/dev/null
}

push MUX_TOKEN_ID MUX_TOKEN_ID
push MUX_TOKEN_SECRET MUX_TOKEN_SECRET
push GMI_CLOUD_APIKEY GMI_CLOUD_APIKEY
push DATABASE_URL VERCEL_DATABASE_URL

production_url=$(value_of VERCEL_PRODUCTION_URL)
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: nothing pushed. Rebuild target: ${production_url:-<set VERCEL_PRODUCTION_URL>}"
  exit 0
fi
if [ -z "$production_url" ]; then
  echo "Values pushed. Set VERCEL_PRODUCTION_URL in $ENV_FILE, or rebuild with: vercel redeploy <deployment url>"
  exit 0
fi
echo "Rebuilding $production_url with the new values..."
vercel redeploy "$production_url"
echo "Check: curl -s $production_url/api/health"
