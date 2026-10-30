"""Every endpoint, by path. Each one is a function (handler, parsed url) in its feature's api.py."""

from adash.features.chars import api as chars
from adash.features.decisions import api as decisions
from adash.features.designs import api as designs
from adash.features.flow import api as flow
from adash.features.history import api as history
from adash.features.interactions import api as interactions
from adash.features.orca_runs import api as orca_runs
from adash.features.projects import api as projects
from adash.features.review import api as review
from adash.features.sessions import api as sessions
from adash.features.terminals import api as terminals
from adash.features.tests import api as tests
from adash.features.usage import api as usage
from adash.features.vault import api as vault
from adash.features.worktrees import api as worktrees
from adash.http import snapshot

GET = {
    "/": snapshot.get_root,
    "/api/state": snapshot.get_state,
    "/api/glance": snapshot.get_glance,
    "/api/decisions": snapshot.get_decisions,
    "/events": snapshot.get_events,
    "/api/session": sessions.get_session,
    "/api/chat": sessions.get_chat,
    "/api/plans": sessions.get_plans,
    "/api/tests": tests.get_tests,
    "/api/tests/run": tests.get_run,
    "/api/history": history.get_history,
    "/api/reviews": review.get_reviews,
    "/api/run": orca_runs.get_run,
    "/api/decision/wait": decisions.get_wait,
    "/api/decision/mode": decisions.get_mode,
    "/api/orca/job": terminals.get_job,
    "/api/orca/places": terminals.get_places,
    "/api/interactions": interactions.get_interactions,
    "/api/projects": projects.get_projects,
    "/api/project": projects.get_project,
    "/api/project/note": projects.get_project_note,
    "/api/vault/recent": vault.get_recent,
    "/api/designs": designs.get_designs,
    "/api/design": designs.get_design,
    "/api/design/file": designs.get_design_file,
    "/api/design/refs": designs.get_design_refs,
    "/api/chars/jobs": chars.get_jobs,
    "/api/chars/file": chars.get_file,
    "/api/worktrees": worktrees.get_worktrees,
}

# The endpoint reads its action from the last path segment where one function serves several paths.
POST = {
    "/api/pref": sessions.post_pref,
    "/api/flow/ok": flow.post_ok,
    "/api/usage": usage.post_usage,
    "/api/orca/focus": terminals.post_terminal,
    "/api/orca/close": terminals.post_terminal,
    "/api/orca/launch": terminals.post_launch,
    "/api/orca/send": terminals.post_send,
    "/api/review/open": review.post_review,
    "/api/review/web": review.post_review,
    "/api/review/mark": review.post_review,
    "/api/review/ship": review.post_review,
    "/api/qa/automation": review.post_qa,
    "/api/qa/ticket": review.post_qa,
    "/api/chars/create": chars.post_char,
    "/api/chars/remove": chars.post_char,
    "/api/chars/unpublish": chars.post_char,
    "/api/chars/meta": chars.post_char,
    "/api/chars/redraw": chars.post_char,
    "/api/worktrees/open": worktrees.post_worktree,
    "/api/worktrees/web": worktrees.post_worktree,
    "/api/worktrees/note": worktrees.post_note,
    "/api/worktrees/remove": worktrees.post_remove,
    **{f"/api/decision/{a}": decisions.post_decision
       for a in ("ask", "answer", "release", "mode", "inbox", "guard", "dismiss")},
}

# Paths served by prefix, any method: the web VS Code relay (review/vscode_web.py).
PREFIXES = {"/vscode/": review.proxy_vscode}
