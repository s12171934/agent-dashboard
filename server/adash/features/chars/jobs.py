"""Characters made from the page: one uploaded picture and a brief go to an Orca agent in this repo's main worktree,
which draws the sheets with scripts/char-gen.sh (full from the picture, then bust and the SD sheet from full) and puts
them online with scripts/char-publish.py, no deploy. Each job is a folder under WORK; how far it got is read from the
files the agent leaves there, so a server restart loses nothing."""

import base64
import json
import os
import re
import shutil
import time

from adash.core.config import HERE, HOME
from adash.features.orca_runs.store import orca_state
from adash.features.terminals.close import close_jobs, jobs_lock
from adash.features.terminals.launch import AGENTS, MODEL, places, start_launch

REPO = os.path.dirname(HERE)
WORK = os.path.join(HOME, ".cache/agent-dashboard/chars")
WHO = re.compile(r"[a-z][a-z0-9-]{1,23}")
BUILTIN = {"aoi", "ren", "hina", "sora", "kaede", "yuki"}
MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"RIFF", "webp"))
IMAGE_MAX = 10 << 20
KEEP = 14 * 86400  # finished jobs older than this are dropped from the list (and their folder)
# What the agent leaves, in order: the description, the sheets as Codex drew them, the cut strips, the stamp.
STEPS = (("desc", "desc.txt"), ("full", "{w}-full.webp"), ("bust", "{w}-bust.webp"), ("sd", "{w}-sd-bust.png"),
         ("published", ".published"))
SHEETS = {"ref": None, "full": "{w}_full.png", "bust": "{w}_bust.png", "sd": "{w}_sd.png"}

BRIEF = """# 캐릭터 만들기: {name} ({who})

대시보드 「캐릭터」 탭에서 사용자가 원본 그림 한 장으로 요청한 캐릭터다. 사무실 화면에 쓸 그림 세 가지 — 일러스트 **전신**·**상반신**(Live2D 그림체는 이것을 실시간으로 변형한다)과 **SD 2등신 픽셀**(「AI 생성」 그림체) — 을 만들어 배포 없이 올린다. 저장소 파일은 고치지 않는다. 산출물은 모두 작업 폴더에 둔다. 대시보드는 이 폴더에 생기는 파일로 진행을 보여 준다.

- 작업 폴더: `{work}`
- 원본 그림: `{ref}`
- 영문 이름(파일 이름): `{who}` · 표시 이름: {name} · 역할: {role}
- 사용자가 적은 생김새: {look}
- 사용자 요청: {notes}
- 스크립트: `{repo}/scripts/` — `char-gen.sh`(Codex 이미지 생성 + 자르기, 한 번에 약 10분), `char-publish.py`(R2 에 올리기), `char-python.sh`(Pillow·numpy·scipy 가 있는 파이썬 경로를 출력, 없으면 만든다)

## 순서

1. **원본 읽기.** 원본 그림을 열어 보고, 캐릭터 설명을 영어 한 줄로 써서 `{work}/desc.txt` 에 저장한다. `char-gen.sh` 의 `CHARS` 줄과 같은 형식이다: 인상·역할(예: `young woman QA engineer`), 머리 모양·색, 눈 색, 위에서 아래로 옷, 신발, 눈에 띄는 소품. 사용자 요청과 생김새가 원본보다 우선한다.
   - 원본이 실제 인물 사진이면 그 사람의 얼굴을 닮게 쓰지 말고, 머리·옷·색·분위기만 가져온 오리지널 캐릭터로 쓴다. 기존 작품의 캐릭터라면 그대로 베끼지 말고 특징을 바꿔 오리지널로 만든다.
   - 사무실의 여덟 동작(서 있기·노트북 타자·커피·머리 감싸 쥐기·졸기·브이·손 들기·눈 감기)을 그릴 수 있게, 손에 늘 드는 물건이나 무기처럼 동작을 가리는 요소는 빼거나 옆에 둔다.
   {boss_line}
2. **전신.** 작업 폴더에서 실행한다:
   `CHAR_REF='{ref}' CHAR_DESC="$(cat '{work}/desc.txt')" '{repo}/scripts/char-gen.sh' {who} full '{work}'`
   끝나면 `{work}/{who}_full.png` 를 열어 확인한다: 4×2 칸, 흰 배경, 여덟 칸 모두 같은 캐릭터의 머리부터 신발까지(잘림 없음), 칸 순서가 위 여덟 동작. 어긋나면 설명을 고쳐 다시 돌린다(최대 두 번 더).
3. **상반신과 SD.** 둘 다 전신을 참조하므로 전신 뒤에, 둘은 동시에 돌린다(같은 환경 변수로 `bust` 와 `sd`, 백그라운드 두 개 후 기다리기). SD 는 aoi 의 SD 시트를 비율 템플릿으로 쓴다(없으면 스크립트가 만든다). `{who}_bust.png`·`{who}_sd.png` 를 열어 같은 캐릭터인지, SD 가 2등신 픽셀 아트인지 확인하고, 크게 어긋난 쪽만 다시 돌린다.
4. **스트립 확인.** `{who}-full.webp`·`{who}-bust.webp`·`{who}-sd.png`·`{who}-sd-bust.png` 네 개가 작업 폴더에 있어야 한다.
5. **올리기.**
   `"$('{repo}/scripts/char-python.sh')" '{repo}/scripts/char-publish.py' {who} --name '{name}' --look '<한국어 생김새 요약>'{boss_flag} --dir '{work}'`
   `--look` 은 사용자가 적은 생김새가 있으면 그대로, 없으면 「빨간 웨이브 단발 · 노란 우비 · 빨간 장화」처럼 「·」로 나눈 세 토막으로 쓴다. 성공하면 `.published` 가 생기고, 열려 있는 대시보드가 1분 안에 이 캐릭터를 더한다.
6. 도중에 포기해야 하면(로그인 만료, 생성 거부가 되풀이됨 등) `{work}/failed.txt` 에 이유를 한두 줄 쓰고 끝낸다.

끝나면 무엇을 만들었는지(설명 한 줄, 다시 돌린 횟수)만 짧게 보고한다.
"""


def job_dir(jid):
    return os.path.join(WORK, jid) if re.fullmatch(r"[a-z0-9-]+-\d{8}-\d{6}", jid or "") else None


def read_job(d):
    try:
        with open(os.path.join(d, "job.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_job(d, job):
    tmp = os.path.join(d, "job.json.tmp")
    with open(tmp, "w") as f:
        json.dump(job, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(d, "job.json"))


def check_create(body):
    """The page's form -> (who, fields, image bytes, extension) or ValueError with what is wrong."""
    who, name = body.get("who") or "", (body.get("name") or "").strip()
    look, notes = (body.get("look") or "").strip(), (body.get("notes") or "").strip()
    agent, model = body.get("agent") or "claude", body.get("model") or ""
    if not (isinstance(who, str) and WHO.fullmatch(who)):
        raise ValueError("영문 이름은 소문자로 시작하는 소문자·숫자·- 2~24자입니다 (파일 이름이 됩니다)")
    if who in BUILTIN:
        raise ValueError(f"「{who}」 는 기본 캐릭터 이름입니다 — 다른 이름을 쓰세요")
    if not name or len(name) > 20 or len(look) > 80 or len(notes) > 1000 or "'" in name + look:
        raise ValueError("표시 이름은 20자, 생김새는 80자, 요청은 1000자까지입니다 (작은따옴표 ' 는 쓸 수 없음)")
    if agent not in AGENTS or (model and not (isinstance(model, str) and MODEL.fullmatch(model))):
        raise ValueError("에이전트나 모델 id 가 잘못됐습니다")
    try:
        img = base64.b64decode(body.get("image") or "", validate=True)
    except (ValueError, TypeError):
        raise ValueError("원본 그림을 읽지 못했습니다")
    ext = next((e for m, e in MAGIC if img.startswith(m)), None)
    if not ext or (ext == "webp" and img[8:12] != b"WEBP"):
        raise ValueError("원본 그림은 PNG·JPEG·WebP 만 됩니다")
    if len(img) > IMAGE_MAX:
        raise ValueError("원본 그림은 10MB 까지입니다")
    if any(j["who"] == who and j["state"] == "running" for j in list_jobs()):
        raise ValueError(f"「{who}」 를 만드는 작업이 이미 돌고 있습니다")
    return who, {"name": name, "look": look, "notes": notes, "boss": bool(body.get("boss")), "agent": agent,
                 "model": model}, img, ext


def repo_worktree():
    """This repo's main worktree as Orca knows it (the agent runs the scripts from there, changing no file)."""
    real = os.path.realpath(REPO)
    wt = next((w for w in places(fresh=True)["worktrees"] if w["path"] and os.path.realpath(w["path"]) == real), None)
    if not wt:
        raise ValueError(f"Orca 에 이 저장소({REPO})가 등록돼 있어야 합니다")
    return wt


def create(who, f, img, ext):
    """Write the job folder (picture, brief, job.json) and launch the agent. -> the job as list_jobs shows it."""
    wt = repo_worktree()
    jid = f"{who}-{time.strftime('%Y%m%d-%H%M%S')}"
    d = os.path.join(WORK, jid)
    os.makedirs(d)
    ref = os.path.join(d, "ref." + ext)
    with open(ref, "wb") as fh:
        fh.write(img)
    boss = f["boss"]
    with open(os.path.join(d, "brief.md"), "w") as fh:
        fh.write(BRIEF.format(
            name=f["name"], who=who, work=d, ref=ref, repo=REPO, role="코디네이터" if boss else "워커",
            look=f["look"] or "(없음 — 원본에서 읽는다)", notes=f["notes"] or "(없음)",
            boss_line="코디네이터이므로 머리에 `black wireless gaming headset with a small boom microphone worn on the head` 를 넣는다(다른 코디네이터 kaede·yuki 와 같은 표시)." if boss else "워커이므로 헤드셋은 넣지 않는다(헤드셋은 코디네이터 표시).",
            boss_flag=" --boss" if boss else ""))
    label = f"캐릭터 · {f['name']}"
    args = ["agent", "launch", "--worktree", "id:" + wt["id"], "--agent", f["agent"], "--surface", "terminal",
            "--prompt", f"{d}/brief.md 를 읽고 그 순서대로 캐릭터 「{f['name']}」({who})를 만들어 올려 주세요."]
    if f["model"]:
        args += ["--model", f["model"]]
    job = {"id": jid, "who": who, **f, "created": time.time(), "launch": None, "handle": None}
    write_job(d, job)
    job["launch"] = start_launch(args, label, wt["name"])
    write_job(d, job)
    return status(d, job)


def status(d, job):
    """job.json plus where it is: steps done, state running|published|failed (failed.txt, the launch failed, or the
    agent's terminal closed with nothing published), the launch's outcome."""
    w = job["who"]
    done = [k for k, p in STEPS if os.path.exists(os.path.join(d, p.format(w=w)))]
    sheets = [k for k, p in SHEETS.items() if p and os.path.exists(os.path.join(d, p.format(w=w)))]
    error = None
    try:
        with open(os.path.join(d, "failed.txt")) as fh:
            error = fh.read().strip()[:500] or "에이전트가 포기했습니다"
    except OSError:
        pass
    if job.get("launch") and not job.get("handle"):
        with jobs_lock:
            lj = dict(close_jobs.get(job["launch"]) or {})
        if lj.get("state") == "done":
            if lj.get("handle"):
                job["handle"] = lj["handle"]
            else:
                job["launch_error"] = ((lj.get("failed") or [{}])[0].get("error")) or "에이전트를 띄우지 못했습니다"
            write_job(d, job)
    error = error or job.get("launch_error")
    if not error and "published" not in done and job.get("handle") and orca_state.get("terminals") \
            and job["handle"] not in {t["handle"] for t in orca_state["terminals"] if t.get("connected")}:
        error = "에이전트 터미널이 결과 없이 닫혔습니다"
    state = "published" if "published" in done else "failed" if error else "running"
    return {**job, "done": done, "sheets": sheets, "state": state, "error": error,
            "updated": max((os.path.getmtime(os.path.join(d, n)) for n in os.listdir(d)), default=job["created"])}


def list_jobs():
    """Newest first. Finished jobs past KEEP are removed with their folder."""
    out = []
    try:
        names = sorted(os.listdir(WORK), reverse=True)
    except OSError:
        return out
    for n in names:
        d = job_dir(n)
        job = d and read_job(d)
        if not job:
            continue
        s = status(d, job)
        if s["state"] != "running" and time.time() - s["updated"] > KEEP:
            shutil.rmtree(d, ignore_errors=True)
            continue
        out.append(s)
    return out


def sheet_file(jid, kind):
    """-> (bytes, content type) of a job's original picture or one of the sheets the agent drew, or None."""
    d = job_dir(jid)
    job = d and read_job(d)
    if not job or kind not in SHEETS:
        return None
    if kind == "ref":
        name = next((n for n in os.listdir(d) if n.startswith("ref.")), None)
    else:
        name = SHEETS[kind].format(w=job["who"])
    path = name and os.path.join(d, name)
    if not path or not os.path.isfile(path):
        return None
    ext = name.rsplit(".", 1)[1]
    with open(path, "rb") as fh:
        return fh.read(), {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[ext]


def remove(jid):
    """Drop a finished job's folder (a published character stays online: char-publish.py --remove takes it down)."""
    d = job_dir(jid)
    job = d and read_job(d)
    if not job:
        return False
    if status(d, job)["state"] == "running":
        raise ValueError("돌고 있는 작업은 지울 수 없습니다 — Orca 에서 에이전트를 먼저 끝내세요")
    shutil.rmtree(d, ignore_errors=True)
    return True
