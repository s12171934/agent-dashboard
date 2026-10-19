#!/bin/sh
# Deploy frontend/ to Cloudflare Pages. Copies it, with design-system/ under ds/, to a temp dir with a build.json
# stamp (open tabs reload when it changes), then runs `wrangler pages deploy`. Needs `wrangler login` once.
#   scripts/deploy-frontend.sh
# Settings (environment variables):
#   PAGES_PROJECT  Pages project name (default: agent-dashboard)
#   PAGES_BRANCH   branch to deploy as (default: main = production; anything else is a preview)
#   DEPLOY_OUT     write the prepared files to this (new) folder and stop, without deploying (to check them)
# Every page file the page loads by a fixed name (index.html's scripts and styles, ds.css's @imports, ds.js's imports,
# the icon sprite) gets ?v=<build> in the copy: the custom domain's Cloudflare zone hands them out with a 4-hour
# browser cache whatever _headers says, and a fresh index.html with a day-old app.js or icons.svg drew a broken page.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${PAGES_PROJECT:-agent-dashboard}"
BRANCH="${PAGES_BRANCH:-main}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cp -R "$ROOT/frontend/." "$OUT/"
mkdir "$OUT/ds" && cp -R "$ROOT/design-system/." "$OUT/ds/"
build="$(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$ROOT" diff --quiet HEAD -- frontend design-system || build="$build-dirty"
ver="$build-$(date +%Y%m%d%H%M%S)"
printf '{"build": "%s"}\n' "$ver" > "$OUT/build.json"

V="$ver" perl -pi -e 's{\b((?:src|href)=")((?![a-z]+:|/|#)[^"?]+\.(?:js|css))"}{$1$2?v=$ENV{V}"}g' "$OUT/index.html"
find "$OUT" -name '*.css' -exec env V="$ver" perl -pi -e 's{(\@import\s+")([^"?]+\.css)"}{$1$2?v=$ENV{V}"}g' {} +
find "$OUT/ds" -name '*.js' -exec env V="$ver" perl -pi -e \
  's{((?:\bimport\s+|\bfrom\s+|new URL\()\x27)(\.{1,2}/[^\x27?]+\.(?:js|css|svg))\x27}{$1$2?v=$ENV{V}\x27}g' {} +
if [ -n "${DEPLOY_OUT:-}" ]; then
  cp -R "$OUT" "$DEPLOY_OUT"
  echo "prepared $ver in $DEPLOY_OUT (not deployed)"
  exit 0
fi

npx wrangler pages project list 2>/dev/null | grep -q "│ $PROJECT " \
  || npx wrangler pages project create "$PROJECT" --production-branch main
npx wrangler pages deploy "$OUT" --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true
