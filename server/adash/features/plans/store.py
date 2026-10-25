"""External (driver-written) plan files and their parsed state."""

import os

from adash.core.prefs import prefs


# Driver-written plan files (pre-planned worker rosters), listed in prefs.json "external_plans" (none by default).
EXTERNAL_PLANS = [os.path.expanduser(p) for p in prefs.get("external_plans") or []]
ext_plans = {}  # path -> {"path", "project", "generated_at", "tickets", "error"}
