"""Typing answers into Claude Code's terminal picker, key by key."""

import re
import time

from adash.core.orca import orca


TYPED = re.compile(r"^[^\x00-\x1f\x7f]{1,500}$")  # typed text goes into the picker's input line: no control keys


def check_answers(card, answers):
    """The page's answers in question order (a label or typed text; a list of labels, at most one typed, for
    multiSelect) -> the same, trimmed; or an error string for one missing or one the picker cannot take by key."""
    if len(answers) != len(card["questions"]):
        return "답하지 않은 질문이 있습니다"
    out = []
    for q, a in zip(card["questions"], answers):
        labels = [o["label"] for o in q["options"]]
        picks = a if q["multiSelect"] else [a]
        if not (isinstance(picks, list) and picks and all(isinstance(x, str) and x.strip() for x in picks)):
            return "답하지 않은 질문이 있습니다"
        picks = list(dict.fromkeys(x.strip() for x in picks))
        typed = [x for x in picks if x not in labels]
        # a picker with previews has no typed row
        if len(labels) + 1 > 9 or len(typed) > (0 if q["preview"] else 1) or not all(TYPED.match(x) for x in typed):
            return "이 답은 대시보드에서 넣을 수 없습니다 — 터미널에서 답하세요"
        out.append(picks if q["multiSelect"] else picks[0])
    return out


# The picker as Claude Code draws it (checked against v2.1): a tab bar ("←  ☐ 색  ☒ 과일  ✔ Submit  →", or a single
# "☐ 색"), the question, numbered rows ("❯ 1. [✔] 사과" for multiSelect, "  2. 초록" otherwise; the row after the
# options is "Type something"), and a footer ending in "Esc to cancel". Several questions end in a review page
# ("Ready to submit your answers?"). Digit keys pick a single-choice option (and move on) or toggle a multiSelect
# one; on the typed row the keys go into its input line; → leaves a multiSelect question (but moves the text cursor
# on the typed row); Enter takes a single-choice typed row. Options with a preview are drawn beside a preview box
# ("❯ 1. 왼쪽      ┌───┐", checked against v2.1.303) with no typed row; there a digit only moves the cursor and
# Enter picks.
# Text sent in one write arrives as a paste, so each key goes on its own.
PICK_ROW = re.compile(r"^\s*(❯)?\s*(\d)\.\s(?:\[(.)\]\s)?(.*)$")
KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_ENTER = "\x1b[C", "\x1b[A", "\x1b[B", "\r"
PICK_STEP_S = 4  # how long one key may take to show on the screen


class PickerError(Exception):
    pass


class PickerGone(PickerError):
    """No picker on the screen at all: the question was closed (answered or cancelled) before the transcript said so."""


def compact(s):
    return re.sub(r"\s+", "", s)


def picker_state(handle, card):
    """The terminal's rendered screen -> {"kind": "gone", "answered": the screen shows answers sent} (no picker),
    {"kind": "review"}, {"kind": "other"}, or
    {"kind": "question", "qi", "answered": a question already has its tab ticked, "rows": {n: (text, checked)},
    "cursor": n}."""
    t = orca("terminal", "read", "--terminal", handle, "--screen", timeout=10)["terminal"]
    if t.get("source") != "screen":
        raise PickerError("터미널 화면을 읽지 못했습니다")
    lines = t["tail"] if isinstance(t["tail"], list) else str(t["tail"]).splitlines()
    if any("Ready to submit your answers?" in ln for ln in lines[-12:]):
        return {"kind": "review"}  # it has no footer
    foot = max((i for i, ln in enumerate(lines) if "Esc to cancel" in ln), default=None)
    if foot is None:
        return {"kind": "gone", "answered": any("User answered Claude's question" in ln for ln in lines)}
    head = next((i for i in range(foot, -1, -1) if "☐" in lines[i] or "☒" in lines[i]), None)
    if head is None:
        return {"kind": "other"}
    body = lines[head + 1:foot]
    rows, cursor, first = {}, None, None
    for i, ln in enumerate(body):
        m = PICK_ROW.match(ln)
        if not m:
            continue
        n = int(m[2])
        if n == 1 and first is None:
            first = i
        if first is not None and n not in rows:
            rows[n] = (m[4].strip(), m[3] not in (None, " "))
            cursor = n if m[1] else cursor
    if first is None:
        return {"kind": "other"}
    text = compact("".join(re.sub(r"^\s*│", "", ln) for ln in body[:first]))  # v2.1.3xx rules the question off with "│"
    qi = next((i for i, q in enumerate(card["questions"]) if compact(q["question"]) == text), None)
    if qi is None:
        return {"kind": "other"}
    return {"kind": "question", "qi": qi, "answered": "☒" in lines[head], "rows": rows, "cursor": cursor}


def type_answers(handle, card, answers):
    """Drive the picker in `handle` to `answers` (from check_answers). Raises PickerError, leaving the picker open,
    when the screen is not the fresh picker for this card or stops matching what was typed."""
    def press(key):
        orca("terminal", "send", "--terminal", handle, "--text", key, timeout=10)
        time.sleep(0.15)

    def until(ok, what):
        end = time.time() + PICK_STEP_S
        while True:
            st = picker_state(handle, card)
            if ok(st):
                return st
            if time.time() > end:
                raise PickerError(what)
            time.sleep(0.25)

    def sent(st):  # read twice: a frame caught mid-redraw has no footer either
        if st["kind"] != "gone" or not st["answered"]:
            return False
        time.sleep(0.3)
        st = picker_state(handle, card)
        return st["kind"] == "gone" and st["answered"]

    on = lambda qi: lambda s: s["kind"] == "question" and s["qi"] == qi
    try:
        st = until(lambda s: s["kind"] in ("question", "review"), "터미널에 이 질문의 선택기가 떠 있지 않습니다")
    except PickerError:
        if picker_state(handle, card)["kind"] == "gone":  # another question's picker ("other") may be a misread: kept
            raise PickerGone("터미널에 이 질문의 선택기가 없습니다. 이미 닫힌 질문이라 카드를 치웠습니다")
        raise
    if st["kind"] == "review" or st["qi"] or st["answered"] or any(c for _, c in st["rows"].values()):
        raise PickerError("터미널에서 이미 답하기 시작했습니다")
    last = len(card["questions"]) - 1
    for qi, (q, a) in enumerate(zip(card["questions"], answers)):
        labels, n = [o["label"] for o in q["options"]], len(q["options"])
        if q["multiSelect"]:
            typed = [x for x in a if x not in labels]
            want = {labels.index(x) + 1 for x in a if x in labels} | ({n + 1} if typed else set())
            for k in sorted(want):
                press(str(k))
            if typed:
                for _ in range(n + 1 - (st["cursor"] or 1)):
                    press(KEY_DOWN)
                until(lambda s: on(qi)(s) and s["cursor"] == n + 1, "직접 입력 칸으로 가지 못했습니다")
                press(typed[0])
            until(lambda s: on(qi)(s) and {k for k, (_, c) in s["rows"].items() if c} == want
                  and (not typed or compact(typed[0]).startswith(compact(s["rows"].get(n + 1, ("", False))[0]) or "-")),
                  "터미널의 선택이 보낸 답과 다릅니다")
            if typed:  # → only moves within the input line: step off it first
                press(KEY_UP)
                until(lambda s: on(qi)(s) and s["cursor"] == n, "직접 입력 칸에서 나오지 못했습니다")
            press(KEY_RIGHT)
        elif a in labels:
            k = labels.index(a) + 1
            press(str(k))
            if q["preview"]:
                until(lambda s: on(qi)(s) and s["cursor"] == k, "선택지로 가지 못했습니다")
                press(KEY_ENTER)
        else:
            press(str(n + 1))
            until(lambda s: on(qi)(s) and s["cursor"] == n + 1, "직접 입력 칸으로 가지 못했습니다")
            press(a)
            until(lambda s: on(qi)(s) and compact(a).startswith(compact(s["rows"].get(n + 1, ("", False))[0]) or "-"),
                  "직접 입력한 글이 터미널에 들어가지 않았습니다")
            press(KEY_ENTER)
        # The next question, the review page or, after the last one, the picker closing on its own.
        st = until(lambda s: (s["kind"] == "question" and s["qi"] > qi) or (qi == last and (s["kind"] == "review" or sent(s))),
                   "터미널이 다음 단계로 넘어가지 않았습니다")
    if st["kind"] == "review":
        press("1")  # "1. Submit answers"
        until(sent, "답을 제출하지 못했습니다")
