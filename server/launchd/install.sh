#!/bin/sh
# Build, validate, then install/start the launchd agent. Nothing stops on a failed build.
# install.sh uninstall: stop and remove the installed service.
# DASH_LABEL=local.agent-dashboard; DASH_HOSTS=127.0.0.1; DASH_ORIGINS='https://…'
# DASH_BINARY: existing native executable (skips the build); DASH_DATA: data directory
# DASH_PROJECTS_DIRS: colon-separated project directories
set -eu
LABEL="${DASH_LABEL:-local.agent-dashboard}"
HOSTS="${DASH_HOSTS:-127.0.0.1}"
ORIGINS="${DASH_ORIGINS:-}"
PROJECTS_DIRS="${DASH_PROJECTS_DIRS:-}"
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DIR="$(dirname "$HERE")"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [ "${1:-}" = uninstall ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$DST"
  echo "removed $LABEL"
  exit 0
fi
if [ -z "${DASH_BINARY:-}" ]; then
  "$DIR/cargo" build --release --locked
fi
BINARY="${DASH_BINARY:-$DIR/target/release/agent-dashboard}"
[ -x "$BINARY" ] || { echo "not executable: $BINARY" >&2; exit 1; }
BINARY="$(CDPATH= cd -- "$(dirname -- "$BINARY")" && pwd)/$(basename -- "$BINARY")"
DATA="${DASH_DATA:-}"
if [ -n "$DATA" ]; then
  mkdir -p "$DATA"
  DATA="$(CDPATH= cd -- "$DATA" && pwd)"
elif [ -d "$DIR/data" ]; then
  DATA="$DIR/data"
else
  DATA="$DIR"
fi
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
replacement() { xml "$1" | sed -e 's/[\&|]/\\&/g'; }
host_args=""
for h in $HOSTS; do
  host_args="$host_args    <string>--host</string>\n    <string>$(xml "$h")</string>\n"
done
for o in $ORIGINS; do
  host_args="$host_args    <string>--origin</string>\n    <string>$(xml "$o")</string>\n"
done
old_ifs="$IFS"; IFS=:
for d in $PROJECTS_DIRS; do
  [ -n "$d" ] || continue
  host_args="$host_args    <string>--projects-dir</string>\n    <string>$(xml "$d")</string>\n"
done
IFS="$old_ifs"
mkdir -p "$(dirname "$DST")"
TMP="$(mktemp "$DST.XXXXXX")"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
sed -e "s|@LABEL@|$(replacement "$LABEL")|g" \
    -e "s|@BINARY@|$(replacement "$BINARY")|g" \
    -e "s|@DIR@|$(replacement "$DIR")|g" \
    -e "s|@DATA@|$(replacement "$DATA")|g" "$HERE/agent-dashboard.plist.in" \
  | awk -v hosts="$host_args" '{ if ($0 == "@HOSTS@") printf "%s", hosts; else print }' > "$TMP"
plutil -lint "$TMP" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
mv "$TMP" "$DST"
launchctl bootstrap "$DOMAIN" "$DST"
launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid) ='
