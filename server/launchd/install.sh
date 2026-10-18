#!/bin/sh
# Install (or reinstall after editing the template) the launchd agent that keeps the dashboard running.
#   launchd/install.sh            install and start
#   launchd/install.sh uninstall  stop and remove
# Settings (environment variables):
#   DASH_LABEL   launchd label            (default: local.agent-dashboard)
#   DASH_HOSTS   addresses to bind, space-separated (default: 127.0.0.1), e.g. "127.0.0.1 <tailscale ip>"
#   DASH_ORIGINS page origins allowed over CORS, space-separated (default: none, local pages only),
#                e.g. "https://agent-dashboard.pages.dev"
#   DASH_PYTHON  python3 to run server.py (default: python3 on PATH)
#   DASH_PROJECTS_DIRS  folders of project folders (progress.json), colon-separated like PATH since paths may hold
#                spaces (default: none, project progress off), passed as --projects-dir
# A server started by hand on the same port must be stopped first, or the agent cannot bind.
set -eu
LABEL="${DASH_LABEL:-local.agent-dashboard}"
HOSTS="${DASH_HOSTS:-127.0.0.1}"
ORIGINS="${DASH_ORIGINS:-}"
PYTHON="${DASH_PYTHON:-$(command -v python3)}"
PROJECTS_DIRS="${DASH_PROJECTS_DIRS:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(dirname "$HERE")"
DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = uninstall ]; then
  rm -f "$DST"
  echo "removed $LABEL"
  exit 0
fi
host_args=""
for h in $HOSTS; do
  host_args="$host_args    <string>--host</string>\n    <string>$h</string>\n"
done
for o in $ORIGINS; do
  host_args="$host_args    <string>--origin</string>\n    <string>$o</string>\n"
done
old_ifs="$IFS"; IFS=:
for d in $PROJECTS_DIRS; do
  [ -n "$d" ] || continue
  d="$(printf '%s' "$d" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"  # plist is XML
  host_args="$host_args    <string>--projects-dir</string>\n    <string>$d</string>\n"
done
IFS="$old_ifs"
# a generated copy, not a link: launchd does not follow edits to a linked plist reliably
sed -e "s|@LABEL@|$LABEL|" -e "s|@PYTHON@|$PYTHON|" -e "s|@DIR@|$DIR|g" "$HERE/agent-dashboard.plist.in" \
  | awk -v hosts="$host_args" '{ if ($0 == "@HOSTS@") printf "%s", hosts; else print }' > "$DST"
plutil -lint "$DST" >/dev/null
launchctl bootstrap "$DOMAIN" "$DST"
launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid) ='
