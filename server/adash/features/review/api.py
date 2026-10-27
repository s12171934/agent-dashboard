"""Review and QA endpoints: the review sets, QA driver actions, review marks, VS Code and shipping."""

import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone

from adash.core.git import git_at
from adash.core.jira import JIRA_SITE
from adash.core.orca import orca
from adash.core.state import bump, lock
from adash.core.util import short
from adash.features.review import vscode_web
from adash.features.review.config import QA_SETS, VSCODE_CLI, WT_KEY
from adash.features.review.loop import review_ticket
from adash.features.review.notes import write_review
from adash.features.review.qa import QA_STAGES, qa_auto_cache, qa_cli
from adash.features.review.report import report_busy, report_launch, report_start
from adash.features.review.ship import SHIP_PROMPT, SHIP_SETTLED, jira_stage, ship_launch, ship_start
from adash.features.review.store import review_kick, review_state


def get_reviews(h, url):
    with lock:
        body = h.encode({"sets": review_state["sets"], "updated": review_state["updated"], "jira": JIRA_SITE})
    h.send_body(body)


def post_qa(h, url):
    """automation {"epic", "id", "action": enable|disable|run}: an Orca automation that names the epic (the set
    lists them). ticket {"epic", "action", ...}: the qa-driver CLI on the set's state directory. Per ticket ("key"):
    approve records push/PR approval and tells the coordinator; cleanup_check is cleanup's dry run (exit 3 = it would
    stop: uncommitted or unpushed work) and cleanup removes the worktree; restart starts the coordinator again; close
    closes its live terminals; ignore / unignore. Per set: close_finished {"keys"}; retire_check / retire (end of QA:
    automations off, shared coordination worktree removed; exit 3 = it would stop); adopt_check / adopt {"set":
    {KEY: value}, "automation"} hands an older watcher's automation to qa-driver; report starts the closing report's
    analysis worker of an ended set again."""
    what = url.path.rsplit("/", 1)[1]
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        epic, action = body["epic"], body["action"]
        assert isinstance(epic, str) and WT_KEY.fullmatch(epic) and isinstance(action, str)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    with lock:
        st = next((json.loads(json.dumps(x)) for x in review_state["sets"] if x["epic"] == epic), None)
    if not st:
        return h.send_json({"error": "없는 QA 묶음입니다"}, 404)
    if what == "automation":
        aid = body.get("id")
        if action not in ("enable", "disable", "run") or aid not in {a["id"] for a in st.get("automations") or []}:
            return h.send_json({"error": "이 묶음의 자동화가 아니거나 모르는 동작입니다"}, 400)
        try:
            if action == "run":
                orca("automations", "run", aid, timeout=60)
            else:
                orca("automations", "edit", aid, "--enabled" if action == "enable" else "--disabled", timeout=30)
        except Exception as e:
            return h.send_json({"error": "Orca: " + short(str(e), 300)}, 502)
        qa_auto_cache["at"] = 0  # show the new state on the next pass
        review_kick.set()
        return h.send_json({"ok": True})
    if not st.get("watch"):
        return h.send_json({"error": "이 묶음에는 상태 디렉터리(watch)가 없습니다"}, 409)
    if action == "report":  # 「보고서 다시 작성」: the ended set's analysis worker, once more
        if not st.get("retired"):
            return h.send_json({"error": "종료된 QA 만 보고서를 씁니다"}, 409)
        with lock:
            if report_busy(st.get("analysis")) or (epic in report_launch and not report_launch[epic].get("error")):
                return h.send_json({"error": "보고서 워커가 이미 돌고 있습니다"}, 409)
            report_launch[epic] = {"at": datetime.now(timezone.utc).isoformat(), "error": None}
            bump()
        threading.Thread(target=report_start, args=(st, next((q for q in QA_SETS if q.get("epic") == epic), None)), daemon=True).start()
        return h.send_json({"ok": True, "output": "보고서 워커를 띄웁니다"})
    keys = {t["key"] for t in st["tickets"]}
    if action in ("close_finished", "retire_check", "retire", "adopt_check", "adopt"):  # the whole set
        if action == "close_finished":
            ks = body.get("keys")
            if not (isinstance(ks, list) and ks and all(isinstance(k, str) and k in keys for k in ks)):
                return h.send_json({"error": "닫을 티켓 목록이 잘못됐습니다"}, 400)
            args = ("close", *ks)
        elif action == "adopt":
            kv, aid = body.get("set") or {}, body.get("automation")
            if not (isinstance(kv, dict) and all(isinstance(k, str) and re.fullmatch(r"[A-Z][A-Z0-9_]*", k)
                    and isinstance(v, str) and "\n" not in v for k, v in kv.items())
                    and (aid is None or aid in {a["id"] for a in st.get("automations") or []})):
                return h.send_json({"error": "이관 설정 값이 잘못됐습니다"}, 400)
            args = ("adopt", *[x for k, v in kv.items() for x in ("--set", f"{k}={v}")], *(("--automation", aid) if aid else ()))
        else:
            args = {"retire_check": ("retire", "--dry-run"), "retire": ("retire",), "adopt_check": ("adopt", "--check")}[action]
    else:
        key = body.get("key")
        if not (isinstance(key, str) and key in keys):
            return h.send_json({"error": "묶음에 없는 티켓입니다"}, 404)
        args = {"approve": ("approve", key, "--by", "대시보드"), "merge": ("merge", key, "--by", "대시보드"), "cleanup_check": ("cleanup", key, "--dry-run"),
                "cleanup": ("cleanup", key), "restart": ("restart", key), "close": ("close", key),
                "ignore": ("ignore", key), "unignore": ("ignore", key, "--undo")}.get(action)
    if not args:
        return h.send_json({"error": "모르는 동작입니다"}, 400)
    try:
        code, out = qa_cli(epic, st["watch"], *args)
    except subprocess.TimeoutExpired:
        return h.send_json({"error": "qa-driver 가 제한 시간 안에 끝나지 않았습니다"}, 504)
    review_kick.set()
    return h.send_json({"ok": code == 0, "code": code, "output": out}, 200 if code in (0, 3) else 502)


def post_review(h, url):
    """{"key"} -> open: one VS Code window holding every worktree of the ticket. Only for a request addressed to
    this Mac's loopback (the page open on this Mac): it starts an app here, and a tailnet device reaches the server
    through `tailscale serve`, whose requests carry the ts.net Host and X-Forwarded-For. mark {"key", "done"}:
    record or clear the review in the ticket's vault step note, with each worktree's HEAD now. On a driver ticket
    whose coordinator has finished its own review (stage committed, ready/ written) a review is also the push·PR
    approval: `qa-driver approve`. Before committed a review is refused: the worktree is still being changed.
    web: the web VS Code (vscode_web) for each worktree, started if needed: {"repos": [{"repo", "path", "url"}]}, the
    url relative to this server, on the same loopback-only terms as open."""
    action = url.path.rsplit("/", 1)[1]
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        key = body["key"]
        assert isinstance(key, str) and WT_KEY.fullmatch(key)
        done = body.get("done", True)
        assert isinstance(done, bool)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    with lock:
        t = review_ticket(key)
        t = t and json.loads(json.dumps(t))
    if not t:
        return h.send_json({"error": "묶음에 없는 티켓입니다"}, 404)
    if not t["repos"]:
        return h.send_json({"error": "이 티켓의 워크트리가 없습니다"}, 409)
    if action == "ship":
        qs = next((q for q in QA_SETS if any(x["key"] == key for s in review_state["sets"] if s["epic"] == q.get("epic")
                                              for x in s["tickets"])), None)
        if not SHIP_PROMPT or not os.path.isfile(SHIP_PROMPT):
            return h.send_json({"error": "prefs.json 의 ship_prompt 가 없거나 파일이 없습니다"}, 409)
        if not qs or not qs.get("ship_place"):
            return h.send_json({"error": "prefs.json 의 이 묶음에 ship_place 가 없습니다"}, 409)
        if jira_stage(t) != "prog":
            return h.send_json({"error": f"Jira 「{t.get('status')}」 티켓입니다 (진행 중만)"}, 409)
        with lock:
            busy = (key in ship_launch and not ship_launch[key].get("error")) \
                or (t.get("ship") and t["ship"].get("status") not in SHIP_SETTLED)
            if busy:
                return h.send_json({"error": "이미 반출 중입니다"}, 409)
            ship_launch[key] = {"at": datetime.now(timezone.utc).isoformat(), "error": None}
            bump()
        threading.Thread(target=ship_start, args=(t, qs), daemon=True).start()
        review_kick.set()
        return h.send_json({"ok": True}, 202)
    if action == "web":
        if not vscode_web.local(h):
            return h.send_json({"error": "웹 VS Code 는 이 맥에서 연 화면에서만 됩니다"}, 403)
        err = vscode_web.ensure()
        if err:
            return h.send_json({"error": err}, 502)
        return h.send_json({"repos": [{"repo": rp["repo"], "path": rp["path"], "url": vscode_web.url_for(rp["path"])}
                                      for rp in t["repos"]]})
    if action == "open":
        if not vscode_web.local(h):
            return h.send_json({"error": "VS Code 열기는 이 맥에서 연 화면에서만 됩니다"}, 403)
        # Each worktree as itself, one window per repo: a generated .code-workspace held the folders under a
        # /tmp file and renamed them, so the window read as somewhere other than the worktree.
        for rp in t["repos"]:
            cmd = [VSCODE_CLI, "-n", rp["path"]] if os.path.exists(VSCODE_CLI) else ["open", "-n", "-a", "Visual Studio Code", rp["path"]]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if r.returncode:
                return h.send_json({"error": f'VS Code 로 {rp["repo"]} 를 열지 못함: ' + short(r.stderr, 200)}, 502)
        return h.send_json({"ok": True, "opened": [rp["path"] for rp in t["repos"]]})
    if not t["step"]:
        return h.send_json({"error": "볼트에 이 티켓의 스텝 노트가 없습니다"}, 409)
    shas = {}
    for r in t["repos"]:
        head = git_at(r["path"], "rev-parse", "--short=9", "HEAD")
        if not head:
            return h.send_json({"error": f'{r["repo"]} HEAD 를 읽지 못함'}, 502)
        shas[r["repo"]] = head
    try:
        rnd = (t.get("qa") or {}).get("round") if done else None
        write_review(t["step"], shas if done else None, rnd)
    except (OSError, ValueError) as e:
        return h.send_json({"error": "스텝 노트 기록 실패: " + short(repr(e), 200)}, 500)
    qa = t.get("qa") or {}
    if done and qa.get("stage") in QA_STAGES[:QA_STAGES.index("committed")] and any(
            x.get("driver") and any(y["key"] == key for y in x["tickets"]) for x in review_state["sets"]):
        return h.send_json({"error": "코디네이터가 커밋(ready/)하기 전이라 아직 리뷰할 수 없습니다"}, 409)
    approve = None
    if done and qa.get("stage") == "committed":
        with lock:
            st = next((x for x in review_state["sets"] if x.get("driver") and x.get("watch")
                       and any(y["key"] == key for y in x["tickets"])), None)
            epic, watch = (st["epic"], st["watch"]) if st else (None, None)
        if epic:
            try:
                approve = qa_cli(epic, watch, "approve", key, "--by", "대시보드 리뷰 완료")
            except subprocess.TimeoutExpired:
                approve = (124, "qa-driver 가 제한 시간 안에 끝나지 않았습니다")
    with lock:  # show it now; the next pass (woken here) recomputes it from the note anyway
        live = review_ticket(key)
        if live:
            live.update(review="done" if done else "pending", review_sha=shas if done else {}, review_round=rnd,
                        review_at=datetime.now().date().isoformat() if done else None)
            review_state["updated"] = datetime.now(timezone.utc).isoformat()
            bump()
    review_kick.set()
    if approve and approve[0]:
        return h.send_json({"error": "리뷰는 기록했지만 반출 승인 실패: " + short(approve[1], 300)}, 502)
    h.send_json({"ok": True, "review_sha": shas if done else {}, "approved": bool(approve),
                    "output": approve[1] if approve else None})


def proxy_vscode(h, url):
    vscode_web.proxy(h, url)
