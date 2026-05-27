#!/usr/bin/env python3
"""
historical.py — WC + Euros historical player performance data.

Source: StatsBomb Open Data (https://github.com/statsbomb/open-data).
Free, CC-BY-NC-SA 4.0 licensed — attribution + non-commercial use only.

Why we want this:
  Our goalscorer prior (players.py) currently uses CLUB form from the
  most recent season. But club form doesn't fully translate to
  international tournament performance — different teammates, different
  pressure, different referee/match flow, different schedule density.

  Pulling historical WC + Euro performance gives us a tournament-context
  multiplier for each player who has prior international experience:
    "Mbappé scored 4 in 7 at WC 2018 / 8 in 7 at WC 2022 → tournament
     scoring rate higher than club rate → bump his prior."

Storage:
  wc_historical_form — one row per (player_name, competition) aggregate.
  We DO NOT store raw event data (it's GB of JSON). Just aggregates.

Tournaments pulled by default:
  - FIFA World Cup 2018  (Russia)   — competition 43, season 3
  - FIFA World Cup 2022  (Qatar)    — competition 43, season 106
  - UEFA Euro 2020       (delayed)  — competition 55, season 43
  - UEFA Euro 2024                  — competition 55, season 282

Usage:
    python3 -m ml.world_cup.historical pull        # download default tournaments
    python3 -m ml.world_cup.historical pull --comp 43 --season 3
    python3 -m ml.world_cup.historical status      # summarize what's cached
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .signal_logger import DB_PATH, get_db, init_db


# Explicit aliases for canonical player names. Maps any-variant → canonical.
# Each canonical form is the one used by Odds API / our prop feeds (typically
# the form a casual bettor would type). Add here when we discover new variants
# in the DB — they get applied on every write and to historical lookups.
_PLAYER_NAME_ALIASES: Dict[str, str] = {
    # StatsBomb full name → Odds API / Sportmonks short form
    # Every alias key is post-NFKD-strip + lowercase + alphanumeric-only.
    # When growing this list, add EVERY variant we observe across sources —
    # initialed first name, full legal name, display name with accents,
    # nickname. The canonical form on the right is what gets stored.
    "cristiano ronaldo dos santos aveiro": "Cristiano Ronaldo",
    "cristiano ronaldo":                   "Cristiano Ronaldo",
    "c ronaldo":                           "Cristiano Ronaldo",
    "kylian mbappe lottin":                "Kylian Mbappe",
    "kylian mbappe":                       "Kylian Mbappe",
    "k mbappe":                            "Kylian Mbappe",
    "neymar da silva santos junior":       "Neymar",
    "neymar jr":                           "Neymar",
    "lionel andres messi cuccittini":      "Lionel Messi",
    "leo messi":                           "Lionel Messi",
    "l messi":                             "Lionel Messi",
    "lionel messi":                        "Lionel Messi",
    "vinicius jose paixao de oliveira junior": "Vinicius Junior",
    "vinicius jr":                         "Vinicius Junior",
    "vinicius junior":                     "Vinicius Junior",
    "vini jr":                             "Vinicius Junior",
    "rodrygo silva de goes":               "Rodrygo",
    "rodrygo goes":                        "Rodrygo",
    "robert lewandowski":                  "Robert Lewandowski",
    "r lewandowski":                       "Robert Lewandowski",
    "harry kane":                          "Harry Kane",
    "h kane":                              "Harry Kane",
    "jude bellingham":                     "Jude Bellingham",
    "j bellingham":                        "Jude Bellingham",
    "erling braut haaland":                "Erling Haaland",
    "erling haaland":                      "Erling Haaland",
    "e haaland":                           "Erling Haaland",
    "lautaro javier martinez":             "Lautaro Martinez",
    "lautaro martinez":                    "Lautaro Martinez",
    # ── Additional canonical aliases added in M14 ──────────────────────
    # WC 2026 starters whose StatsBomb and Sportmonks names diverge enough
    # to break the squad ↔ historical join.
    # Keys MUST be post-NFKD-strip + lowercase + alphanumeric-only.
    # Diacritics, dashes, and apostrophes are stripped to space by the
    # normalize function before lookup — DON'T put them in the keys here.
    "viktor gyokeres":                     "Viktor Gyokeres",
    "v gyokeres":                          "Viktor Gyokeres",
    "victor osimhen":                      "Victor Osimhen",
    "v osimhen":                           "Victor Osimhen",
    "bukayo saka":                         "Bukayo Saka",
    "b saka":                              "Bukayo Saka",
    "rodri":                               "Rodri",
    "rodrigo hernandez cascante":          "Rodri",
    "rodrigo hernandez":                   "Rodri",
    "hakan calhanoglu":                    "Hakan Calhanoglu",
    "florian wirtz":                       "Florian Wirtz",
    "f wirtz":                             "Florian Wirtz",
    "jamal musiala":                       "Jamal Musiala",
    "j musiala":                           "Jamal Musiala",
    "phil foden":                          "Phil Foden",
    "p foden":                             "Phil Foden",
    "ousmane dembele":                     "Ousmane Dembele",
    "o dembele":                           "Ousmane Dembele",
    "antoine griezmann":                   "Antoine Griezmann",
    "a griezmann":                         "Antoine Griezmann",
    "lamine yamal":                        "Lamine Yamal",
    "l yamal":                             "Lamine Yamal",
    "pedri":                               "Pedri",
    "pedro gonzalez lopez":                "Pedri",
    "gavi":                                "Gavi",
    "pablo gavi":                          "Gavi",
    "pablo martin paez gavira":            "Gavi",
    "matheus cunha":                       "Matheus Cunha",
    "m cunha":                             "Matheus Cunha",
    "raphinha":                            "Raphinha",
    "raphael dias belloli":                "Raphinha",
    "endrick":                             "Endrick",
    "endrick felipe moreira de sousa":     "Endrick",
    "igor thiago":                         "Igor Thiago",
    "i thiago":                            "Igor Thiago",
    "joao felix":                          "Joao Felix",
    "j felix":                             "Joao Felix",
    "bruno fernandes":                     "Bruno Fernandes",
    "b fernandes":                         "Bruno Fernandes",
    "rafael leao":                         "Rafael Leao",
    "r leao":                              "Rafael Leao",
    "kai havertz":                         "Kai Havertz",
    "k havertz":                           "Kai Havertz",
    "julian alvarez":                      "Julian Alvarez",
    "j alvarez":                           "Julian Alvarez",
    "kingsley coman":                      "Kingsley Coman",
    "k coman":                             "Kingsley Coman",
    "marcus rashford":                     "Marcus Rashford",
    "m rashford":                          "Marcus Rashford",
    # Dashes become spaces in the key, so "son heung-min" → "son heung min"
    "son heung min":                       "Son Heung-min",
    "son heungmin":                        "Son Heung-min",
    "heung min son":                       "Son Heung-min",
    "memphis depay":                       "Memphis Depay",
    "memphis":                             "Memphis Depay",
    "achraf hakimi":                       "Achraf Hakimi",
    "a hakimi":                            "Achraf Hakimi",
    "nicolas jackson":                     "Nicolas Jackson",
    "n jackson":                           "Nicolas Jackson",
    "khvicha kvaratskhelia":               "Khvicha Kvaratskhelia",
    "k kvaratskhelia":                     "Khvicha Kvaratskhelia",
    "olivier giroud":                      "Olivier Giroud",
    "o giroud":                            "Olivier Giroud",
    "alvaro morata":                       "Alvaro Morata",
    "a morata":                            "Alvaro Morata",
    "diogo jota":                          "Diogo Jota",
    "d jota":                              "Diogo Jota",
    "ruben dias":                          "Ruben Dias",
    "r dias":                              "Ruben Dias",
}


def _normalize_player_name(name: Optional[str]) -> str:
    """Canonicalize a player name across data sources.

    StatsBomb uses full legal names ("Cristiano Ronaldo dos Santos Aveiro");
    API-Football uses short forms ("C. Ronaldo" / "Cristiano Ronaldo"); Odds
    API uses the casual-bettor form ("Cristiano Ronaldo"). Without a single
    canonical key these are three separate rows and our prior lookup fails.

    Strategy:
      1. Strip accents/diacritics (Mbappé → Mbappe) so the alias map works
         regardless of how the upstream encoded the name.
      2. Lowercase, collapse whitespace, strip punctuation — produce a stable
         lookup key.
      3. If the key matches a known alias, return the canonical form.
      4. Otherwise return the input name with whitespace collapsed (no other
         changes — we don't want to mangle unknown names, just dedupe known
         multi-variant cases).
    """
    if not name:
        return ""
    # Step 1+2: build a stable lookup key
    stripped = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in stripped if not unicodedata.combining(c))
    key = re.sub(r"[^a-z0-9 ]+", " ", stripped.lower())
    key = re.sub(r"\s+", " ", key).strip()

    # Step 3: known alias?
    if key in _PLAYER_NAME_ALIASES:
        return _PLAYER_NAME_ALIASES[key]

    # Step 4: unknown name — return the original with whitespace collapsed
    return re.sub(r"\s+", " ", name).strip()

STATSBOMB_BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"

# (competition_id, season_id, display_name)
DEFAULT_COMPETITIONS: List[Tuple[int, int, str]] = [
    (43, 3,   "WC 2018"),
    (43, 106, "WC 2022"),
    (55, 43,  "Euro 2020"),
    (55, 282, "Euro 2024"),
]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def init_historical_tables(path: Path = DB_PATH) -> None:
    """Add the wc_historical_form table. Additive only — won't disturb the
    existing players.py / context.py / signal_logger schemas."""
    init_db(path)
    conn = get_db(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS wc_historical_form (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            player_name         TEXT NOT NULL,
            competition         TEXT NOT NULL,   -- 'WC 2018' | 'WC 2022' | 'Euro 2024' etc.
            country             TEXT,
            matches_played      INTEGER DEFAULT 0,
            minutes             INTEGER DEFAULT 0,
            goals               INTEGER DEFAULT 0,
            shots               INTEGER DEFAULT 0,
            shots_on_target     INTEGER DEFAULT 0,
            assists             INTEGER DEFAULT 0,
            updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(player_name, competition)
        );

        CREATE INDEX IF NOT EXISTS idx_hist_form_player
            ON wc_historical_form(player_name);
        CREATE INDEX IF NOT EXISTS idx_hist_form_comp
            ON wc_historical_form(competition);
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# StatsBomb fetchers
# ---------------------------------------------------------------------------

def _get_json(url: str) -> Optional[Any]:
    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"  [historical] fetch error {url}: {e}", file=sys.stderr)
        return None


def fetch_matches(competition_id: int, season_id: int) -> List[Dict[str, Any]]:
    """Pull the match list for a competition+season. Returns list of match
    dicts each with match_id, home_team, away_team, scores, etc."""
    url = f"{STATSBOMB_BASE}/matches/{competition_id}/{season_id}.json"
    data = _get_json(url) or []
    return data if isinstance(data, list) else []


def fetch_lineup(match_id: int) -> List[Dict[str, Any]]:
    """Two teams' lineups for a match. Each team's lineup is a list of
    players with player_id, player_name, jersey_number, and 'positions'
    (with start/end minutes per position spell)."""
    url = f"{STATSBOMB_BASE}/lineups/{match_id}.json"
    data = _get_json(url) or []
    return data if isinstance(data, list) else []


def fetch_events(match_id: int) -> List[Dict[str, Any]]:
    """All events for a match. Each event has a 'type' (e.g. Shot, Pass) and
    a 'player' (when applicable). For our use we only care about shots."""
    url = f"{STATSBOMB_BASE}/events/{match_id}.json"
    data = _get_json(url) or []
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# Per-match player aggregation
# ---------------------------------------------------------------------------

def _player_minutes_from_lineups(lineup_data: List[Dict[str, Any]], match_length: int = 95) -> Dict[str, int]:
    """Derive per-player minutes from StatsBomb lineup 'positions' spells.

    StatsBomb 'positions' is a list of dicts each with from/to minute info.
    If a player has any positions list, we sum (to - from) across spells.
    If positions are empty, the player was on the bench / didn't play.

    match_length defaults to 95 (FT + stoppage). Knockout games with ET
    will be slightly under-counted, but the prior math doesn't need
    minute-perfect accuracy here."""
    out: Dict[str, int] = {}
    for team in lineup_data:
        for p in team.get("lineup", []) or []:
            name = p.get("player_name") or ""
            if not name:
                continue
            positions = p.get("positions", []) or []
            mins = 0
            for spell in positions:
                start = spell.get("from")
                end   = spell.get("to") or match_length
                try:
                    # StatsBomb stores time as "MM:SS" or just minute int
                    s_min = _parse_clock(start) if start else 0
                    e_min = _parse_clock(end) if end else match_length
                    mins += max(0, e_min - s_min)
                except Exception:
                    continue
            out[name] = out.get(name, 0) + mins
    return out


def _parse_clock(v: Any) -> int:
    """StatsBomb timestamps come as 'MM:SS' or 'HH:MM:SS' strings or as
    floats representing minutes. Normalize to an integer minute value."""
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        parts = v.split(":")
        if len(parts) == 2:
            return int(parts[0])
        if len(parts) == 3:
            return int(parts[0]) * 60 + int(parts[1])
    return 0


def _is_shootout_event(ev: Dict[str, Any]) -> bool:
    """StatsBomb encodes the post-ET penalty shootout as period 5. Regulation
    is 1-2, extra time is 3-4. Shootout 'goals' are not real goals in any
    statistical sense — they don't count toward Golden Boot, don't appear in
    g/90 stats, and inflate our priors. Filter them out."""
    period = ev.get("period")
    if isinstance(period, (int, float)) and period >= 5:
        return True
    # Defensive: some events tag shot.type.name == "Penalty" with a
    # shootout-context marker. Real in-match penalties stay in period 1-4.
    return False


def _shot_outcomes_by_player(events: List[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    """Process an events list into per-player shot/goal/SOT counts.

    StatsBomb event of type 'Shot' has player.name, shot.outcome.name
    (one of: Goal, Saved, Saved To Post, Saved Off Target, Off T,
    Wayward, Blocked, Post). We treat 'Goal' as goal+shot+SOT,
    'Saved*' as shot+SOT (keeper handled it = was on target), and
    everything else as shot only.

    Penalty-shootout events (period >= 5) are excluded — they aren't goals
    in any meaningful statistical sense and inflate priors."""
    by_player: Dict[str, Dict[str, int]] = {}
    for ev in events:
        if (ev.get("type") or {}).get("name") != "Shot":
            continue
        if _is_shootout_event(ev):
            continue
        player = (ev.get("player") or {}).get("name", "")
        if not player:
            continue
        d = by_player.setdefault(player, {"shots": 0, "sot": 0, "goals": 0})
        d["shots"] += 1
        outcome = ((ev.get("shot") or {}).get("outcome") or {}).get("name", "")
        if outcome == "Goal":
            d["goals"] += 1
            d["sot"]   += 1
        elif outcome.startswith("Saved"):
            d["sot"]   += 1
    return by_player


def _assists_by_player(events: List[Dict[str, Any]]) -> Dict[str, int]:
    """An assist in StatsBomb is encoded on the 'Pass' event preceding a
    goal as pass.goal_assist == True OR as ['Shot Assist', 'Goal Assist']
    types depending on schema version. We accept either.

    Shootout events (period >= 5) are excluded — no assists in a shootout."""
    out: Dict[str, int] = {}
    for ev in events:
        if _is_shootout_event(ev):
            continue
        name = (ev.get("player") or {}).get("name", "")
        if not name:
            continue
        # Schema 1: Pass with goal_assist flag
        passdat = ev.get("pass") or {}
        if passdat.get("goal_assist"):
            out[name] = out.get(name, 0) + 1
            continue
        # Schema 2: dedicated 'Goal Assist' event type
        if (ev.get("type") or {}).get("name") in ("Goal Assist", "Shot Assist"):
            # Only Goal Assist counts; Shot Assist is just a key-pass
            if (ev.get("type") or {}).get("name") == "Goal Assist":
                out[name] = out.get(name, 0) + 1
    return out


def process_match(match: Dict[str, Any]) -> Dict[str, Dict[str, int]]:
    """Return per-player per-match stats for one match. Pulls lineups +
    events from StatsBomb and aggregates."""
    match_id = match.get("match_id")
    if not match_id:
        return {}

    lineup = fetch_lineup(match_id)
    events = fetch_events(match_id)
    if not lineup or not events:
        return {}

    minutes_by  = _player_minutes_from_lineups(lineup)
    shots_by    = _shot_outcomes_by_player(events)
    assists_by  = _assists_by_player(events)

    out: Dict[str, Dict[str, int]] = {}
    for name, mins in minutes_by.items():
        d = out.setdefault(name, {"matches_played": 0, "minutes": 0,
                                  "goals": 0, "shots": 0, "sot": 0, "assists": 0})
        d["matches_played"] = 1
        d["minutes"]        = mins
        sh                  = shots_by.get(name, {})
        d["goals"]          = sh.get("goals", 0)
        d["shots"]          = sh.get("shots", 0)
        d["sot"]            = sh.get("sot", 0)
        d["assists"]        = assists_by.get(name, 0)
    return out


# ---------------------------------------------------------------------------
# Tournament-level pull
# ---------------------------------------------------------------------------

def download_competition(
    competition_id: int,
    season_id: int,
    display_name: str,
    path: Path = DB_PATH,
) -> int:
    """Pull every match in a competition and upsert aggregated per-player
    stats into wc_historical_form. Returns the number of player rows touched.

    Bandwidth note: each match's events file is 3-5 MB. A full WC is ~64
    matches → 200-300 MB downloaded. Stored output after aggregation is
    only a few thousand SQLite rows, no large blobs."""
    init_historical_tables(path)
    matches = fetch_matches(competition_id, season_id)
    if not matches:
        print(f"  [historical] No matches returned for {display_name}")
        return 0

    print(f"  [historical] {display_name}: {len(matches)} matches found, processing...")

    # Aggregate across all matches of this competition
    totals: Dict[str, Dict[str, Any]] = {}
    for i, m in enumerate(matches, start=1):
        if i % 8 == 0:
            print(f"  [historical] {display_name}: {i}/{len(matches)} matches processed")
        try:
            per_match = process_match(m)
        except Exception as e:
            print(f"  [historical] match {m.get('match_id')} error: {e}", file=sys.stderr)
            continue
        for name, stats in per_match.items():
            t = totals.setdefault(name, {
                "matches_played": 0, "minutes": 0,
                "goals": 0, "shots": 0, "sot": 0, "assists": 0,
                "country": None,
            })
            t["matches_played"] += stats["matches_played"]
            t["minutes"]        += stats["minutes"]
            t["goals"]          += stats["goals"]
            t["shots"]          += stats["shots"]
            t["sot"]            += stats["sot"]
            t["assists"]        += stats["assists"]

    # Resolve each player's national team from the lineup data of any match
    # they appeared in. The lineup file has team.name for each side. Iterate
    # ALL matches (previously capped at 8 — that sample missed ~20 of 32 WC
    # teams). Short-circuit per match as soon as every player in `totals`
    # already has a country, so we don't waste fetches on later matches.
    name_to_country: Dict[str, str] = {}
    target_names = set(totals.keys())
    for m in matches:
        if target_names and target_names.issubset(name_to_country.keys()):
            break  # every player we care about already has a country
        lineup = fetch_lineup(m.get("match_id"))
        for team in lineup:
            country = team.get("team_name") or ""
            for p in team.get("lineup", []) or []:
                pname = p.get("player_name") or ""
                if pname and pname not in name_to_country:
                    name_to_country[pname] = country

    # Collapse multi-variant names BEFORE writing, so a single player who
    # appears under both their full and short form in StatsBomb data lands
    # as one row, not two.
    merged: Dict[str, Dict[str, Any]] = {}
    for name, t in totals.items():
        canonical = _normalize_player_name(name)
        m = merged.setdefault(canonical, {
            "matches_played": 0, "minutes": 0,
            "goals": 0, "shots": 0, "sot": 0, "assists": 0,
            "country": None,
        })
        m["matches_played"] += t["matches_played"]
        m["minutes"]        += t["minutes"]
        m["goals"]          += t["goals"]
        m["shots"]          += t["shots"]
        m["sot"]            += t["sot"]
        m["assists"]        += t["assists"]
        m["country"] = m["country"] or name_to_country.get(name)

    conn = get_db(path)
    upserted = 0
    for canonical, t in merged.items():
        conn.execute(
            """INSERT INTO wc_historical_form
               (player_name, competition, country, matches_played, minutes,
                goals, shots, shots_on_target, assists, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
               ON CONFLICT(player_name, competition) DO UPDATE SET
                 country         = COALESCE(excluded.country, country),
                 matches_played  = excluded.matches_played,
                 minutes         = excluded.minutes,
                 goals           = excluded.goals,
                 shots           = excluded.shots,
                 shots_on_target = excluded.shots_on_target,
                 assists         = excluded.assists,
                 updated_at      = excluded.updated_at""",
            (canonical, display_name, t["country"],
             t["matches_played"], t["minutes"],
             t["goals"], t["shots"], t["sot"], t["assists"]),
        )
        upserted += 1

    conn.commit()
    conn.close()
    print(f"  [historical] {display_name}: {upserted} player rows upserted")
    return upserted


def download_default(path: Path = DB_PATH) -> Dict[str, int]:
    """Pull all four default tournaments. Resumes / upserts gracefully."""
    out: Dict[str, int] = {}
    for cid, sid, name in DEFAULT_COMPETITIONS:
        try:
            out[name] = download_competition(cid, sid, name, path)
        except Exception as e:
            print(f"  [historical] {name} failed: {e}", file=sys.stderr)
            out[name] = 0
    return out


def dedupe_historical_form(path: Path = DB_PATH) -> Dict[str, int]:
    """One-off cleanup: collapse multi-variant player rows in wc_historical_form
    that were written before name normalization was added.

    For each (canonical_name, competition) bucket, sum the stats across all
    variant rows, take the first non-null country, then replace the variant
    rows with the canonical aggregate. Returns counts: rows_before, rows_after,
    rows_collapsed."""
    init_historical_tables(path)
    conn = get_db(path)

    before = conn.execute("SELECT COUNT(*) FROM wc_historical_form").fetchone()[0]
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM wc_historical_form"
    ).fetchall()]

    merged: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        canonical = _normalize_player_name(r["player_name"])
        key = (canonical, r["competition"])
        m = merged.setdefault(key, {
            "country": None,
            "matches_played": 0, "minutes": 0,
            "goals": 0, "shots": 0, "shots_on_target": 0, "assists": 0,
        })
        # When the *same* canonical key appears multiple times (the bug we're
        # fixing), choose the max for each stat field rather than summing —
        # the variants typically duplicate the same matches under different
        # name spellings, so summing would double-count. Max is the
        # conservative choice that preserves the larger sample's count.
        m["matches_played"] = max(m["matches_played"], r["matches_played"] or 0)
        m["minutes"]        = max(m["minutes"],        r["minutes"]        or 0)
        m["goals"]          = max(m["goals"],          r["goals"]          or 0)
        m["shots"]          = max(m["shots"],          r["shots"]          or 0)
        m["shots_on_target"]= max(m["shots_on_target"],r["shots_on_target"]or 0)
        m["assists"]        = max(m["assists"],        r["assists"]        or 0)
        m["country"]        = m["country"] or r["country"]

    # Wipe and rewrite the table in one transaction. Cheap — table is small.
    conn.execute("DELETE FROM wc_historical_form")
    for (canonical, comp), m in merged.items():
        conn.execute(
            """INSERT INTO wc_historical_form
               (player_name, competition, country, matches_played, minutes,
                goals, shots, shots_on_target, assists, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))""",
            (canonical, comp, m["country"],
             m["matches_played"], m["minutes"], m["goals"],
             m["shots"], m["shots_on_target"], m["assists"]),
        )
    conn.commit()

    after = conn.execute("SELECT COUNT(*) FROM wc_historical_form").fetchone()[0]
    conn.close()
    collapsed = before - after
    print(f"  [historical] dedupe: {before} → {after} rows ({collapsed} collapsed)")
    return {"rows_before": before, "rows_after": after, "rows_collapsed": collapsed}


# ---------------------------------------------------------------------------
# Lookup helpers — used by players.compute_goalscorer_prior to layer in
# tournament history.
# ---------------------------------------------------------------------------

def get_historical_form(player_name: str, path: Path = DB_PATH) -> List[Dict[str, Any]]:
    """Return all historical-tournament rows for a player, most recent first.

    Normalizes the input name through the alias map so a query for
    "Cristiano Ronaldo" still matches a row stored under the canonical form,
    even if the original write came from a source using the full legal name."""
    init_historical_tables(path)
    canonical = _normalize_player_name(player_name)
    conn = get_db(path)
    rows = conn.execute(
        """SELECT * FROM wc_historical_form
           WHERE player_name = ?
           ORDER BY competition DESC""",
        (canonical,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def historical_goals_per_90(player_name: str, path: Path = DB_PATH) -> Optional[float]:
    """Aggregate goals/90 across all cached tournaments for one player.
    Returns None if total minutes < 180 (under 2 full matches — too thin)."""
    rows = get_historical_form(player_name, path)
    total_min   = sum(r["minutes"] for r in rows)
    total_goals = sum(r["goals"]   for r in rows)
    if total_min < 180:
        return None
    return total_goals / (total_min / 90.0)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="StatsBomb historical pull")
    parser.add_argument(
        "command",
        choices=["pull", "status", "dedupe"],
        help=(
            "pull = download default tournaments (WC 2018, WC 2022, Euro 2020, Euro 2024) | "
            "dedupe = collapse multi-variant player rows already in the DB (one-off)"
        ),
    )
    parser.add_argument("--comp", type=int, help="StatsBomb competition_id (optional override)")
    parser.add_argument("--season", type=int, help="StatsBomb season_id (optional override)")
    parser.add_argument("--name", type=str, help="Display name when overriding")
    args = parser.parse_args()

    if args.command == "pull":
        if args.comp is not None and args.season is not None:
            download_competition(args.comp, args.season, args.name or f"{args.comp}/{args.season}")
        else:
            download_default()
    elif args.command == "dedupe":
        dedupe_historical_form()
    elif args.command == "status":
        init_historical_tables()
        conn = get_db()
        comps = conn.execute(
            "SELECT competition, COUNT(*) AS n, SUM(goals) AS g, SUM(minutes) AS m "
            "FROM wc_historical_form GROUP BY competition ORDER BY competition"
        ).fetchall()
        if not comps:
            print("  No historical data cached. Run: python3 -m ml.world_cup.historical pull")
        else:
            print("  Tournament         Players  Goals  Minutes")
            print("  ----------------  --------  -----  -------")
            for r in comps:
                print(f"  {r[0]:16s}  {r[1]:8d}  {r[2] or 0:5d}  {r[3] or 0:7d}")
        # Top historical scorers
        top = conn.execute(
            "SELECT player_name, SUM(goals) AS g, SUM(matches_played) AS m "
            "FROM wc_historical_form GROUP BY player_name "
            "HAVING g > 0 ORDER BY g DESC LIMIT 10"
        ).fetchall()
        if top:
            print("\n  Top historical scorers in cache:")
            for r in top:
                print(f"    {r[0]:30s}  {r[1]}g in {r[2]} matches")
        conn.close()
