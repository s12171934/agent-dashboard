"""Project progress endpoints."""

from urllib.parse import parse_qs

from adash.features.projects.notes import find_project, lite_project, project_note
from adash.features.projects.store import PROJECTS_DIRS
import adash.features.projects.store as projects_store


def get_projects(h, url):
    p = projects_store.projects
    h.send_json({"enabled": bool(PROJECTS_DIRS), "version": p["version"], "dirs": p["dirs"],
                 "projects": [lite_project(e) for e in p["list"]]})


def get_project(h, url):
    # By folder name; ?dir= picks one when the same name sits in two --projects-dir (else the first listed).
    q = parse_qs(url.query)
    found = find_project((q.get("name") or [""])[0], (q.get("dir") or [None])[0])
    if not found:
        return h.send_json({"error": "not found" if PROJECTS_DIRS else "--projects-dir 가 지정되지 않음"}, 404)
    h.send_json(found)


def get_project_note(h, url):
    # ?name=<project>&path=<note path relative to the project folder>[&dir=]: a step note or a note it links to
    q = parse_qs(url.query)
    found = find_project((q.get("name") or [""])[0], (q.get("dir") or [None])[0])
    if not found:
        return h.send_json({"error": "not found" if PROJECTS_DIRS else "--projects-dir 가 지정되지 않음"}, 404)
    h.send_json(*project_note(found, (q.get("path") or [""])[0]))
