"""The review snapshot."""

import threading


review_state = {"sets": [], "updated": None}
review_kick = threading.Event()  # a review mark wakes the loop so the page shows it at once
