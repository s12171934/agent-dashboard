"""Which lines of which files a shell command read (cat, sed, grep, …)."""

import collections
import os
import re
import shlex

from adash.core.config import HOME
from adash.features.designs.index import design_key
from adash.features.designs.store import design_bases
from adash.features.designs.toc import FENCE, HEADING, design_toc


# ---- reading references out of tool calls ----
READ_LINE = re.compile(r"^\s*(\d+)(?:\t|→)(.*)$")  # Claude's Read result: "<n>\t<line>" (older builds: "<n>→")
HIT_LINE = re.compile(r"^(.*?):(\d+)[:-]")          # grep -n / rg -n output: "<path>:<n>:<text>" ("-" on context lines)
BARE_HIT = re.compile(r"^(\d+)[:-]")                # the same for a single file: "<n>:<text>"
SED_RANGE = re.compile(r"^\s*(\d+|\$)?\s*(?:,\s*(\d+|\$)\s*)?(?:p|\{\s*p\s*;?\s*\})\s*$")
JS_CMD = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
READERS = {"cat", "nl", "sed", "head", "tail", "awk", "less", "more", "bat", "batcat"}
SEARCHERS = {"grep", "egrep", "fgrep", "rg", "ag", "ack"}
QUIET = {"apply_patch", "cp", "mv", "rm", "tee", "ls", "wc", "find", "stat", "file", "test", "[", "echo", "printf", "git", "mkdir", "cd", "du", "readlink",
         "realpath", "basename", "dirname", "open", "true", "aplan", "orca", "touch", "diff", "cmp", "md5", "shasum"}
TOC_PATTERN = re.compile(r"^\^?\s*(?:\\)?#")  # grep '^## ' and the like: reading the table of contents, not a search
SHELL_STOP = {";", "&&", "||", "&", "(", ")", "{", "}", "|", "|&"}
SHELL_KEYWORDS = {"then", "do", "else", "elif", "fi", "done", "if", "while", "until", "time", "!", "command", "builtin", "exec", "xargs"}


def unquote_newlines(cmd):
    """Unquoted newlines become `;` (shlex treats them as blanks), heredoc bodies are dropped, a trailing \\ joins lines."""
    out, q, i, n = [], None, 0, len(cmd)
    while i < n:
        c = cmd[i]
        if q:
            if c == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if c == q:
                q = None
            out.append(c)
        elif c == "\\" and i + 1 < n:
            out.append(" " if cmd[i + 1] == "\n" else cmd[i:i + 2]); i += 2; continue
        elif c in "'\"":
            q = c; out.append(c)
        elif c == "#" and (not out or out[-1] in " \t;\n"):
            j = cmd.find("\n", i); i = n if j < 0 else j; continue
        elif c == "<" and cmd.startswith("<<", i) and not cmd.startswith("<<<", i):
            m = re.match(r"<<-?\s*(['\"]?)(\w+)\1", cmd[i:])
            if m:
                end = re.compile(r"\n[ \t]*" + re.escape(m.group(2)) + r"[ \t]*(?:\n|$)").search(cmd, i + m.end())
                line_end = cmd.find("\n", i + m.end())
                rest = cmd[i + m.end():line_end if line_end >= 0 else n]
                out.append(" " + rest + " ;")  # the rest of the heredoc's own line still runs (`<<EOF | cmd`)
                i = end.end() if end else n
                continue
            out.append(c)
        elif c == "\n":
            out.append(" ; ")
        else:
            out.append(c)
        i += 1
    return "".join(out)


def shell_commands(cmd):
    """[[argv, ...] per pipeline] for a shell command line; None when it does not parse."""
    try:
        lx = shlex.shlex(unquote_newlines(cmd), posix=True, punctuation_chars=";&|()<>")
        lx.whitespace_split = True
        toks = list(lx)
    except ValueError:
        return None
    pipes, pipe, argv = [], [], []
    for t in toks + [";"]:
        if t in SHELL_STOP:
            if argv:
                pipe.append(argv)
            argv = []
            if t not in ("|", "|&") and pipe:
                pipes.append(pipe)
                pipe = []
        elif t in ("<", ">", ">>", "2>", "&>", "2>&1", ">&"):
            argv.append(t)
        else:
            argv.append(t)
    return pipes


def expand(tok, env, cwd, soft=False):
    """$NAME / ${NAME} / ~ / $HOME in a token; None when a shell variable or a command substitution stays unresolved
    ($0, $1 … are left alone: inside an awk or sed script they are not the shell's). soft leaves those in place."""
    tok = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: env.get(m.group(1), HOME if m.group(1) == "HOME" else m.group(0)), tok)
    if tok.startswith("~"):
        tok = HOME + tok[1:]
    return tok if soft or not re.search(r"\$\{?[A-Za-z_(]|`", tok) else None


def line_ranges_of_sed(scripts):
    """Line ranges a `sed -n` script prints: "a,bp", "ap", "a,${p}" and ;-separated lists. None when it prints others."""
    out = []
    for s in scripts:
        for part in re.split(r"[;\n]", s):
            if not part.strip():
                continue
            m = SED_RANGE.match(part)
            if not m or not m.group(1):
                return None
            a = 10 ** 9 if m.group(1) == "$" else int(m.group(1))
            b = a if m.group(2) is None else (10 ** 9 if m.group(2) == "$" else int(m.group(2)))
            out.append((a, b))
    return out or None


def awk_ranges(script):
    lo = re.search(r"NR\s*(>=|>|==)\s*(\d+)", script)
    hi = re.search(r"NR\s*(<=|<)\s*(\d+)", script)
    pair = re.search(r"NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)", script)
    if pair:
        return [(int(pair.group(1)), int(pair.group(2)))]
    if not lo and not hi:
        return None if re.search(r"NR\s*[<>=!]", script) else [(1, 10 ** 9)]  # NR only printed: every line
    a = (int(lo.group(2)) + (lo.group(1) == ">")) if lo else 1
    b = (int(hi.group(2)) - (hi.group(1) == "<")) if hi else 10 ** 9
    if lo and lo.group(1) == "==" and not hi:
        b = a
    return [(a, b)]


def count_arg(args, i, default):
    """-n N / -nN / -N / -n +K for head and tail: (count, from_start)."""
    a = args[i]
    if a in ("-n", "--lines") and i + 1 < len(args):
        v = args[i + 1]
    elif a.startswith("--lines="):
        v = a.split("=", 1)[1]
    elif a.startswith("-n"):
        v = a[2:]
    elif re.match(r"^-\d+$", a):
        v = a[1:]
    else:
        return default
    m = re.match(r"^(\+)?(\d+)$", v)
    return (int(m.group(2)), bool(m.group(1))) if m else default


def apply_filter(argv, ranges, length):
    """Narrow line ranges by a filter later in a pipeline (sed -n, head, tail, awk NR); None when the filter is not one."""
    name = os.path.basename(argv[0])
    lines = [n for a, b in ranges for n in range(a, min(b, length) + 1)]
    if name == "sed" and "-n" in argv:
        rs = line_ranges_of_sed([x for x in argv[1:] if not x.startswith("-")][:1])
        if rs is None:
            return None
        picked = [lines[k - 1] for a, b in rs for k in range(a, min(b, len(lines)) + 1)]
    elif name in ("head", "tail"):
        n, plus = (10, False)
        for i in range(1, len(argv)):
            n, plus = count_arg(argv, i, (n, plus))
        picked = lines[:n] if name == "head" else lines[n - 1:] if plus else lines[-n:] if n else []
    elif name == "awk":
        rs = awk_ranges(next((x for x in argv[1:] if not x.startswith("-")), ""))
        if rs is None:
            return None
        picked = [lines[k - 1] for a, b in rs for k in range(a, min(b, len(lines)) + 1)]
    elif name in ("cut", "tr", "fold", "less", "more", "cat", "expand", "column", "nl") or name == "sed" and "-n" not in argv:
        return ranges  # one line out per line in (sed without -n only rewrites them)
    else:
        return None
    return to_ranges(picked)


def to_ranges(nums):
    out = []
    for n in sorted(set(nums)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return [tuple(r) for r in out]


def design_file_lines(path):
    """Line count of a file (for open-ended ranges); 0 when unreadable."""
    if path.endswith(".md"):
        return design_toc(path)[1]
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def grep_regex(argv, tool):
    """(compiled pattern, files and folders, listing only, raw pattern) from a grep/rg argv; the pattern is None when
    it is not usable."""
    pat, paths, fixed, icase, word, ere, listing = None, [], False, False, False, tool != "grep", False
    i = 1
    takes = {"-e", "--regexp", "-g", "--glob", "-t", "--type", "-A", "-B", "-C", "-m", "--max-count", "--include",
             "--exclude", "-f", "--max-columns", "--context", "--after-context", "--before-context", "-M", "-T"}
    while i < len(argv):
        a = argv[i]
        if a == "--":
            paths += argv[i + 1:] if pat is not None else argv[i + 2:]
            pat = pat if pat is not None else (argv[i + 1] if i + 1 < len(argv) else None)
            break
        if a in ("-e", "--regexp") and i + 1 < len(argv):
            pat = argv[i + 1]; i += 2; continue
        if a in takes:
            i += 2; continue
        if a.startswith("--"):
            fixed |= a == "--fixed-strings"; icase |= a == "--ignore-case"; word |= a == "--word-regexp"
            listing |= a in ("--files", "--files-with-matches", "--count", "--files-without-match")
            ere |= a in ("--extended-regexp", "--perl-regexp")
        elif a.startswith("-") and len(a) > 1:
            fl = a[1:]
            fixed |= "F" in fl; icase |= "i" in fl; word |= "w" in fl; ere |= "E" in fl or "P" in fl
            listing |= any(c in fl for c in "lLc")
        elif pat is None:
            pat = a
        else:
            paths.append(a)
        i += 1
    if "--files" in argv:
        return None, paths, True, None
    if pat is None:
        return None, paths, listing, None
    if fixed:
        rx = re.escape(pat)
    elif not ere:  # grep's basic syntax: \| \( \) \+ \? are the operators, the bare characters are literal
        rx = re.sub(r"\\([|()+?{}])|([|()+?{}])", lambda m: m.group(1) or "\\" + m.group(2), pat)
    else:
        rx = pat
    if word:
        rx = r"\b(?:" + rx + r")\b"
    try:
        return re.compile(rx, re.I if icase else 0), paths, listing, pat
    except re.error:
        return None, paths, listing, pat


def hits_in(path, rx):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return [n for n, line in enumerate(f, 1) if rx.search(line)]
    except OSError:
        return []


def search_reads(rx, targets, out, cwd, single):
    """Search hits from a grep/rg run: the numbered lines of its output when it printed numbers, else the pattern run
    again over the design files it named (or listed). -> [read]"""
    found = collections.defaultdict(set)
    if out:
        for line in out.splitlines():
            m = HIT_LINE.match(line)
            if m and not BARE_HIT.match(line):
                p = os.path.normpath(os.path.join(cwd or "/", os.path.expanduser(m.group(1))))
                if design_key(p):
                    found[p].add(int(m.group(2)))
            elif single and BARE_HIT.match(line):
                found[single].add(int(BARE_HIT.match(line).group(1)))
    exact = bool(found)
    if not found and rx is not None:
        files = set()
        if out:
            for line in out.splitlines():
                p = os.path.normpath(os.path.join(cwd or "/", os.path.expanduser(line.split(":", 1)[0].strip())))
                if design_key(p) and os.path.isfile(p):
                    files.add(p)
        if not files:
            files = {t for t in targets if os.path.isfile(t) and design_key(t)}
        for p in files:
            hs = hits_in(p, rx)
            if hs:
                found[p].update(hs)
    return [{"abs": p, "kind": "search", "hits": sorted(ns), "exact": exact} for p, ns in found.items()]


def unroll_loops(pipes):
    """`for NAME in w1 w2 …; do BODY; done` becomes NAME=w1 BODY NAME=w2 BODY …, so a read of "$D/$NAME" can be
    followed. A loop over a glob or a command's output is left as it is (its reads count as missed)."""
    out, k = [], 0
    while k < len(pipes):
        pipe = pipes[k]
        k += 1
        head = pipe[0][1:] if pipe[0][:1] in (["do"], ["then"]) else pipe[0]
        if head[:1] != ["for"] or len(head) < 3 or head[2] != "in" or any(c in w for w in head[3:] for c in "*?[`$(") or len(head) > 60:
            out.append(pipe)
            continue
        name, words, depth, body = head[1], head[3:], 1, []
        while k < len(pipes):
            p2 = pipes[k]
            k += 1
            h = p2[0][1:] if p2[0][:1] == ["do"] else p2[0]
            depth += h[:1] == ["for"]
            depth -= h[:1] == ["done"]
            if depth == 0:
                break
            body.append(p2)
        body = unroll_loops(body)
        for w in words:
            out.append([[f"{name}={w}"]])
            out.extend(body)
    return out


def shell_reads(cmd, cwd, out, stats):
    """Design reads in a shell command (Bash, Codex exec): [{abs, kind, ranges|hits, exact}], approximate by nature.
    A command that names a design path but cannot be followed (a loop variable, a script, an unresolved $VAR) is
    counted in stats[reason]."""
    if not isinstance(cmd, str) or not cmd.strip():
        return []
    pipes = shell_commands(cmd)
    if pipes is None:
        if any(b in cmd for b in design_bases):
            stats["해석 불가"] += 1
        return []
    env, reads, loop, talkers = {}, [], 0, 0
    for pipe in unroll_loops(pipes):
        first = pipe[0]
        while first and re.match(r"^[A-Za-z_]\w*=", first[0]):  # NAME=value [command]
            k, v = first[0].split("=", 1)
            v = expand(v, env, cwd)
            if v is not None:
                env[k] = v
            first = first[1:]
        while first and first[0] in SHELL_KEYWORDS:
            first = first[1:]
        if not first:
            continue
        if first[0] == "for":
            loop += 1
        if first[0] == "done":
            loop = max(0, loop - 1)
        argv = [expand(t, env, cwd) for t in first]
        name = os.path.basename(argv[0] or "")
        if name == "cd":
            target = argv[1] if len(argv) > 1 else HOME
            if target:
                cwd = os.path.normpath(os.path.join(cwd or "/", target))
            continue
        talkers += 1  # a command that may print: the output belongs to one read only when it is the only one
        named = [t for t in (expand(t, env, cwd, True) for t in first) if any("/" + b + "/" in "/" + t or t.startswith(b) for b in design_bases)]
        in_design = cwd and design_key(os.path.join(cwd, "x.md"))
        if not named and not in_design:
            continue
        if loop:
            stats["반복문 변수"] += 1 if named else 0
            continue
        if None in argv:
            if named:
                stats["풀지 못한 변수"] += 1
            continue
        resolve = lambda t: os.path.normpath(os.path.join(cwd or "/", t))
        if name in SEARCHERS:
            rx, targets, listing, pat = grep_regex(argv, name)
            if rx is None and listing:
                continue  # rg --files / grep -l with nothing to search for: a listing
            if TOC_PATTERN.match(pat or ""):
                stats["목차 조회"] += 1
                continue
            targets = [resolve(t) for t in targets] or [cwd or "/"]
            single = targets[0] if len(targets) == 1 and os.path.isfile(targets[0]) else None
            reads += search_reads(rx, targets, out, cwd, single)
            continue
        if name == "git" and "show" in argv:
            stats["git show"] += 1 if named else 0
            continue
        if name not in READERS:
            if named and name not in QUIET:
                stats["읽기 외 명령 (" + (name if re.match(r"^[\w.+-]{1,24}$", name) else "기타") + ")"] += 1
            continue
        # a reader: its file arguments and the line ranges it prints
        args = argv[1:]
        files, ranges = [], [(1, 10 ** 9)]
        if name == "sed":
            scripts, i, quiet = [], 0, False
            while i < len(args):
                a = args[i]
                if a in ("-e", "--expression") and i + 1 < len(args):
                    scripts.append(args[i + 1]); i += 2; continue
                if a.startswith("-") and a != "-":
                    quiet |= "n" in a.lstrip("-") and not a.startswith("--")
                    i += 1; continue
                if not scripts:
                    scripts.append(a)
                else:
                    files.append(a)
                i += 1
            if quiet:
                ranges = line_ranges_of_sed(scripts)
                if ranges is None:
                    stats["sed 스크립트"] += 1
                    continue
        elif name in ("head", "tail"):
            n, plus = (10, False)
            for i, a in enumerate(args):
                n, plus = count_arg(args, i, (n, plus))
            skip = False
            for i, a in enumerate(args):
                if skip:
                    skip = False
                    continue
                if a in ("-n", "--lines", "-c", "--bytes"):
                    skip = True
                    continue
                if not a.startswith("-") or a == "-":
                    files.append(a)
            ranges = [("head", n)] if name == "head" else [("tail", n, plus)]
        elif name == "awk":
            script, i = None, 0
            while i < len(args):
                a = args[i]
                if a in ("-v", "-F", "-f") and i + 1 < len(args):
                    if a == "-v" and "=" in args[i + 1]:
                        k, v = args[i + 1].split("=", 1)
                        env["awk:" + k] = v
                    i += 2; continue
                if script is None:
                    script = a
                else:
                    files.append(a)
                i += 1
            script = re.sub(r"\b([A-Za-z_]\w*)\b", lambda m: env.get("awk:" + m.group(1), m.group(1)), script or "")
            ranges = awk_ranges(script)
            if ranges is None:
                stats["awk 스크립트"] += 1
                continue
        else:
            files = [a for a in args if not a.startswith("-") or a == "-"]
        files = [resolve(f) for f in files if f != "-"]
        if len(files) != 1 and len(pipe) > 1:
            if named:
                stats["여러 파일 파이프"] += 1
            continue
        for f in files:
            if not design_key(f):
                continue
            length = design_file_lines(f)
            rs = []
            for r in ranges:
                if r[0] == "head":
                    rs.append((1, r[1]))
                elif r[0] == "tail":
                    rs.append((r[1], length) if r[2] else (max(1, length - r[1] + 1), length))
                else:
                    rs.append(r)
            rs = [(max(1, a), min(b, length)) for a, b in rs if a <= length]
            searched = False
            for later in pipe[1:]:
                later = [expand(t, env, cwd) for t in later]
                if None not in later and os.path.basename(later[0]) in SEARCHERS and rs:
                    rx, _, _, pat = grep_regex(later, os.path.basename(later[0]))
                    if any(a.startswith("-") and not a.startswith("--") and "v" in a for a in later[1:]):
                        continue  # grep -v: the lines that do not match, a read of the rest
                    if rx is not None and not TOC_PATTERN.match(pat or ""):
                        try:
                            with open(f, encoding="utf-8", errors="replace") as fh:
                                text = fh.read().split("\n")
                        except OSError:
                            text = []
                        hits = [n for a, b in rs for n in range(a, b + 1) if n <= len(text) and rx.search(text[n - 1])]
                        if hits:
                            reads.append({"abs": f, "kind": "search", "hits": hits, "exact": False})
                    elif rx is not None:
                        stats["목차 조회"] += 1
                    searched = True
                    break
                rs = apply_filter(later, rs, length) if None not in later and rs else None
                if rs is None:
                    stats["파이프 뒤 필터"] += 1
                    break
            if rs and not searched:
                reads.append({"abs": f, "kind": "read", "ranges": rs, "exact": False})
    if talkers == 1 and len(reads) == 1 and reads[0]["kind"] == "read" and len(reads[0]["ranges"]) == 1 and out:
        # the output is this one read: its `## ` lines place the sections, as a Read's do (line numbers from cat -n /
        # nl are dropped; with a filter that drops lines in between, the count would be off, so only plain ranges)
        a, b = reads[0]["ranges"][0]
        body = [re.sub(r"^\s*\d+(?:\t|: )", "", l) for l in out.split("\n")]
        if body and not body[-1]:
            body.pop()
        if len(body) == b - a + 1:
            reads[0]["heads"] = output_heads(enumerate(body, a))
    return reads


def output_heads(numbered):
    """[(line, title)] of the `## ` headings outside code fences among (line, text) pairs."""
    heads, fence = [], None
    for n, text in numbered:
        f = FENCE.match(text)
        if f:
            fence = None if fence == f.group(1) else fence or f.group(1)
        elif not fence:
            h = HEADING.match(text)
            if h and len(h.group(1)) == 2:
                heads.append((n, h.group(2)))
    return heads
