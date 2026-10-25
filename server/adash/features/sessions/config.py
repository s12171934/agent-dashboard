"""Where Claude and Codex transcripts live and how their run state is judged."""

import os

from adash.core.config import HOME


CLAUDE_GLOB = os.path.join(HOME, ".claude/projects/**/*.jsonl")
CODEX_GLOBS = [
    os.path.join(HOME, "Library/Application Support/orca/**/sessions/**/rollout-*.jsonl"),
    os.path.join(HOME, ".codex/sessions/**/rollout-*.jsonl"),
]
CLAUDE_CTX_WINDOW = 200_000  # assumed; Claude logs do not record the window
# Models seen past 200k in any session run with a 1M window here, so their other sessions get 1M too
# (otherwise a fresh session would read 200k until it happens to cross it).
LONG_CTX_MODELS = set()
# Run state comes from turn boundaries in the transcript, not from how recent the last line is.
STALL_SECONDS = 15 * 60   # a turn left open this long without any record is reported as stalled
WAIT_SECONDS = 30 * 60    # a finished turn counts as "waiting for input" for this long, then idle
HOOK_STATUS = os.path.join(HOME, "Library/Application Support/orca/agent-hooks/last-status.json")
hooks = {}  # provider session id -> Orca hook status (Orca-managed Claude panes only)
LOG_LIMIT = 600
CHAT_LIMIT, CHAT_CHARS = 200, 4000  # /api/chat: the last prompts and replies, each cut at this many characters
