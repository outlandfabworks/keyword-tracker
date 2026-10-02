"""Group autocomplete phrases for a seed into part/topic buckets for the Part ideas tab."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from .ranking import QUALIFIERS, _NUMBERISH, _stem


@dataclass
class Phrase:
    term: str
    position: int      # best (lowest) position it appeared at in any autocomplete list; 0 = top
    hits: int          # how many of the seed's prefixes surfaced it
    new: bool = False  # not seen for this seed in the previous refresh


@dataclass
class IdeaGroup:
    key: str
    label: str
    phrases: list[Phrase] = field(default_factory=list)

    @property
    def strength(self) -> float:
        """More phrases, and phrases nearer the top of autocomplete, mean people search this area more."""
        return sum(1 + (10 - min(p.position, 9)) / 10 for p in self.phrases)


def _remainder(term: str, seed: str) -> list[str]:
    """The words of `term` after taking the seed out: 'alh injector seals' -> ['injector', 'seals']."""
    words, seed_words = term.split(), seed.split()
    n = len(seed_words)
    for i in range(len(words) - n + 1):
        if words[i:i + n] == seed_words:
            return words[:i] + words[i + n:]
    return [w for w in words if w not in seed_words]


def group_ideas(
    phrases: list[Phrase], seed: str, other_seeds: list[str], blocklist: list[str]
) -> tuple[list[IdeaGroup], list[Phrase], int]:
    """Returns (groups with 2+ phrases, ungrouped single phrases, number hidden by the ignore list).

    Each phrase is keyed by the first word after the seed that names something:
    numbers, generic words, other seeds' words ("tdi") and words that start a
    large share of all phrases are skipped, so "alh tdi injector nozzles" lands
    with "alh injectors" under "injector".
    """
    # Google sometimes "corrects" the seed away ("alh k" -> "al karam sweets"); those aren't about the seed.
    seed_words = set(seed.split())
    about = [p for p in phrases if p.term != seed and seed_words <= set(p.term.split())]
    kept = [p for p in about if not any(b in p.term for b in blocklist)]
    hidden = len(about) - len(kept)

    remainders = {p.term: _remainder(p.term, seed) for p in kept}
    firsts = Counter(r[0] for r in remainders.values() if r)
    common = {w for w, c in firsts.items() if len(kept) >= 10 and c >= 0.2 * len(kept)}
    context = {w for s in other_seeds for w in s.split()} | common

    def key_word(words: list[str]) -> str | None:
        for i, w in enumerate(words):
            if w not in QUALIFIERS and w not in context and not _NUMBERISH.match(w):
                # a 1-2 letter word rarely names a part on its own: "go kart", "x pipe"
                return f"{w} {words[i + 1]}" if len(w) <= 2 and i + 1 < len(words) else w
        return words[-1] if words else None

    def stem_key(key: str) -> str:
        *head, last = key.split()
        return " ".join(head + [_stem(last)])

    buckets: dict[str, list[tuple[str, Phrase]]] = {}
    for p in kept:
        w = key_word(remainders[p.term])
        if w is None:
            continue
        buckets.setdefault(stem_key(w), []).append((w, p))

    groups, singles = [], []
    for key, members in buckets.items():
        ps = sorted((p for _, p in members), key=lambda p: (p.position, -p.hits, p.term))
        if len(ps) == 1:
            singles.extend(ps)
            continue
        label = Counter(w for w, _ in members).most_common(1)[0][0]
        groups.append(IdeaGroup(key=key, label=label, phrases=ps))
    groups.sort(key=lambda g: (-g.strength, g.label))
    singles.sort(key=lambda p: (p.position, -p.hits, p.term))
    return groups, singles, hidden
