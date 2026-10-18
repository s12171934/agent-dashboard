#!/bin/sh
# Deploy frontend/ to Cloudflare Pages. Copies it to a temp dir with a build.json stamp (open tabs reload when it
# changes), then runs `wrangler pages deploy`. Needs `wrangler login` once.
#   scripts/deploy-frontend.sh
# Settings (environment variables):
#   PAGES_PROJECT  Pages project name (default: agent-dashboard)
#   PAGES_BRANCH   branch to deploy as (default: main = production; anything else is a preview)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${PAGES_PROJECT:-agent-dashboard}"
BRANCH="${PAGES_BRANCH:-main}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cp -R "$ROOT/frontend/." "$OUT/"
build="$(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$ROOT" diff --quiet HEAD -- frontend || build="$build-dirty"
printf '{"build": "%s-%s"}\n' "$build" "$(date +%Y%m%d%H%M%S)" > "$OUT/build.json"

npx wrangler pages project list 2>/dev/null | grep -q "│ $PROJECT " \
  || npx wrangler pages project create "$PROJECT" --production-branch main
npx wrangler pages deploy "$OUT" --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true
