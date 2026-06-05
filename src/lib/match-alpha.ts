import { spawnSync } from "child_process";
import type { Game } from "@/types/game";
import type { PreparedGameIntel } from "@/lib/game-intel-cache";

export type MatchAlphaTone = "good" | "warn" | "neutral" | "alert";

export interface MatchAlphaCard {
  label: string;
  title: string;
  detail: string;
  tone: MatchAlphaTone;
}

export interface MatchAlphaCoverage {
  sportmonksBundle: boolean;
  fixtureId: string | null;
  lineups: number;
  starters: number;
  bench: number;
  sidelined: number;
  events: number;
  statistics: number;
  predictions: number;
  stateName: string | null;
  fetchedAt: string | null;
}

export interface MatchAlphaDigest {
  cards: MatchAlphaCard[];
  gaps: string[];
  coverage: MatchAlphaCoverage;
}

const emptyCoverage: MatchAlphaCoverage = {
  sportmonksBundle: false,
  fixtureId: null,
  lineups: 0,
  starters: 0,
  bench: 0,
  sidelined: 0,
  events: 0,
  statistics: 0,
  predictions: 0,
  stateName: null,
  fetchedAt: null,
};

function safeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function firstSentence(text: string, max = 170): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function sportmonksDigest(game: Game): MatchAlphaCoverage {
  if (!game.sport.startsWith("soccer")) return emptyCoverage;
  const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
  const script = `
import json, sqlite3
from ml.soccer.sportmonks_fixture import get_cached_bundle_by_teams
from ml.world_cup.signal_logger import DB_PATH
home=${JSON.stringify(game.home_team)}
away=${JSON.stringify(game.away_team)}
commence=${JSON.stringify(game.commence_time)}
game_id=${JSON.stringify(game.id)}
b = get_cached_bundle_by_teams(home, away, commence_time_iso=commence, window_hours=72) or get_cached_bundle_by_teams(away, home, commence_time_iso=commence, window_hours=72)
out = {
  "sportmonksBundle": bool(b),
  "fixtureId": str(b.get("fixture_id")) if b else None,
  "lineups": len(b.get("lineups") or []) if b else 0,
  "starters": sum(1 for x in (b.get("lineups") or []) if x.get("is_starter")) if b else 0,
  "bench": sum(1 for x in (b.get("lineups") or []) if not x.get("is_starter")) if b else 0,
  "sidelined": 0,
  "events": len(b.get("events") or []) if b else 0,
  "statistics": 0,
  "predictions": len(b.get("predictions") or {}) if b else 0,
  "stateName": None,
  "fetchedAt": b.get("fetched_at") if b else None,
}
try:
  conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
  row=conn.execute("SELECT * FROM soccer_fixture_feature_snapshot WHERE game_id = ? AND provider = 'sportmonks'", (game_id,)).fetchone()
  if row:
    out.update({
      "stateName": row["state_name"],
      "lineups": row["lineup_count"] or out["lineups"],
      "starters": row["starters_count"] or out["starters"],
      "bench": row["bench_count"] or out["bench"],
      "sidelined": row["sidelined_count"] or 0,
      "events": row["event_count"] or out["events"],
      "statistics": row["statistic_count"] or 0,
      "fixtureId": row["provider_fixture_id"] or out["fixtureId"],
      "sportmonksBundle": True,
    })
  conn.close()
except Exception:
  pass
print(json.dumps(out))
`;
  const r = spawnSync("python3", ["-c", script], { cwd: appRoot, encoding: "utf-8", timeout: 6_000 });
  try {
    return { ...emptyCoverage, ...JSON.parse(r.stdout) } as MatchAlphaCoverage;
  } catch {
    return emptyCoverage;
  }
}

export function getMatchAlphaDigest(game: Game, prepared: PreparedGameIntel | null): MatchAlphaDigest {
  const coverage = sportmonksDigest(game);
  const stories = prepared?.stories ?? [];
  const injuries = prepared?.injuryAlerts ?? [];
  const cards: MatchAlphaCard[] = [];
  const gaps: string[] = [];

  if (coverage.sportmonksBundle) {
    if (coverage.lineups > 0) {
      cards.push({
        label: "Lineups",
        title: coverage.starters >= 22 ? "Starting XIs are in" : `${coverage.lineups} names on the team sheet`,
        detail: coverage.sidelined ? `${coverage.sidelined} players are unavailable. Check the shape before forcing a read.` : "No major lineup shock showing yet. The shape is the thing to check next.",
        tone: coverage.starters >= 22 ? "good" : "neutral",
      });
    } else {
      gaps.push("Lineups are not out yet.");
    }

    if (coverage.events || coverage.statistics) {
      cards.push({
        label: "Match flow",
        title: `${coverage.events} key moments tracked`,
        detail: coverage.stateName ? `${coverage.stateName}. Watch goals, cards and subs before reading too much into the live price.` : "Goals, cards and subs are available for this match.",
        tone: coverage.events ? "good" : "neutral",
      });
    }

    if (coverage.predictions > 0) {
      cards.push({
        label: "Model check",
        title: `${coverage.predictions} angles to compare`,
        detail: "Useful for spotting disagreement, not enough by itself to force a bet.",
        tone: "neutral",
      });
    }
  } else if (game.sport.startsWith("soccer")) {
    gaps.push("No major pre-match signal yet.");
  }

  if (injuries.length) {
    cards.push({
      label: "Team news",
      title: `${injuries.length} injury/suspension flag${injuries.length === 1 ? "" : "s"}`,
      detail: injuries.slice(0, 2).map((i) => `${i.playerName} ${i.status} (${i.teamName})`).join(" · "),
      tone: "alert",
    });
  }

  const lead = stories.find((s) => safeText(s.detail).length > 35);
  if (lead) {
    cards.push({
      label: "Context shift",
      title: safeText(lead.title),
      detail: firstSentence(safeText(lead.detail)),
      tone: "neutral",
    });
  }

  const awaySummary = prepared?.awayForm?.summary;
  const homeSummary = prepared?.homeForm?.summary;
  const hot = [
    awaySummary ? { team: game.away_team, run: awaySummary.run, form: awaySummary.form } : null,
    homeSummary ? { team: game.home_team, run: homeSummary.run, form: homeSummary.form } : null,
  ].filter(Boolean) as Array<{ team: string; run?: string | null; form: string }>;
  const notableRun = hot.find((x) => x.run);
  if (notableRun) {
    cards.push({
      label: "Form note",
      title: `${notableRun.team}: ${notableRun.run}`,
      detail: `Recent form: ${notableRun.form}. Useful context, but not enough alone to force a position.`,
      tone: "neutral",
    });
  }

  if (!cards.length) {
    cards.push({
      label: "Quiet so far",
      title: "No clear angle yet",
      detail: "Nothing meaningful has changed. This gets more interesting when lineups, team news or live events start to move.",
      tone: "warn",
    });
  }

  return { cards: cards.slice(0, 4), gaps, coverage };
}
