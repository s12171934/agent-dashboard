"""「구현 ① 프로젝트」(workflow-canvas impl-project) 실행마다 그 아래 모든 티켓의 체크박스 진행.

입력은 읽기만 한다.
- ① 실행 폴더 `.executions/<launch>-impl-project/`: `meta.json`(title·runId·values.jira_scope·coordinatorTerminal)과
  `1-map.txt` 의 `order:` 절(층별 티켓 · 패키지 라벨 · 저장소, 「별도 실행」 티켓).
- ② 실행 `*-impl-ticket/meta.json` 중 `parent.launch` 가 그 ① 인 것: `inputs.wt`(티켓 키 또는 `<키>-cb<n>`)와
  `project`(서브모듈 경로, 슈퍼프로젝트일 때도 있음). 같은 티켓은 가장 늦게 시작한 것.
- 체크박스 정본 = 티켓 워크트리 장부 `<서브모듈 git common dir>/worktrees/<wt>/checkbox-review/ledger.md` 의
  `## 체크박스` 표(머리줄로 번호·문구·종류·상태 열을 찾는다)와 `현재 체크박스: cbN`.

문구가 「완료」인 마감 칸은 목록에는 두되 합계와 티켓 완료 판정에서 뺀다. 장부가 없는 티켓은 「미착수」, 체크박스
수는 모른다(Jira 는 읽지 않는다)."""

import json
import os
import re

from adash.core.files import read_text_cached
from adash.core.git import git_in
from adash.features.interactions.interactions import canvas_dir

KEY = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")
LAYER = re.compile(r"^\s*(\d+)\s+(.*)$")
FIELD = re.compile(r"^([a-z][a-z -]*?)\s*(\([^)]*\))?\s*:")  # 「order:」「chain-deps:」「separate run (…):」


def _meta(path):
    try:
        d = json.loads(read_text_cached(path) or "null")
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def parse_map(text):
    """`order:` 절의 티켓 목록. 두 형식을 읽는다:
    - 한 층에 여러 티켓: `1 PSD-1118 R1 plang_rails develop 브랜치 | PSD-1121 F1 plang-front-common main …`
    - 한 줄에 한 티켓: `1 PSD-1100 R1 | plang_rails | origin/develop | 브랜치 | wt PSD-1100`
    「(별도 실행 …)」 티켓과 `separate run …:` 줄의 티켓은 separate=True (이 실행이 디스패치하지 않음)."""
    out, seen, inside = [], set(), False

    def add(key, label, repo, layer, separate):
        if key in seen:
            return
        seen.add(key)
        out.append({"key": key, "label": label, "repo": repo, "layer": layer, "separate": separate})

    def separate_list(s, layer=None):
        for m in re.finditer(r"([A-Z][A-Z0-9]+-\d+)\s*([^\s(·|,]*)", s):
            add(m.group(1), m.group(2) or "", None, layer, True)

    for line in (text or "").splitlines():
        if not line.strip():
            continue
        f = FIELD.match(line)
        if f and not line[:1].isspace():
            name = f.group(1).strip()
            if name == "order":
                inside = True
                continue
            if name.startswith("separate run"):
                separate_list(line[f.end():])
                continue
            inside = False
            continue
        if not inside:
            continue
        m = LAYER.match(line)
        if not m:
            continue
        layer, rest = int(m.group(1)), m.group(2)
        segs = [s.strip() for s in rest.split("|")]
        multi = len(segs) > 1 and all(KEY.match(s) for s in segs)
        if multi or len(segs) == 1:
            for s in segs:
                k = KEY.match(s)
                if not k:
                    continue
                toks = s.split()
                if "별도 실행" in s:
                    add(k.group(1), toks[1] if len(toks) > 1 and not toks[1].startswith("(") else "", None, layer, True)
                else:
                    add(k.group(1), toks[1] if len(toks) > 1 else "", toks[2] if len(toks) > 2 else None, layer, False)
        else:
            toks = segs[0].split()
            k = KEY.match(segs[0])
            if not k:
                continue
            repo = (segs[1].split() or [None])[0]
            add(k.group(1), toks[1] if len(toks) > 1 else "", repo, layer, "별도 실행" in rest)
    return out


def norm_status(s):
    """장부 표 상태 → done·committed·running·blocked·pending. 구현 ③ 의 표 상태는 pending → running(착수) →
    committed(커밋, 마감 전) → done(「토큰 집계·기각 로그·종료」) 순서다. 모르는 값은 pending."""
    s = (s or "").strip().lower()
    if s.startswith(("done", "verified")) or s in ("완료", "통과"):
        return "done"
    if s.startswith(("committed", "커밋")):
        return "committed"
    if s.startswith(("running", "in_progress", "진행")):
        return "running"
    if s.startswith(("blocked", "fail", "막힘", "실패")):
        return "blocked"
    return "pending"


def parse_ledger(text):
    """(체크박스 목록, 현재 체크박스) — `## 체크박스` 표를 머리줄의 열 이름으로 읽는다."""
    items, head, inside = [], None, False
    for line in (text or "").splitlines():
        if line.startswith("## "):
            inside = line.strip() == "## 체크박스"
            continue
        if not inside or not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if head is None:
            head = cells
            continue
        if all(set(c) <= set("-: ") for c in cells):
            continue
        if not re.match(r"^cb\d+$", cells[0]):
            continue
        col = lambda name, d: head.index(name) if name in head else d  # noqa: E731
        extra = max(0, len(cells) - len(head))  # 문구 안의 「|」
        ti, ki, si = col("문구", 1), col("종류", 2), col("상태", 3)
        text_ = " | ".join(cells[ti:ki + extra]) if ki > ti else cells[ti]
        kind = cells[ki + extra] if ki + extra < len(cells) else ""
        raw = cells[si + extra] if si + extra < len(cells) else ""
        items.append({"cb": cells[0], "text": text_, "kind": kind, "status": norm_status(raw), "raw": raw,
                      "closing": text_ == "완료"})
    # 「체크박스 실행: cbN <상태> …」 줄(마지막 것)로 표가 아직 pending 인 칸을 보정한다 — 착수 때 표를 running 으로
    # 바꾸지 않은 장부도 실행 중으로 보이게. 표가 pending 이 아니면 표를 따른다.
    log = {}
    for m in re.finditer(r"^[-*\s]*체크박스 실행:\s*(cb\d+)\s+(\S+)", text or "", re.M):
        log[m.group(1)] = m.group(2)
    for x in items:
        st = norm_status(log.get(x["cb"]))
        if x["status"] == "pending" and log.get(x["cb"]) and st != "pending":
            x["status"], x["from_log"] = st, True
    cur = re.search(r"^[-*\s]*현재 체크박스:\s*(cb\d+)", text or "", re.M)
    return items, cur.group(1) if cur else None


def summarize(items, current):
    work = [x for x in items if not x["closing"]]
    done = sum(x["status"] in ("done", "committed") for x in work)  # committed: 커밋은 끝, 마감만 남음
    total = len(work)
    if total and done == total:
        state = "done"
    elif any(x["status"] == "blocked" for x in items):  # 마감 칸이 막혀도 티켓은 막힘
        state = "blocked"
    else:
        state = "running"
    cur = next((x for x in items if x["cb"] == current), None) if current else None
    if state != "done" and (cur is None or cur["status"] == "done"):
        # 장부의 「현재 체크박스」가 비었거나 이미 끝난 칸이면: 돌거나 막힌 칸, 마감 중(committed)인 칸, 없으면 다음 대기 작업 칸
        cur = next((x for x in items if x["status"] in ("running", "blocked")), None) \
            or next((x for x in work if x["status"] == "committed"), None) \
            or next((x for x in work if x["status"] == "pending"), cur)
    return {"done": done, "total": total, "state": state, "current": cur}


_gitdir = {}


def common_dir(path):
    if path not in _gitdir:
        _gitdir[path] = git_in(path, "rev-parse", "--path-format=absolute", "--git-common-dir") if os.path.isdir(path) else None
    return _gitdir[path]


def ledger_path(project, repo, wt, key):
    """장부 경로: project 의 git common dir 아래 worktrees/<wt>. project 가 슈퍼프로젝트이면 그 안의 <repo> 서브모듈."""
    dirs = []
    for p in filter(None, [project, project and repo and os.path.join(project, repo),
                           project and repo and os.path.join(os.path.dirname(project), repo)]):
        g = common_dir(p)
        if g and g not in dirs:
            dirs.append(g)
    for g in dirs:
        for w in dict.fromkeys(filter(None, [wt, key])):
            f = os.path.join(g, "worktrees", w, "checkbox-review", "ledger.md")
            if os.path.isfile(f):
                return f
    return None


def _children(root):
    """① launch 이름 -> {티켓 키: 가장 늦은 ② meta(+launch)}."""
    out = {}
    try:
        names = sorted(n for n in os.listdir(root) if n.endswith("-impl-ticket"))
    except OSError:
        return out
    for name in names:  # 이름이 시작 시각 순이라 뒤의 것이 덮는다
        m = _meta(os.path.join(root, name, "meta.json"))
        if not m:
            continue
        parent = (m.get("parent") or {}).get("launch")
        wt = (m.get("inputs") or {}).get("wt") or m.get("title") or ""
        k = KEY.match(wt)
        if parent and k:
            out.setdefault(parent, {})[k.group(1)] = {**m, "launch": name, "wt": wt}
    return out


def project_progress(root, launch, meta, kids):
    tickets = parse_map(read_text_cached(os.path.join(root, launch, "1-map.txt")))
    known = {t["key"] for t in tickets}
    for k in kids:  # ② 실행은 있는데 맵에 없는 티켓
        if k not in known:
            tickets.append({"key": k, "label": "", "repo": None, "layer": None, "separate": False, "unmapped": True})
    tot = {"done": 0, "total": 0, "tickets": 0, "tickets_done": 0, "unknown": 0}
    for t in tickets:
        child = kids.get(t["key"])
        project = child and child.get("project")
        repo = t.get("repo") or (project and os.path.basename(project))
        t["repo"] = repo
        t["child"] = child and {"launch": child["launch"], "runId": child.get("runId"), "wt": child["wt"],
                                "project": project, "startedAt": child.get("startedAt")}
        f = ledger_path(project, t.get("repo"), child and child["wt"], t["key"]) if child else None
        if not f and not t["separate"] and repo:
            # ② 실행 기록 없이 워크트리만 있는 경우: 형제 ② 의 경로 옆에서 맵의 저장소로 찾는다
            for base in dict.fromkeys(c["project"] for c in kids.values() if c.get("project")):
                f = ledger_path(base, repo, None, t["key"])
                if f:
                    break
        t["ledger"] = f
        if f:
            items, cur = parse_ledger(read_text_cached(f))
            t["items"] = items
            t.update(summarize(items, cur))
        else:
            t["items"], t["done"], t["total"], t["current"] = [], 0, None, None
            t["state"] = "out" if t["separate"] else "todo"
        if t["separate"]:
            continue
        tot["tickets"] += 1
        if t["total"] is None:
            tot["unknown"] += 1
        else:
            tot["done"] += t["done"]
            tot["total"] += t["total"]
        tot["tickets_done"] += t["state"] == "done"
    v = meta.get("values") or {}
    return {"launch": launch, "title": meta.get("title") or launch, "runId": meta.get("runId"),
            "epic": v.get("jira_scope"), "project_key": v.get("project_key"),
            "coordinator": meta.get("coordinatorTerminal"), "startedAt": meta.get("startedAt"),
            "summary": tot, "tickets": tickets}


def collect(run=None, term=None, launch=None):
    """① 실행들의 진행. run(Orca Run id)·term(코디네이터 터미널)·launch 중 주어진 것으로 거른다."""
    root = canvas_dir()
    try:
        names = sorted((n for n in os.listdir(root) if n.endswith("-impl-project")), reverse=True)
    except OSError:
        return []
    kids, out = None, []
    for name in names:
        if launch and name != launch:
            continue
        meta = _meta(os.path.join(root, name, "meta.json"))
        if not meta:
            continue
        if run and meta.get("runId") != run:
            continue
        if term and meta.get("coordinatorTerminal") != term:
            continue
        if kids is None:
            kids = _children(root)
        out.append(project_progress(root, name, meta, kids.get(name, {})))
    return out
