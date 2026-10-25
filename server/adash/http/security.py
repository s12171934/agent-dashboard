"""Which hosts and page origins may use the API."""

import re


# No token: every client that reaches a bound address is trusted (the user's choice, 2026-10-13; the addresses are
# loopback and the tailnet). The Host check below only stops DNS rebinding, i.e. a web page in the user's own
# browser reaching this server under a domain it controls.
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}  # main() adds every --host


def host_allowed(header):
    """Bound addresses, single-label MagicDNS names and *.ts.net names: no outside party can point those at us."""
    host = (header or "").strip().lower()
    if host.startswith("["):  # [::1]:8787
        host = host[1:host.find("]")]
    elif host.count(":") == 1:  # name:8787
        host = host.split(":")[0]
    return bool(host) and (host in ALLOWED_HOSTS or "." not in host or host.endswith(".ts.net"))


# The page is served from another origin (Cloudflare Pages), so browsers need CORS. Only these origins get it, and a
# browser request from any other Origin is refused outright: without this, any page the user opens could read the
# session logs or close terminals through their browser. main() adds every --origin; an origin also covers its
# subdomains, i.e. Pages preview deployments (<hash>.<project>.pages.dev).
ALLOWED_ORIGINS = set()
LOCAL_ORIGIN = re.compile(r"http://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?")  # a local copy of ../frontend


def origin_allowed(origin):
    origin = origin.rstrip("/").lower()
    if LOCAL_ORIGIN.fullmatch(origin):
        return True
    for o in ALLOWED_ORIGINS:
        scheme, _, host = o.partition("://")
        if origin == o or (origin.startswith(scheme + "://") and origin.endswith("." + host)):
            return True
    return False
