"""Model prices for the cost columns."""

import json
import os

from adash.core.config import HERE


# USD per 1M tokens: input, 5m cache write, 1h cache write, cache read, output.
# Claude rates: claude-api skill (cached 2026-09-25). GPT rates: OpenAI Standard tier,
# developers.openai.com/api/docs/pricing (checked 2026-10-06); OpenAI has one cache-write rate, used for both slots.
# Override or add models via pricing.json ({"model": [in, w5m, w1h, read, out], ...}).
PRICING = {
    "gpt-6.1-sol": (2, 2.5, 2.5, 0.10, 10),
    "gpt-6-astra": (10, 12.5, 12.5, 1.00, 50),
    "claude-opus-5-5": (4, 5, 8, 0.20, 20),
    "claude-opus-5": (5, 6.25, 10, 0.50, 25),
    "claude-opus-4-8": (5, 6.25, 10, 0.50, 25),
    "claude-fable-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-fable-5": (10, 12.5, 20, 1.00, 50),
    "claude-sonnet-5-5": (2, 2.5, 4, 0.20, 10),
    "claude-sonnet-5": (2, 2.5, 4, 0.20, 10),
    "claude-haiku-4-5": (1, 1.25, 2, 0.10, 5),
}
# OpenAI bills a whole request at long-context rates once its prompt exceeds the threshold.
LONG_CONTEXT = {
    "gpt-6.1-sol": (272_000, (4, 5, 5, 0.20, 15)),
    "gpt-6-astra": (272_000, (20, 25, 25, 2.00, 75)),
}
try:
    with open(os.path.join(HERE, "pricing.json")) as _f:
        PRICING.update({k: tuple(v) for k, v in json.load(_f).items()})
except (OSError, ValueError):
    pass


def price_for(model, prompt_tokens=0):
    if not model:
        return None
    long = LONG_CONTEXT.get(model)
    if long and prompt_tokens > long[0]:
        return long[1]
    if model in PRICING:
        return PRICING[model]
    for name in sorted(PRICING, key=len, reverse=True):  # e.g. "claude-opus-5-5[1m]"
        if model.startswith(name):
            return PRICING[name]
    return None
