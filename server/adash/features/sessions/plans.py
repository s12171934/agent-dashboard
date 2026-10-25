"""aplan task plans as a session records them."""


def build_plans(events, prompts):
    """One plan per instruction: {prompt, ts, steps: [{t, st, ts0, ts1, note}], hist: [[ts, done, total]]}."""
    import bisect
    pts = [t for t, _ in prompts]
    plans = []
    for ts, ev in events:
        k = bisect.bisect_right(pts, ts) - 1
        prompt_ts, prompt = (prompts[k] if k >= 0 else (None, None))
        op, plan = ev.get("op"), plans[-1] if plans else None
        # A plan made after the latest instruction is revised in place; a newer instruction starts a new plan.
        fresh = plan is None or (prompt_ts and (plan["ts"] or "") < prompt_ts)
        if op == "set" or (op == "add" and fresh):
            old = {} if fresh or op == "add" else {x["t"]: x for x in plan["steps"]}
            steps = [dict(old.get(t) or {"t": t, "st": "todo", "ts0": None, "ts1": None, "note": None}) for t in ev.get("steps", [])]
            if fresh:
                plan = {"prompt": prompt, "ts": ts, "steps": steps, "hist": []}
                plans.append(plan)
            else:
                plan["steps"] = steps
        elif op == "add":
            plan["steps"] += [{"t": t, "st": "todo", "ts0": None, "ts1": None, "note": None} for t in ev.get("steps", [])]
        elif plan:
            steps = plan["steps"]
            n = ev.get("n")
            i = n - 1 if n else next((j for j, x in enumerate(steps) if x["st"] == "run"), None)
            if i is None or not 0 <= i < len(steps):
                continue
            x = steps[i]
            if op == "start":
                x["st"], x["ts0"] = "run", x["ts0"] or ts
            else:
                x["st"], x["ts1"], x["ts0"] = op, ts, x["ts0"] or ts
                x["note"] = ev.get("note") or x["note"]
        else:
            continue
        steps = plan["steps"]
        if op != "fail" and not any(x["st"] == "run" for x in steps):
            nxt = next((x for x in steps if x["st"] == "todo"), None)
            if nxt:
                nxt["st"], nxt["ts0"] = "run", ts
        plan["hist"].append([ts, sum(x["st"] in ("done", "skip") for x in steps), len(steps)])
    return plans
