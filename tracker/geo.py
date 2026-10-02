"""Country filtering for region breakdowns.

Google's per-country value is the keyword's *share* of that country's searches,
so a territory of a few thousand people with a handful of searches can top the
list. Google ignores its own "exclude low volume" flag, so we filter here.
"""

# ISO 3166-1 alpha-2 codes for countries and territories with under ~1 million people.
SMALL_COUNTRIES = frozenset("""
AD AG AI AQ AS AW AX BB BL BM BN BQ BS BT BV BZ CC CK CV CW CX DM EH FJ FK FM FO GD GF GG GI GL
GP GS GU GY HM IM IO IS JE KI KM KN KY LC LI LU MC ME MF MH MO MP MQ MS MT MV NC NF NR NU PF PM
PN PW RE SB SC SH SJ SM SR ST SX TC TF TK TO TV UM VA VC VG VI VU WF WS YT
""".split())


def visible_regions(rows: list, geo: str, hide_small: bool) -> list:
    """Drop tiny countries from a worldwide breakdown (province/state breakdowns are left alone)."""
    if geo or not hide_small:
        return rows
    return [r for r in rows if r["geo_code"] not in SMALL_COUNTRIES]
