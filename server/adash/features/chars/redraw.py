"""The 「캐릭터」 tab's management: redraw one sheet of a person (a kind, a set) and put them up again, and change a
person's name, look and role. Every person's sheets live in STORE, one shared folder (names start with <who>_ or
<who>-): the regenerated ones are there, and a person made from the page joins it from their job folder the first time
they are redrawn. A redraw runs scripts/char-gen.sh <who> <kind> STORE <set> (Codex draws the sheet, the four are cut
again) and then scripts/char-publish.py, so the new strips go up to R2 — for a built-in person too, over the deployed
ones — and every page shows them on its next read of chars.json. One redraw a person at a time; how it went is kept in
memory (REDRAWS) for the page to poll."""

import glob
import os
import shutil
import subprocess
import threading
import time

from adash.features.chars.jobs import BUILTIN, REPO, STORE, WHO, job_dir, keep_sheets, list_jobs, publish_script

KINDS, SETS = ("full", "bust", "sd"), "abcd"
STRIPS = ("{w}-full.webp", "{w}-bust.webp", "{w}-sd.png", "{w}-sd-bust.png")
REDRAWS, lock = {}, threading.Lock()


def sheet(who, kind, s):
    return f"{who}_{kind}.png" if s == "a" else f"{who}_{kind}_{s}.png"


def own_files(who):
    """Every file of this person in STORE: the 12 sheets and the run and done ones, the 4 strips and the motions', the
    description and the original picture."""
    names = ([sheet(who, k, s) for k in KINDS + ("run", "done") for s in SETS] + [p.format(w=who) for p in STRIPS]
             + [f"{who}-sd{b}-{m}.png" for b in ("", "-bust") for m in ("run", "done")] + [f"{who}-desc.txt"])
    return [os.path.join(STORE, n) for n in names] + glob.glob(os.path.join(STORE, glob.escape(who) + "-ref.*"))


def gather(who):
    """Make STORE hold this person's sheets and strips, from their newest published job folder or (a built-in person)
    the deployed strips. -> None, or why they cannot be redrawn."""
    os.makedirs(STORE, exist_ok=True)
    have = lambda: all(os.path.exists(os.path.join(STORE, sheet(who, k, s))) for k in KINDS for s in SETS)
    if not have():
        for j in list_jobs():
            d = job_dir(j["id"])
            if j["who"] != who or j["state"] != "published" or not d:
                continue
            keep_sheets(d, who)
            break
    if not have():
        return "시트 원본(세트 A~D)이 없어 다시 그릴 수 없습니다 — 「새 캐릭터」로 다시 만드세요"
    for p in STRIPS:
        n = p.format(w=who)
        if not os.path.exists(os.path.join(STORE, n)) and who in BUILTIN:
            shutil.copy2(os.path.join(REPO, "frontend/chars", n), STORE)
    if who not in BUILTIN and not os.path.exists(os.path.join(STORE, f"{who}-desc.txt")):
        return "생김새 설명(desc.txt)이 없어 다시 그릴 수 없습니다"
    return None


def env_for(who):
    """launchd's PATH has Homebrew (codex) but not nvm's node (wrangler's npx: char-publish.py finds it); an added person
    is drawn from their description, the first sheet from their original picture."""
    e = dict(os.environ)
    if who not in BUILTIN:
        with open(os.path.join(STORE, f"{who}-desc.txt")) as fh:
            e["CHAR_DESC"] = fh.read().strip()
        ref = glob.glob(os.path.join(STORE, glob.escape(who) + "-ref.*"))
        if ref:
            e["CHAR_REF"] = ref[0]
    e["CHAR_OUT"] = STORE
    return e


def run(who, kind, s, name, look, boss):
    log = os.path.join(STORE, f".redraw-{who}.log")
    py = subprocess.run([os.path.join(REPO, "scripts/char-python.sh")], capture_output=True, text=True, timeout=300).stdout.strip()
    steps = [[os.path.join(REPO, "scripts/char-gen.sh"), who, kind, STORE, s],
             [py or "python3", os.path.join(REPO, "scripts/char-publish.py"), who, "--name", name, "--look", look, "--dir", STORE]
             + (["--boss"] if boss else [])]
    err = None
    try:
        with open(log, "w") as fh:
            for i, cmd in enumerate(steps):
                with lock:
                    REDRAWS[who]["step"] = ("draw", "publish")[i]
                r = subprocess.run(cmd, cwd=STORE, env=env_for(who), stdout=fh, stderr=subprocess.STDOUT, timeout=1800)
                if r.returncode:
                    err = "그리지 못했습니다" if i == 0 else "올리지 못했습니다"
                    break
    except (OSError, subprocess.TimeoutExpired) as e:
        err = f"멈췄습니다: {e}"
    if err:
        try:
            with open(log) as fh:
                tail = [x.strip() for x in fh.read().splitlines() if x.strip()]
            err += " — " + (tail[-1][:200] if tail else "기록 없음")
        except OSError:
            pass
    with lock:
        REDRAWS[who].update(state="failed" if err else "done", error=err, ended=time.time())


def start(who, kind, s, name, look, boss):
    """Redraw <who>'s <kind> sheet of set <s> and put them up again, in the background. -> the redraw's entry, or
    ValueError why not."""
    if not (isinstance(who, str) and WHO.fullmatch(who)) or kind not in KINDS or s not in tuple(SETS):
        raise ValueError("잘못된 요청입니다")
    if not isinstance(name, str) or not name.strip() or len(name) > 20 or not isinstance(look, str) or len(look) > 80:
        raise ValueError("표시 이름은 1~20자, 생김새는 80자까지입니다")
    with lock:
        if REDRAWS.get(who, {}).get("state") == "running":
            raise ValueError("이 캐릭터를 이미 다시 그리는 중입니다")
    why = gather(who)
    if why:
        raise ValueError(why)
    entry = {"who": who, "kind": kind, "set": s, "state": "running", "step": "draw", "error": None, "started": time.time(), "ended": None}
    with lock:
        REDRAWS[who] = entry
    threading.Thread(target=run, args=(who, kind, s, name.strip(), look.strip(), bool(boss)), daemon=True).start()
    return dict(entry)


def list_redraws():
    with lock:
        return [dict(x) for x in REDRAWS.values()]


def set_meta(who, name, look, boss):
    """Name, look and role, everywhere (char-publish.py --meta)."""
    if not isinstance(name, str) or not isinstance(look, str) or "'" in name + look:
        raise ValueError("작은따옴표(') 는 쓸 수 없습니다")
    publish_script(who, "--meta", "--name", name.strip(), "--look", look.strip(), *(["--boss"] if boss else []))


def forget(who):
    """A person deleted for good leaves STORE too."""
    for p in own_files(who):
        try:
            os.remove(p)
        except OSError:
            pass
    with lock:
        REDRAWS.pop(who, None)
