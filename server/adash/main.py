"""Command line and startup: the collector threads and the HTTP servers."""

import argparse
import os
import threading

from adash.core.prefs import prefs
from adash.features.decisions.sweep import decision_loop
from adash.features.designs.loop import design_backfill_loop, design_loop
from adash.features.designs.store import DESIGN_DIRS, design_bases
from adash.features.history.history import history_loop
from adash.features.orca_runs.loop import orca_loop
from adash.features.plan_usage.usage import plan_usage_loop
from adash.features.plans.external import ext_plan_loop
from adash.features.plans.store import EXTERNAL_PLANS
from adash.features.projects.loop import projects_loop
from adash.features.projects.store import PROJECTS_DIRS
from adash.features.review.loop import review_loop
from adash.features.sessions.scan import scan_loop
from adash.features.vault.vault import vault_loop
from adash.http.handler import Handler
from adash.http.security import ALLOWED_HOSTS, ALLOWED_ORIGINS
from adash.http.server import Server
import adash.core.config as core_config
import adash.features.designs.store as designs_store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--hours", type=float, default=24, help="only sessions touched within this window")
    ap.add_argument("--runs", type=int, default=8, help="minimum number of recent Orca runs to track (all runs inside --hours are tracked)")
    ap.add_argument("--host", action="append",
                    help="address to bind; repeatable (default 127.0.0.1). e.g. --host 127.0.0.1 --host <tailscale ip>")
    ap.add_argument("--origin", action="append", default=[],
                    help="page origin allowed over CORS, subdomains included; repeatable. e.g. --origin https://<project>.pages.dev")
    ap.add_argument("--projects-dir", action="append", default=[],
                    help="folder whose subfolders with a progress.json are projects; repeatable. Off when not given")
    ap.add_argument("--design-dir", action="append", default=[],
                    help="design document folder (e.g. <repo>/feature-designs), added to prefs.json design_dirs; repeatable")
    ap.add_argument("--design-days", type=float, default=designs_store.DESIGN_DAYS,
                    help="how far back (days) design reads are looked for in transcripts outside --hours")
    ap.add_argument("--vault", default=core_config.VAULT,
                    help="Obsidian vault whose notes are tied to the sessions that created them (default %(default)s); "
                         "off when the folder does not exist")
    args = ap.parse_args()
    designs_store.DESIGN_DAYS = args.design_days
    for d in (prefs.get("design_dirs") or []) + args.design_dir:
        d = os.path.realpath(os.path.expanduser(d))
        if d not in DESIGN_DIRS:
            DESIGN_DIRS.append(d)
    design_bases.update(os.path.basename(d) for d in DESIGN_DIRS)  # before scan_loop parses the first transcript
    hosts = args.host or ["127.0.0.1"]
    PROJECTS_DIRS.extend(os.path.abspath(os.path.expanduser(d)) for d in args.projects_dir)
    core_config.VAULT = os.path.abspath(os.path.expanduser(args.vault))
    threading.Thread(target=scan_loop, args=(args.hours,), daemon=True).start()
    threading.Thread(target=orca_loop, args=(args.runs, args.hours), daemon=True).start()
    threading.Thread(target=ext_plan_loop, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    threading.Thread(target=decision_loop, daemon=True).start()
    threading.Thread(target=review_loop, daemon=True).start()
    threading.Thread(target=plan_usage_loop, daemon=True).start()
    if PROJECTS_DIRS:
        threading.Thread(target=projects_loop, daemon=True).start()
    if DESIGN_DIRS or EXTERNAL_PLANS:  # an external plan's design_root is a design folder too
        threading.Thread(target=design_loop, daemon=True).start()
        threading.Thread(target=design_backfill_loop, daemon=True).start()
    if os.path.isdir(core_config.VAULT):
        threading.Thread(target=vault_loop, daemon=True).start()
    servers = []
    ALLOWED_HOSTS.update(h.lower() for h in hosts)
    ALLOWED_ORIGINS.update(o.rstrip("/").lower() for o in args.origin)
    for host in hosts:
        server = Server((host, args.port), Handler)
        servers.append(server)
        print(f"agent-dashboard API → http://{host}:{args.port}/", flush=True)
    print(f"allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) or '(local only)'}", flush=True)
    print(f"project dirs: {', '.join(PROJECTS_DIRS) or '(off)'}", flush=True)
    print(f"design dirs: {', '.join(DESIGN_DIRS) or '(off)'}", flush=True)
    print(f"vault: {core_config.VAULT if os.path.isdir(core_config.VAULT) else '(off)'}", flush=True)
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    servers[0].serve_forever()
