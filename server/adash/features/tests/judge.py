"""How a finished test run ended, from its exit code, its cases and its output — shared by atest (at the end of a run)
and the server (old runs recorded before atest judged them).

A non-zero exit is not always a failing test. Besides phase done|failed a run gets a verdict:
  None    passed, or a real failure (a failing case, or an exit no rule below explains)
  "warn"  phase done — every test that ran passed, the runner complained about something else: run-tc IDs it found no
          test for, jest·vitest suites that failed to load while every test passed
  "red"   phase done — failing cases that were meant to fail (atest run --expect-red, run-tc --expect-red, a label with
          "red" or "빨강" in it); --expect-red also fails a run that came out green
  "error" phase failed — no test ran: a usage error, a missing setting, an interrupted run
detail says why in a line.
"""

import os
import re

RED_LABEL = re.compile(r"(?i)\bred\b|빨강")
# run-tc's summary: "run-tc <kind> · 요청 N ID · 통과 P · 실패 F · 로드 오류 L · 미발견 M" (ID mode) or
# "run-tc <kind> · spec <paths> · 통과 P · 실패 F · 로드 오류 L"; then "  <ID>: <판정> (통과 a · 실패 b)" per ID
TC_HEAD = re.compile(r"^run-tc \S+ · (?:요청 \d+ ID|spec .+?) · 통과 (\d+) · 실패 (\d+) · 로드 오류 (\d+)(?: · 미발견 (\d+))?")
TC_ID = re.compile(r"^  (\S+): (통과|실패|로드 실패|결과없음) \(통과 (\d+) · 실패 (\d+)\)")
TC_MISSING = re.compile(r"^  미발견: (.+)")
TC_RED = re.compile(r"빨강 판정: (합격|불합격)(.*)")
SUITE_FAIL = re.compile(r"^\s*FAIL\s+(\S+)")  # jest "FAIL path", vitest " FAIL  path"
TESTS_LINE = re.compile(r"^\s*Tests:?\s+(.+)")  # jest "Tests: 3 failed, 9 passed, 12 total", vitest "Tests  12 passed (12)"
EXIT_DETAIL = re.compile(r"종료 코드 (\d+)")
ERR_LINE = re.compile(r"^\s*(?:run-tc: |\w*Error: |error: |Could not |No tests found)")


def read_log(path, limit=400_000):
    """The log's last `limit` bytes as text ('' when unreadable)."""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - limit))
            return f.read().decode(errors="replace")
    except (OSError, TypeError):
        return ""


def why_none_ran(log):
    """The output's first error line, else its last line: why a run ran no test."""
    lines = log.splitlines()
    for line in [*filter(ERR_LINE.match, lines), *reversed(lines)]:
        line = line.strip()
        if line and not line.startswith("로그:"):
            return line[:200]
    return None


def run_tc_cases(lines, have):
    """Cases run-tc's per-ID summary adds to the ✗ lines atest already read: passed IDs, IDs with no result or no test."""
    out, any_failed = [], any(c.get("status") == "failed" for c in have)
    for line in lines:
        m, miss = TC_ID.match(line), TC_MISSING.match(line)
        if m:
            tid, word, a, b = m.group(1), m.group(2), m.group(3), m.group(4)
            if word == "통과":
                out.append({"id": tid, "title": f"통과 {a}", "status": "passed"})
            elif word == "결과없음":
                out.append({"id": tid, "title": "결과 없음", "status": "skipped", "msg": "결과없음"})
            elif not any_failed:  # no ✗ line named the failing tests
                out.append({"id": tid, "title": f"{word} · 통과 {a} · 실패 {b}", "status": "failed", "msg": word})
        elif miss:
            out += [{"id": tid, "title": "테스트 미발견", "status": "skipped", "msg": "미발견"} for tid in miss.group(1).split()]
    ids = {c.get("id") for c in have}
    return [c for c in out if c["id"] not in ids]


def judge(code, cases, log, label="", expect_red=False):
    """-> (phase, verdict, detail, extra cases). code may be None (unknown, an old record)."""
    lines = log.splitlines()
    head = next((m for m in map(TC_HEAD.match, reversed(lines)) if m), None)
    extra = run_tc_cases(lines[lines.index(head.string):], cases) if head else []
    cs = list(cases) + extra
    failed = sum(c.get("status") in ("failed", "interrupted") for c in cs)
    passed = sum(c.get("status") == "passed" for c in cs)
    red = next((m for m in map(TC_RED.search, reversed(lines)) if m), None)
    if red:  # run-tc --expect-red judges itself
        return ("done", "red", "의도한 빨강 확인" + red.group(2), extra) if red.group(1) == "합격" \
            else ("failed", None, "빨강이어야 하는데 " + red.group(2).strip(" —"), extra)
    if failed and (expect_red or RED_LABEL.search(label or "")):  # the label only explains a red run, never fails a green one
        return "done", "red", f"의도한 빨강 확인 · 실패 {failed}", extra
    if expect_red and (passed or not code):
        return "failed", None, "빨강이어야 하는데 실패 0", extra
    if not code and not failed:
        return "done", None, None, extra
    if failed:
        return "failed", None, None, extra
    if head and not int(head.group(2)) and not int(head.group(3)) and int(head.group(4) or 0) and int(head.group(1)):
        missing = [c["id"] for c in cs if c.get("msg") == "미발견"]
        return "done", "warn", f"미발견 {' '.join(missing)} · 나머지 통과 {head.group(1)}", extra
    suites = list(dict.fromkeys(m.group(1) for m in map(SUITE_FAIL.match, lines) if m))
    tests = next((m.group(1) for m in map(TESTS_LINE.match, reversed(lines)) if m), "")
    if passed and suites and "failed" not in tests:
        names = ", ".join(os.path.basename(s) for s in suites[:3]) + (f" 외 {len(suites) - 3}" if len(suites) > 3 else "")
        return "done", "warn", f"로드 실패 스위트 {len(suites)}개({names}) · 테스트는 전부 통과", extra
    if not passed:
        return "failed", "error", why_none_ran(log) or (f"종료 코드 {code}" if code else "실행된 테스트 없음"), extra
    return "failed", None, f"종료 코드 {code}" if code else None, extra


def rejudge(r):
    """An old record (test-history entry or progress file) judged again; r itself when nothing changes."""
    if r.get("judged") or r.get("phase") != "failed":
        return r
    if r.get("src") == "run-tc":  # run-tc's own E2E runs: an interrupted one ran no test
        if not r.get("failed") and re.search("중단", str(r.get("detail") or "")):
            return {**r, "verdict": "error", "judged": True}
        return {**r, "judged": True}
    m = EXIT_DETAIL.search(str(r.get("detail") or ""))
    code = r.get("exit", int(m.group(1)) if m else 1)  # recorded as failed: a non-zero exit when the detail does not say
    log = read_log(r.get("log"))
    if not log:  # a hand-written result, or its log is gone: as recorded
        return {**r, "judged": True}
    phase, verdict, detail, extra = judge(code, r.get("cases") or [], log, r.get("label") or "")
    cases = (r.get("cases") or []) + extra
    n = lambda *s: sum(c.get("status") in s for c in cases)
    out = {**r, "phase": phase, "verdict": verdict, "detail": detail or r.get("detail"), "judged": True}
    if extra:
        out.update(cases=cases, passed=n("passed"), failed=n("failed", "interrupted"), pending=n("skipped") or None,
                   total=len(cases), done=n("passed", "failed", "skipped", "interrupted"))
    return out
