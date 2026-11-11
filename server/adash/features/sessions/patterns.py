"""Patterns read out of transcripts: tool categories, Orca briefs and commands, background tasks."""

import json
import re

from adash.core.util import short


# An Orca terminal handle: a dashed UUID, or (Orca 1.4 reissuing a released worker's terminal) 32 bare hex digits.
TERM = r"term_(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f-])"
BRIEF_COORD = re.compile(r"Your coordinator's terminal handle is:\s*(" + TERM + ")")
BRIEF_TASK = re.compile(r"Your task ID is:\s*(task_[0-9a-f]{12})")
# The first line of Orca's worker preamble: a coordinator dispatched a Task into this terminal (worker-start --terminal).
DISPATCH_PREAMBLE = re.compile(r"You are a dispatched worker\.\s*\n\s*Your coordinator's terminal handle is:")
COORD_CMD = re.compile(r"(?:^|[;&|\n(\"'/]\s*)orca orchestration (?:run-create|run-use|dispatch|worker-start)(?![\w-])")  # not dispatch-show etc.
HANDLE = re.compile(TERM)
# A message handed to another terminal (RELAY) leaves the turn with the agent there until an answer comes back; a
# blocking ask or a `check --wait` is that answer, read within the same turn (RELAY_BACK).
RELAY = re.compile(r"\borca (?:terminal send|orchestration (?:send|dispatch|task-create|worker-start))(?![\w-])")
RELAY_BACK = re.compile(r"\borca orchestration (?:ask(?![\w-])|check\b[^;&|\n]*--wait)")
# Tool calls are counted by what they are for, not by tool name: a skill load, an MCP server, sub-agents,
# orchestration, shell, files, web. Codex has no Skill tool, so a read of .../skills/<name>/SKILL.md counts.
SKILL_PATH = re.compile(r"skills/([A-Za-z0-9_.-]+)/SKILL\.md")
ORCA_USE = re.compile(r"\borca\s+(?:orchestration|terminal|worktree|skills)\b")
SHELL_TOOLS = {"Bash", "exec", "exec_command", "local_shell_call", "shell", "Monitor", "BashOutput", "KillShell", "js"}
FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS", "NotebookEdit", "apply_patch"}
AGENT_TOOLS = {"Agent", "Task", "TaskStop", "SendMessage", "spawn_agent", "followup_task", "wait_agent",
               "send_message", "list_agents", "interrupt_agent"}
WEB_TOOLS = {"WebFetch", "WebSearch"}


def classify_tool(name, inp):
    """-> (category, skill names, MCP server)"""
    name = name or "?"
    text = inp if isinstance(inp, str) else json.dumps(inp, ensure_ascii=False) if inp else ""
    if name == "Skill" and isinstance(inp, dict):
        return "스킬", [inp.get("skill") or "?"], None
    if name.startswith("mcp__"):
        return "MCP", [], name.split("__")[1]
    skills = sorted(set(SKILL_PATH.findall(text)))
    if skills:
        return "스킬", skills, None
    if name in AGENT_TOOLS:
        return "서브에이전트", [], None
    if name in SHELL_TOOLS:
        return ("오케스트레이션" if ORCA_USE.search(text) else "셸"), [], None
    if name in FILE_TOOLS:
        return "파일", [], None
    if name in WEB_TOOLS:
        return "웹", [], None
    return "기타", [], None
# Task plans: the aplan CLI echoes APLAN:<base64 json> into its own tool result.
APLAN_TOKEN = re.compile(r"APLAN:([A-Za-z0-9_=-]+)")
# User-role text that is not an instruction: harness tags (<task-notification>, <system-reminder>, …), the
# "[Image: original WxH …]" line beside a pasted image, and Orca's inbox nudge. Counted as instructions, they
# split a plan in two whenever one arrived between `aplan done` and a revising `aplan set`.
NOT_INSTRUCTION = re.compile(r"\s*(?:<|\[Image: |You have \d+ orchestration messages?\b)")
# Claude Code background work: the launching tool's result names the task id, and a <task-notification> carrying
# the same id and a final <status> (or a Monitor expiry) ends it. TaskStop ends it from the session's side.
# Only the launching call's own result is read: the same phrases inside any other output (a grep over transcripts)
# would otherwise start phantom tasks.
# A foreground Bash past its timeout is moved to the background too.
BG_START = {"Bash": re.compile(r"^(?:Command running in background with ID: |Command did not complete within its \d+s timeout and was moved to the background \(ID: )(\w+)\)?\. Output is being written to: "),
            "Monitor": re.compile(r"Monitor started \(task (\w+)"),
            "Agent": re.compile(r"Async agent launched.*?agentId: (\w+)", re.S)}
BG_KIND = {"Bash": "Bash", "Monitor": "Monitor", "Agent": "에이전트"}
BG_NOTE = re.compile(r"<task-id>(\w+)</task-id>")
BG_END = re.compile(r"<status>(?:completed|failed|killed|stopped|cancelled|error)</status>|Monitor (?:expired|stopped|ended)")
BG_MAX_SECONDS = 6 * 3600  # a task whose end was never recorded (session killed, notice lost) stops counting
APLAN_CMD = re.compile(r"\baplan\b")
APLAN_SET = re.compile(r"\baplan set\b")
# Only a Run this session created or bound names its own terminal; run-list etc. echo other coordinators.
# A real `terminal create` call, however orca is invoked (orca, a full path, or a shell variable like $O),
# including inside $(...); a mention in text or a --help call does not count.
TERM_CREATE = re.compile(r"(?:^|[;&|\n(]\s*|\$\(\s*)(?:\S*/orca|orca|\$\{?\w+\}?) terminal create\b(?![^;&|\n]*--help)")
# A real `terminal close` call, however orca is invoked; group 1 = the rest of that shell segment.
TERM_CLOSE = re.compile(r"(?:^|[;&|\n(]\s*)(?:\S*/orca|orca|\$\{?\w+\}?) terminal close\b([^;&|\n]*)")
CLOSE_TARGET = re.compile(r"--terminal[ =]+[\"']?(\$\{?ORCA_TERMINAL_HANDLE\b|" + TERM + ")")


def closes_own_terminal(cmd, own_handles=()):
    """True when the command closes the terminal it runs in: `terminal close` with no --terminal, with
    $ORCA_TERMINAL_HANDLE, or with one of the session's own handles. The close kills the agent mid-call."""
    for m in TERM_CLOSE.finditer(cmd if isinstance(cmd, str) else ""):
        rest = m.group(1)
        if "--help" in rest:
            continue
        t = CLOSE_TARGET.search(rest)
        if "--terminal" not in rest or (t and (t.group(1).startswith("$") or t.group(1) in own_handles)):
            return True
    return False


TERM_HANDLE_STR = re.compile(r'"handle\\*"\s*:\s*\\*"(' + TERM + ')')
OWN_RUN_CMD = re.compile(r"orchestration (?:run-create|run-use)(?![\w-])")
RUN_CREATE = re.compile(r"orchestration run-create(?![\w-])(?![^\n|;&]*--help)")
RUN_ID = re.compile(r"\brun_[0-9a-f]{12}\b")
COORD_HANDLE_STR = re.compile(r'coordinator_handle\\*"\s*:\s*\\*"(' + TERM + ')')


def tool_hint(name, inp):
    if not isinstance(inp, dict):
        return short(inp, 120)
    for key in ("command", "file_path", "pattern", "description", "prompt", "url", "skill", "query"):
        if key in inp:
            return short(inp[key], 120)
    return short(json.dumps(inp, ensure_ascii=False), 120)
