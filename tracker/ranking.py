"""Pure scoring/ranking logic: no network, no database, easy to test."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field


@dataclass
class Scored:
    term: str
    volume: float | None      # mean interest over the timeframe, relative to the anchor (anchor = 1.0)
    momentum: float | None    # log ratio of recent window vs. baseline window
    score: float | None = None
    pinned: bool = False
    source: str | None = None  # pin | seed | rising | top | anchor
    similar: list["Scored"] = field(default_factory=list)  # variants folded under this one


def is_ignored(term: str, source: str | None, blocklist: list[str]) -> bool:
    """Only discovered keywords can be ignored, never seeds, pins or the comparison keyword."""
    return source not in ("pin", "seed", "anchor") and any(b in term for b in blocklist)


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


# Words that describe a thing rather than make it a different thing. "alh engine" and
# "alh review" fold under "alh"; "alh turbo" (a part) keeps its own row.
QUALIFIERS = frozenset("""
a an the of for in on to with and vs near me best new used cheap price prices cost costs sale buy review reviews
spec specs model models engine engines motor motors lease leasing hire contract finance deal deals
awd fwd rwd diesel petrol gas
""".split())
# 1.9, 2025, 2.0t, 4wd · 4x4, 6x6 · v6, v8, i4
_NUMBERISH = re.compile(r"^(\d[\d.,]*[a-z]{0,2}|\d+x\d+|[vi]\d{1,2})$")


def _stem(token: str) -> str:
    return token[:-1] if len(token) > 3 and token.endswith("s") and not token.endswith("ss") else token


def group_parents(items: list[Scored], pins: set[str]) -> dict[str, str]:
    """Map each term to the more general term it's a variant of (terms with no parent are omitted).

    B is a parent of A when B's words are a subset of A's and every extra word in A
    only qualifies it: a number ("1.9", "2025"), a word that's a keyword on its own
    ("tdi"), or a generic word from QUALIFIERS. So "1.9 alh tdi" folds under "alh"
    but "alh turbo" doesn't. Word order and plurals are ignored. The most specific
    parent wins, so chains form ("1.9 alh tdi" -> "1.9 alh" -> "alh"); on a tie,
    the parent whose words come first in A. Pinned terms always keep their own row.
    """
    words = {s.term: s.term.split() for s in items}
    sets = {t: frozenset(_stem(w) for w in ws) for t, ws in words.items()}
    standalone = {next(iter(st)) for st in sets.values() if len(st) == 1}

    def qualifies(word: str) -> bool:
        return word in QUALIFIERS or word in standalone or bool(_NUMBERISH.match(word))

    order = {s.term: i for i, s in enumerate(sorted(items, key=lambda s: (s.score is None, -(s.score or 0.0), s.term)))}
    parents: dict[str, str] = {}
    for s in items:
        if s.term in pins:
            continue
        best, best_key = None, None
        for b in items:
            if b.term == s.term:
                continue
            sub = sets[b.term] < sets[s.term] and all(qualifies(w) for w in sets[s.term] - sets[b.term])
            same = sets[b.term] == sets[s.term] and order[b.term] < order[s.term]  # "tent" vs "tents"
            if not (sub or same):
                continue
            stems = [_stem(w) for w in words[s.term]]
            first = min(stems.index(w) for w in sets[b.term])
            key = (len(sets[b.term]), -first, -order[b.term])
            if best_key is None or key > best_key:
                best, best_key = b.term, key
        if best is not None:
            parents[s.term] = best
    return parents


def rank_groups(
    items: list[Scored], pins: set[str], top_n: int, blocklist: list[str] = (), group: bool = True
) -> list[Scored]:
    """The ranked list: ignored terms dropped, variants folded, pins always in.

    Returns one Scored per row; its .similar holds the folded variants. The row
    shown is the group's best-scoring member.
    """
    items = [s for s in items if s.term in pins or not is_ignored(s.term, s.source, blocklist)]
    for s in items:
        s.pinned = s.term in pins
        s.similar = []
    if not group:
        return select_top(items, pins, top_n)

    parents = group_parents(items, pins)

    def root(t: str) -> str:
        while t in parents:
            t = parents[t]
        return t

    groups: dict[str, list[Scored]] = {}
    for s in items:
        groups.setdefault(root(s.term), []).append(s)
    heads = []
    for members in groups.values():
        members.sort(key=lambda s: (not s.pinned, s.score is None, -(s.score or 0.0), len(s.term)))
        head = members[0]
        head.similar = members[1:]
        heads.append(head)
    return select_top(heads, pins, top_n)
