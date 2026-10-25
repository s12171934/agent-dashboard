"""Project progress state (progress.json per project folder)."""


# ---- 프로젝트 진행: <--projects-dir>/<project>/progress.json (../exports/project-progress.schema.json) ----
# The file holds source facts only (ordered stages, their steps with dates and status); everything derived — stage
# status and span, step counts, current stage, completion — is computed here, never written back. Read-only: a
# file that does not match the schema shows as that project's error and the rest carry on.
PROJECTS_DIRS = []  # main() fills it from --projects-dir; empty turns the feature off
PROJECTS_EVERY = 2


project_cache = {}  # progress.json path -> (mtime, entry)
projects = {"version": 0, "dirs": [], "list": []}  # what /api/projects serves; rebound whole, so readers need no lock
