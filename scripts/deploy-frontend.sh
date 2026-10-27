#!/bin/sh
# Deploy frontend/ to Cloudflare Pages. Copies it, with design-system/ under ds/, to a temp dir with a build.json
# stamp (open tabs reload when it changes), then runs `wrangler pages deploy`. Needs `wrangler login` once.
#   scripts/deploy-frontend.sh
# Settings (environment variables):
#   PAGES_PROJECT  Pages project name (default: agent-dashboard)
#   PAGES_BRANCH   branch to deploy as (default: main = production; anything else is a preview)
#   DEPLOY_OUT     write the prepared files to this (new) folder and stop, without deploying (to check them)
#   WRANGLER_VERSION  wrangler release npx runs (default: the pinned one below)
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

# the character pictures by content: app.js's CH_FILEV gets {file: hash} for frontend/chars, so a redrawn strip gets a
# new URL (the zone's 4-hour cache would hand out the old one) and an unchanged one keeps its cache
charv="$(cd "$ROOT/frontend/chars" && for f in *.webp *.png; do [ -f "$f" ] && printf '"%s":"%s",' "$f" "$(shasum "$f" | cut -c1-10)"; done)"
CV="{${charv%,}}" perl -pi -e 's{/\*\@chars-v\*/\{\}/\*\@\*/}{$ENV{CV}}' "$OUT/app.js"
grep -q '@chars-v' "$OUT/app.js" && { echo "app.js 의 CH_FILEV 를 채우지 못했습니다" >&2; exit 1; }
# the design system's own pages (preview, stories and the story canvas) too, with their inline module imports
V="$ver" perl -pi -e 's{\b((?:src|href)=")((?![a-z]+:|/|#)[^"?]+\.(?:js|css))"}{$1$2?v=$ENV{V}"}g' "$OUT/index.html" "$OUT"/ds/*.html
find "$OUT" -name '*.css' -exec env V="$ver" perl -pi -e 's{(\@import\s+")([^"?]+\.css)"}{$1$2?v=$ENV{V}"}g' {} +
find "$OUT/ds" \( -name '*.js' -o -path "$OUT/ds/*.html" ! -path "$OUT/ds/components/*" \) -exec env V="$ver" perl -pi -e \
  's{((?:\bimport\s+|\bfrom\s+|new URL\()\x27)(\.{1,2}/[^\x27?]+\.(?:js|css|svg))\x27}{$1$2?v=$ENV{V}\x27}g' {} +
if [ -n "${DEPLOY_OUT:-}" ]; then
  cp -R "$OUT" "$DEPLOY_OUT"
  echo "prepared $ver in $DEPLOY_OUT (not deployed)"
  exit 0
fi

# Pinned: an unpinned npx resolves "latest" against the registry on every run. Each step prints its start time, so a
# slow run says where it waited (a silent `pages project list` once sat ~7 minutes before every deploy).
# Each wrangler call gets 10 minutes where `timeout` exists (the Actions runner), so a hang fails instead of waiting.
TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout 600"
WRANGLER="$TO npx --yes wrangler@${WRANGLER_VERSION:-4.151.3}"
step() { echo "[$(date -u +%H:%M:%S)] $*"; }
step "wrangler 받기"
$WRANGLER --version
step "배포 $ver → $PROJECT ($BRANCH)"
# from the repo root: wrangler builds ./functions (the /chars/* Pages Function, R2 binding CHARS on the project) from there
cd "$ROOT"
# The project exists after the first deploy; only a failed deploy looks it up (and creates it when it is missing).
if ! $WRANGLER pages deploy "$OUT" --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true; then
  step "배포 실패 — 프로젝트 확인"
  $WRANGLER pages project list | grep -q "│ $PROJECT " && exit 1
  $WRANGLER pages project create "$PROJECT" --production-branch main
  $WRANGLER pages deploy "$OUT" --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true
fi
step "끝"
