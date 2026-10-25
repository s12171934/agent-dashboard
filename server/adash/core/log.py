"""server.log lines."""

import time


def log(msg):
    """server.log line with the local time, so a stall can be matched against Orca's daemon.log."""
    print(f"{time.strftime('%m-%d %H:%M:%S')} {msg}", flush=True)
