"""Pure scoring/ranking logic: no network, no database, easy to test."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class Scored:
    term: str
    volume: float | None      # mean interest over the timeframe, relative to the anchor (anchor = 1.0)
    momentum: float | None    # log ratio of recent window vs. baseline window
    score: float | None = None
    pinned: bool = False


def momentum(series: list[float], recent_weeks: int, baseline_weeks: int, floor: float) -> float:
    """log((recent_mean + floor) / (baseline_mean + floor)).

    Symmetric (doubling = +0.69, halving = -0.69) and the floor keeps near-zero
    terms from producing huge ratios out of rounding noise.
    """
    if len(series) < recent_weeks + 1:
        return 0.0
    recent = series[-recent_weeks:]
    baseline = series[-(recent_weeks + baseline_weeks):-recent_weeks] or series[:-recent_weeks]
    r = sum(recent) / len(recent)
    b = sum(baseline) / len(baseline)
    return math.log((r + floor) / (b + floor))


def percentile_ranks(values: list[float]) -> list[float]:
    """Map values to [0, 1] by rank, ties sharing their average rank.

    Rank-based so one breakout term doesn't squash everyone else's score.
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2
        for k in range(i, j + 1):
            ranks[order[k]] = avg / (n - 1)
        i = j + 1
    return ranks


def score_all(items: list[Scored], volume_weight: float, momentum_weight: float) -> None:
    """Fill in .score for every item that has both volume and momentum."""
    valid = [s for s in items if s.volume is not None and s.momentum is not None]
    total = volume_weight + momentum_weight
    vol_pct = percentile_ranks([s.volume for s in valid])
    mom_pct = percentile_ranks([s.momentum for s in valid])
    for s, v, m in zip(valid, vol_pct, mom_pct):
        s.score = (volume_weight * v + momentum_weight * m) / total


def select_top(items: list[Scored], pins: set[str], top_n: int) -> list[Scored]:
    """Pinned terms always make the list; the remaining slots go to the best scores.

    Pins without a score (fetch failed) are kept but sorted to the bottom.
    If there are more pins than slots, the list grows to fit every pin.
    """
    for s in items:
        s.pinned = s.term in pins
    pinned = [s for s in items if s.pinned]
    free_slots = max(top_n - len(pinned), 0)
    others = sorted(
        (s for s in items if not s.pinned and s.score is not None),
        key=lambda s: s.score,
        reverse=True,
    )[:free_slots]
    return sorted(pinned + others, key=lambda s: (s.score is None, -(s.score or 0.0)))
