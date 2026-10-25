#!/usr/bin/env python3
"""Local agent dashboard metrics server — REST + SSE for Claude/Codex sessions and Orca runs.

Stdlib only. Tails session logs incrementally and pushes change notices over SSE. The page itself lives in
../frontend and is served elsewhere (Cloudflare Pages); this process only answers /api/* and /events.
This file only starts it: the code is the adash package beside it, laid out in adash/README.md.

    python3 server.py [--port 8787] [--hours 24] [--host 127.0.0.1] [--origin https://<project>.pages.dev]
                      [--projects-dir <folder of project folders>] [--design-dir <design folder>] [--design-days 14]

There is no authentication: any client that reaches a bound address (loopback, the tailnet) is trusted.
Requests whose Host header is not one of those addresses are refused, which stops DNS rebinding, and a
browser request from an Origin outside --origin is refused, so other web pages cannot read or act through it.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adash.main import main  # noqa: E402

if __name__ == "__main__":
    main()
