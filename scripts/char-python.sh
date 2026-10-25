#!/bin/sh
# Print a Python that has what the character scripts need (Pillow, numpy, scipy): $PYTHON or python3 when they import,
# else a venv kept in ~/.cache/agent-dashboard/char-venv, made on first use.
#   "$(scripts/char-python.sh)" scripts/char-publish.py …
set -eu
for py in ${PYTHON:-} python3; do
  "$py" -c 'import PIL, numpy, scipy' 2>/dev/null && { command -v "$py"; exit 0; }
done
V="$HOME/.cache/agent-dashboard/char-venv"
if ! "$V/bin/python" -c 'import PIL, numpy, scipy' 2>/dev/null; then
  python3 -m venv "$V" >&2
  "$V/bin/pip" install -q pillow numpy scipy >&2
fi
echo "$V/bin/python"
