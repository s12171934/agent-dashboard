"""Review settings from prefs.json (QA sets, bases, Jira)."""

import re

from adash.core.prefs import prefs


# ---- Review: a QA set's tickets → their Orca worktrees, reviewed ticket by ticket in VS Code ----
# prefs.json "qa_sets": [{"epic": "<epic key>", "project": "<vault-relative project folder>"}]. The epic's children
# (Jira `parent = epic`, read only) are the set's tickets. Each ticket pulls in the Orca worktrees whose folder name
# carries its key, the vault step note whose file name does (the project's progress.json lists them) and its latest
# test run. A review is recorded in that step note's frontmatter (review / review_sha / review_at / review_round).
# review_sha follows the worktrees' HEADs (rebases before push move them all the time); 「재오픈」 is derived from
# review_round against the driver's round now, and is what sends a reviewed ticket back to review.
QA_SETS = prefs.get("qa_sets") or []
# Branch a worktree is compared with when it has no open PR, per repo (the main checkout's folder name); else main.
REVIEW_BASES = prefs.get("review_bases") or {}
# Repos listed first inside a ticket and in its VS Code window (e.g. a shared library the apps build on).
REVIEW_FIRST = prefs.get("review_first") or []


REVIEW_EVERY, JIRA_EVERY, PR_EVERY = 30, 300, 600
VSCODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
WT_KEY = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])")
