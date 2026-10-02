"""Google autocomplete: the specific phrases people type ("alh injector seals").

Trends can't measure phrases this rare, but autocomplete lists them, roughly most
common first. Like pytrends this is an unofficial endpoint, so it's isolated here.
"""

from __future__ import annotations

import logging
import random
import string
import time

import requests

from .config import RateLimitSettings, normalize_term

log = logging.getLogger(__name__)

URL = "https://suggestqueries.google.com/complete/search"
PREFIX_LETTERS = string.ascii_lowercase


class SuggestRateLimited(Exception):
    pass


def prefixes(seed: str) -> list[str]:
    """'alh ' plus 'alh a' ... 'alh z': each pulls up to 10 completions."""
    return [f"{seed} "] + [f"{seed} {c}" for c in PREFIX_LETTERS]


class SuggestClient:
    def __init__(self, hl: str, geo: str, rate: RateLimitSettings, min_delay_s: float = 1.0, max_delay_s: float = 2.5):
        self.hl = hl.split("-")[0] or "en"
        self.geo = geo.lower()
        self.rate = rate
        self.min_delay_s = min_delay_s
        self.max_delay_s = max_delay_s
        self.requests_made = 0
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"

    def complete(self, query: str) -> list[str]:
        params = {"client": "firefox", "hl": self.hl, "ie": "utf-8", "oe": "utf-8", "q": query}
        if self.geo:
            params["gl"] = self.geo
        for attempt in range(self.rate.max_retries + 1):
            time.sleep(random.uniform(self.min_delay_s, self.max_delay_s))
            self.requests_made += 1
            r = self.session.get(URL, params=params, timeout=15)
            if r.status_code == 429:
                if attempt == self.rate.max_retries:
                    raise SuggestRateLimited(query)
                wait = self.rate.backoff_base_s * 2**attempt * random.uniform(1.0, 1.3)
                log.warning("autocomplete 429 on %r, backing off %.0fs", query, wait)
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = r.json()
            return [normalize_term(s) for s in data[1] if normalize_term(s)]
        raise AssertionError("unreachable")
