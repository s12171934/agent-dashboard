"""The review collector."""


from adash.core.state import loop_failed, loop_ok
from adash.features.review.config import QA_SETS, REVIEW_EVERY
from adash.features.review.review import review_pass
from adash.features.review.store import review_kick, review_state


def review_loop():
    jira, prs, stats = {}, {}, {}
    while True:
        if QA_SETS:
            try:
                review_pass(jira, prs, stats)
                loop_ok("review")
            except Exception as e:
                loop_failed("review", e)
        review_kick.wait(REVIEW_EVERY)
        review_kick.clear()


def review_ticket(key):
    return next((t for s in review_state["sets"] for t in s["tickets"] if t["key"] == key), None)
