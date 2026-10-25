"""Jira REST reads (read only), for the review sets."""

import base64
import json
import os
import subprocess
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from adash.core.prefs import prefs


JIRA_SITE = (prefs.get("jira_site") or "").rstrip("/")  # https://<site>.atlassian.net


_jira_token = None


def jira_token():
    """ATLASSIAN_API_TOKEN; launchd does not read ~/.zshrc where it is exported, so ask an interactive zsh once."""
    global _jira_token
    if _jira_token is None:
        t = os.environ.get("ATLASSIAN_API_TOKEN") or ""
        if not t:
            try:
                out = subprocess.run(["/bin/zsh", "-ic", "print -r -- $ATLASSIAN_API_TOKEN"], capture_output=True,
                                     text=True, timeout=15).stdout.strip().splitlines()
                t = out[-1].strip() if out else ""
            except (OSError, subprocess.SubprocessError):
                t = ""
        _jira_token = t
    return _jira_token


def jira_get(path, query):
    email, token = prefs.get("jira_email"), jira_token()
    if not (JIRA_SITE and email and token):
        raise RuntimeError("Jira 설정 없음 (prefs.json jira_site · jira_email, ATLASSIAN_API_TOKEN)")
    auth = base64.b64encode(f"{email}:{token}".encode()).decode()
    req = Request(f"{JIRA_SITE}/rest/api/3/{path}?{urlencode(query)}",
                  headers={"Authorization": "Basic " + auth, "Accept": "application/json"})
    with urlopen(req, timeout=20) as r:
        return json.load(r)


def jira_epic(epic):
    """-> (epic summary, [{key, summary, status, cat, assignee}]) for an epic's children."""
    summary = jira_get(f"issue/{epic}", {"fields": "summary"})["fields"].get("summary")
    out, nxt = [], None
    while True:
        q = {"jql": f"parent = {epic} ORDER BY key", "fields": "summary,status,assignee", "maxResults": "100"}
        if nxt:
            q["nextPageToken"] = nxt
        d = jira_get("search/jql", q)
        for i in d.get("issues") or []:
            f, st = i["fields"], i["fields"].get("status") or {}
            out.append({"key": i["key"], "summary": f.get("summary"), "status": st.get("name"),
                        "cat": (st.get("statusCategory") or {}).get("key"),
                        "assignee": (f.get("assignee") or {}).get("displayName")})
        nxt = d.get("nextPageToken")
        if not nxt or d.get("isLast", True):
            return summary, out
