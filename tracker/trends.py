"""Throttled Google Trends access.

pytrends is unofficial and archived upstream, so everything that touches it lives
here behind TrendsClient. If it breaks for good, this is the only file to replace.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, TypeVar

from pytrends.exceptions import TooManyRequestsError
from pytrends.request import TrendReq

from .config import RateLimitSettings, RegionSettings, TrendsSettings, normalize_term

log = logging.getLogger(__name__)
T = TypeVar("T")

MAX_TERMS_PER_REQUEST = 5


@dataclass
class Related:
    rising: list[tuple[str, int]]  # (query, % increase; Google's "Breakout" comes through as a large int)
    top: list[tuple[str, int]]     # (query, relative interest 0-100)


@dataclass
class TimeSeries:
    dates: list[str]                # ISO dates, partial (in-progress) week dropped
    values: dict[str, list[int]]    # term -> raw 0-100 values, relative within this request only


class TrendsClient:
    def __init__(self, trends: TrendsSettings, regions: RegionSettings, rate: RateLimitSettings):
        self.trends = trends
        self.regions = regions
        self.rate = rate
        self.requests_made = 0
        # pytrends wants minutes *west* of UTC; take it from the container's TZ.
        offset = datetime.now().astimezone().utcoffset() or timedelta(0)
        self._py = TrendReq(hl=trends.hl, tz=int(-offset.total_seconds() // 60), timeout=(10, 30))

    def _call(self, what: str, fn: Callable[[], T]) -> T:
        """Run fn with a polite delay first and exponential backoff on 429s."""
        for attempt in range(self.rate.max_retries + 1):
            time.sleep(random.uniform(self.rate.min_delay_s, self.rate.max_delay_s))
            try:
                self.requests_made += 1
                return fn()
            except TooManyRequestsError:
                if attempt == self.rate.max_retries:
                    raise
                wait = self.rate.backoff_base_s * 2**attempt * random.uniform(1.0, 1.3)
                log.warning("429 on %s, backing off %.0fs (attempt %d)", what, wait, attempt + 1)
                time.sleep(wait)
        raise AssertionError("unreachable")

    def _payload(self, terms: list[str]) -> None:
        self._py.build_payload(terms, timeframe=self.trends.timeframe, geo=self.trends.geo)

    def related(self, seed: str) -> Related:
        def go():
            self._payload([seed])
            return self._py.related_queries().get(seed) or {}

        data = self._call(f"related({seed!r})", go)

        def rows(df) -> list[tuple[str, int]]:
            if df is None or df.empty:
                return []
            return [(normalize_term(q), int(v)) for q, v in zip(df["query"], df["value"])]

        return Related(rising=rows(data.get("rising")), top=rows(data.get("top")))

    def interest_over_time(self, terms: list[str]) -> TimeSeries:
        if not 1 <= len(terms) <= MAX_TERMS_PER_REQUEST:
            raise ValueError(f"need 1-{MAX_TERMS_PER_REQUEST} terms, got {len(terms)}")

        def go():
            self._payload(terms)
            return self._py.interest_over_time()

        df = self._call(f"interest_over_time({terms})", go)
        if df.empty:
            return TimeSeries(dates=[], values={t: [] for t in terms})
        if "isPartial" in df.columns:
            df = df[~df["isPartial"].astype(bool)]
        return TimeSeries(
            dates=[d.date().isoformat() for d in df.index],
            values={t: [int(v) for v in df[t]] if t in df.columns else [] for t in terms},
        )

    def interest_by_region(self, term: str) -> list[tuple[str, str, int]]:
        """(geo_code, name, value) for regions with nonzero interest; 100 = the term's top region."""

        def go():
            self._payload([term])
            return self._py.interest_by_region(
                resolution=self.trends.region_resolution,
                inc_low_vol=True,  # Google ignores False anyway; small countries are filtered in geo.py
                inc_geo_code=True,
            )

        df = self._call(f"interest_by_region({term!r})", go)
        if df.empty or term not in df.columns:
            return []
        out = [(str(code), str(name), int(v)) for name, code, v in zip(df.index, df["geoCode"], df[term]) if v > 0]
        return sorted(out, key=lambda r: r[2], reverse=True)
