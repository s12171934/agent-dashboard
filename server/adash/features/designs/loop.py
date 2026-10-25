"""The design collectors: the index and the backfill of older transcripts."""

import time

from adash.core.state import bump, lock, loop_failed, loop_ok
from adash.features.designs.index import scan_designs
from adash.features.designs.refs import backfill_designs, save_design_refs, ticket_section_badges
from adash.features.designs.store import DESIGN_EVERY
import adash.features.designs.store as designs_store
import adash.features.sessions.scan as sessions_scan


def design_backfill_loop():
    while not sessions_scan.scan_ready:
        time.sleep(2)
    while True:
        try:
            backfill_designs()
            loop_ok("design_backfill")
        except Exception as e:
            loop_failed("design_backfill", e)
        time.sleep(300)


def design_loop():
    while True:
        try:
            scan_designs()
            badges = ticket_section_badges()
            changed = save_design_refs()
            if changed or badges != designs_store.design_ticket_refs:
                designs_store.design_ticket_refs = badges
                with lock:
                    bump()
            loop_ok("design")
        except Exception as e:
            loop_failed("design", e)
        time.sleep(DESIGN_EVERY)
