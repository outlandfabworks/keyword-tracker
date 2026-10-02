"""Settings: config.toml supplies first-boot defaults; after that they live in the DB and are edited in the web UI."""

from __future__ import annotations

import os
import tomllib
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

DEFAULT_CONFIG = Path(os.environ.get("KWT_CONFIG", "/app/config.toml"))
DEFAULT_DB = Path(os.environ.get("KWT_DB", "/data/keywords.db"))

TIMEFRAMES = {"today 12-m": "Past 12 months", "today 5-y": "Past 5 years"}
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass(frozen=True)
class TrendsSettings:
    geo: str = ""             # "" = worldwide
    timeframe: str = "today 12-m"
    hl: str = "en-US"
    anchor: str = "overlanding"

    @property
    def region_resolution(self) -> str:
        # Worldwide -> break down by country; scoped to a country -> by its regions/provinces.
        return "COUNTRY" if not self.geo else "REGION"


@dataclass(frozen=True)
class DiscoverySettings:
    seeds: list[str] = field(default_factory=list)
    rising_per_seed: int = 10
    top_per_seed: int = 3
    max_candidates: int = 60
    blocklist: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class RankingSettings:
    top_n: int = 20
    volume_weight: float = 0.5
    momentum_weight: float = 0.5
    recent_weeks: int = 4
    baseline_weeks: int = 12
    momentum_floor: float = 0.05


@dataclass(frozen=True)
class RegionSettings:
    hide_small_countries: bool = True   # applied when displaying; see geo.py


@dataclass(frozen=True)
class RateLimitSettings:
    min_delay_s: float = 8
    max_delay_s: float = 15
    max_retries: int = 5
    backoff_base_s: float = 60


@dataclass(frozen=True)
class ScheduleSettings:
    enabled: bool = True
    weekday: int = 0          # 0 = Monday
    hour: int = 4             # local time (container TZ)


@dataclass(frozen=True)
class Config:
    trends: TrendsSettings = field(default_factory=TrendsSettings)
    discovery: DiscoverySettings = field(default_factory=DiscoverySettings)
    ranking: RankingSettings = field(default_factory=RankingSettings)
    regions: RegionSettings = field(default_factory=RegionSettings)
    rate_limit: RateLimitSettings = field(default_factory=RateLimitSettings)
    schedule: ScheduleSettings = field(default_factory=ScheduleSettings)

    def to_dict(self) -> dict:
        return asdict(self)


def normalize_term(term: str) -> str:
    """Canonical form used as the key everywhere: lowercase, single-spaced."""
    return " ".join(term.lower().split())


def _section(cls, raw: dict | None):
    """Build a settings dataclass from a dict, ignoring unknown keys and coercing types."""
    raw = raw or {}
    kwargs = {}
    for f in fields(cls):
        if f.name not in raw:
            continue
        v = raw[f.name]
        default = getattr(cls(), f.name)
        if isinstance(default, bool):
            v = bool(v)
        elif isinstance(default, int):
            v = int(v)
        elif isinstance(default, float):
            v = float(v)
        elif isinstance(default, list):
            v = [normalize_term(str(x)) for x in v if normalize_term(str(x))]
            v = list(dict.fromkeys(v))
        elif isinstance(default, str):
            v = str(v).strip()
        kwargs[f.name] = v
    return cls(**kwargs)


def config_from_dict(raw: dict) -> Config:
    trends = _section(TrendsSettings, raw.get("trends"))
    trends = TrendsSettings(**{**asdict(trends), "anchor": normalize_term(trends.anchor), "geo": trends.geo.upper()})
    cfg = Config(
        trends=trends,
        discovery=_section(DiscoverySettings, raw.get("discovery")),
        ranking=_section(RankingSettings, raw.get("ranking")),
        regions=_section(RegionSettings, raw.get("regions")),
        rate_limit=_section(RateLimitSettings, raw.get("rate_limit")),
        schedule=_section(ScheduleSettings, raw.get("schedule")),
    )
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    """Raise ValueError with a message suitable for showing in the UI."""
    d, r, t, rl, s = cfg.discovery, cfg.ranking, cfg.trends, cfg.rate_limit, cfg.schedule
    if not d.seeds:
        raise ValueError("Add at least one seed keyword.")
    if not t.anchor:
        raise ValueError("The anchor keyword can't be empty.")
    if t.timeframe not in TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe {t.timeframe!r}.")
    if t.geo and not (len(t.geo) == 2 and t.geo.isalpha()):
        raise ValueError("Region must be blank (worldwide) or a 2-letter country code like US or CA.")
    if not 1 <= r.top_n <= 50:
        raise ValueError("Top list size must be between 1 and 50.")
    if r.volume_weight < 0 or r.momentum_weight < 0 or r.volume_weight + r.momentum_weight == 0:
        raise ValueError("Weights must be non-negative and not both zero.")
    if not 10 <= d.max_candidates <= 200:
        raise ValueError("Candidate pool size must be between 10 and 200.")
    if rl.min_delay_s < 2 or rl.max_delay_s < rl.min_delay_s:
        raise ValueError("Delays: minimum must be at least 2s and no more than the maximum.")
    if not 0 <= s.weekday <= 6 or not 0 <= s.hour <= 23:
        raise ValueError("Invalid schedule.")


def load_toml_defaults(path: Path = DEFAULT_CONFIG) -> Config:
    if not path.exists():
        return Config(discovery=DiscoverySettings(seeds=["overlanding"]))
    with open(path, "rb") as f:
        return config_from_dict(tomllib.load(f))
