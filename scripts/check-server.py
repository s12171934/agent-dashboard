#!/usr/bin/env python3
"""Check the server package's layering (server/adash/README.md): who may import whom, and no import cycles.

    python3 scripts/check-server.py

Then imports the whole package once, so a name moved without its import fails here rather than at the first request.
Exits 1 on any problem. Standard library only.
"""
import ast
import os
import sys

SERVER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
PKG = os.path.join(SERVER, "adash")
problems = []

mods = {}
for root, _, files in os.walk(PKG):
    for f in files:
        if f.endswith(".py"):
            path = os.path.join(root, f)
            name = os.path.relpath(path, SERVER)[:-3].replace(os.sep, ".")
            mods[name[:-9] if name.endswith(".__init__") else name] = path


def layer(m):
    parts = m.split(".")
    return parts[1] if len(parts) > 1 else "adash"


def feature(m):
    parts = m.split(".")
    return parts[2] if len(parts) > 2 and parts[1] == "features" else None


graph = {}
for m, path in sorted(mods.items()):
    tree = ast.parse(open(path, encoding="utf-8").read(), path)
    deps = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            deps |= {a.name for a in node.names if a.name.startswith("adash")}
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("adash"):
            deps |= {f"{node.module}.{a.name}" if f"{node.module}.{a.name}" in mods else node.module for a in node.names}
    graph[m] = deps & set(mods)
    for d in graph[m]:
        src, dst = layer(m), layer(d)
        if src == "core" and dst != "core":
            problems.append(f"{m}: core imports {d}")
        if src == "features" and dst in ("http", "main"):
            problems.append(f"{m}: a feature imports {d}")
        if src == "http" and dst == "main":
            problems.append(f"{m}: http imports {d}")
        if d.endswith(".api") and m != "adash.http.routes":
            problems.append(f"{m}: imports {d} (only http/routes.py uses the endpoints)")

# cycles (Tarjan)
index, low, stack, on, counter = {}, {}, [], set(), [0]


def visit(v):
    index[v] = low[v] = counter[0]
    counter[0] += 1
    stack.append(v)
    on.add(v)
    for w in graph.get(v, ()):
        if w not in index:
            visit(w)
            low[v] = min(low[v], low[w])
        elif w in on:
            low[v] = min(low[v], index[w])
    if low[v] == index[v]:
        comp = []
        while True:
            w = stack.pop()
            on.discard(w)
            comp.append(w)
            if w == v:
                break
        if len(comp) > 1:
            problems.append("import cycle among: " + ", ".join(sorted(comp)))


for v in graph:
    if v not in index:
        visit(v)

if not problems:
    sys.path.insert(0, SERVER)
    try:
        import adash.main  # noqa: F401  (pulls in every module through http.routes)
        missing = [m for m in mods if m not in sys.modules]
        if missing:
            problems.append("not reachable from adash.main: " + ", ".join(sorted(missing)))
    except Exception as e:  # an import that fails is the problem being reported
        problems.append(f"import adash.main: {e!r}")

if problems:
    print("\n".join(problems))
    print(f"\n{len(problems)} problem(s). Rules: server/adash/README.md")
    sys.exit(1)
print(f"server OK: {len(mods)} modules, {len({feature(m) for m in mods} - {None})} features")
