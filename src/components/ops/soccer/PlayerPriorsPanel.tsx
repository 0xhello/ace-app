"use client";

/**
 * PlayerPriorsPanel — surfaces the WC player intelligence layer we've been
 * building (StatsBomb historical aggregates + API-Football intl
 * tournament data + computed goalscorer priors).
 *
 * Until this panel landed, all that data lived in SQLite invisibly. Now
 * the user can see the 2,924-row wc_historical_form table as Mbappé,
 * Ronaldo, Kane, etc. with goals/90 and competition list — and once the
 * squads sync runs, the panel additively pulls in position/team/prior.
 *
 * Inputs:
 *   - /api/ops/wc-players (this file owns the fetch)
 *
 * Defensive behavior:
 *   - Empty historical_rows: explains we need to run the StatsBomb pull
 *   - Squads empty: shows the "career history" view only (no positions
 *     until squads sync) — still useful
 *   - Priors empty: same, just no anytime_scorer_prob column populated
 */
import { useEffect, useMemo, useState } from "react";
import { Trophy, Search } from "lucide-react";
import { Panel, SectionHead, EmptyState, Tag } from "@/components/ops/shared/primitives";

interface PlayerAggregate {
  player_name: string;
  country: string | null;
  total_goals: number;
  total_minutes: number;
  total_matches: number;
  comps_count: number;
  comps: string[];
  goals_per_90: number | null;
  latest_comp: string | null;
  latest_goals: number;
  latest_minutes: number;
  api_player_id: number | null;
  position: string | null;
  age: number | null;
  shirt_number: number | null;
  team_name: string | null;
  anytime_scorer_prob: number | null;
  first_scorer_prob: number | null;
  expected_goals_lambda: number | null;
}

interface Response {
  players: PlayerAggregate[];
  meta: {
    historical_rows: number;
    historical_competitions: string[];
    squads_rows: number;
    priors_rows: number;
    refreshed_at: string;
  };
  error?: string;
}

type SortKey = "goals" | "gpm" | "comps" | "matches" | "prior";

function fmtRate(v: number | null) {
  return v !== null && v !== undefined ? v.toFixed(2) : "—";
}
function fmtPct(v: number | null) {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export default function PlayerPriorsPanel() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("goals");
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ops/wc-players", { cache: "no-store" });
        const json = await res.json();
        if (alive) setData(json as Response);
      } catch {
        // silent — render an empty state below
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    if (!data?.players) return [];
    const term = q.trim().toLowerCase();
    let rows = data.players;
    if (term) {
      rows = rows.filter((p) =>
        p.player_name.toLowerCase().includes(term) ||
        (p.country ?? "").toLowerCase().includes(term),
      );
    }
    // Stable sort by chosen key. Always tiebreak by total_goals so two
    // players with identical sort values still feel deterministic.
    return rows.slice().sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av !== bv) return bv - av;
      return b.total_goals - a.total_goals;
    });
  }, [data, q, sortKey]);

  if (loading) {
    return (
      <Panel>
        <SectionHead icon={Trophy} title="WC player intelligence" />
        <p className="text-[11px] text-[#6b7068] text-center py-4">Loading…</p>
      </Panel>
    );
  }

  if (!data || data.error) {
    return (
      <Panel>
        <SectionHead icon={Trophy} title="WC player intelligence" />
        <EmptyState>
          Couldn&apos;t load player data{data?.error ? `: ${data.error}` : ""}
        </EmptyState>
      </Panel>
    );
  }

  if (data.meta.historical_rows === 0) {
    return (
      <Panel>
        <SectionHead icon={Trophy} title="WC player intelligence" />
        <EmptyState>
          No historical player data yet. Run the StatsBomb pull via
          {" "}<code className="text-[#3ee68a]">/api/ops/historical-pull</code> to populate this.
        </EmptyState>
      </Panel>
    );
  }

  const visible = filtered.slice(0, limit);
  const haveSquads = data.meta.squads_rows > 0;
  const havePriors = data.meta.priors_rows > 0;

  return (
    <Panel>
      <SectionHead
        icon={Trophy}
        title="WC player intelligence"
        right={
          <div className="flex items-center gap-2">
            <Tag label={`${data.meta.historical_rows.toLocaleString()} player-rows`} color="#3ee68a" />
            <Tag
              label={haveSquads ? `${data.meta.squads_rows} squad players` : "squads pending"}
              color={haveSquads ? "#3ee68a" : "#6b7068"}
            />
            <Tag
              label={havePriors ? `${data.meta.priors_rows} priors` : "priors pending"}
              color={havePriors ? "#3ee68a" : "#6b7068"}
            />
          </div>
        }
      />

      {/* Quick description so users know what they're looking at */}
      <p className="text-[10px] text-[#6b7068] mb-3 leading-relaxed">
        Career aggregates across cached intl tournaments
        ({data.meta.historical_competitions.join(", ")}). g/90 is
        career-rate across these competitions; needs ≥180 mins to compute.
        {!haveSquads && " · Run sync_squads to add team/position joins."}
        {!havePriors && " · Run priors CLI to add goalscorer probabilities."}
      </p>

      {/* Search + sort + limit controls */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5 rounded border border-[#1e2220] bg-[#0a0b0a] px-2 py-1">
          <Search className="h-3 w-3 text-[#4a524a]" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search player or country…"
            className="bg-transparent text-[11px] text-white placeholder:text-[#4a524a] outline-none w-48"
          />
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-[#6b7068] uppercase tracking-[0.12em]">Sort:</span>
          {(["goals", "gpm", "comps", "matches", "prior"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              className={`px-2 py-0.5 rounded uppercase tracking-[0.12em] transition-colors ${
                sortKey === k
                  ? "bg-[#3ee68a]/20 text-[#3ee68a]"
                  : "text-[#6b7068] hover:text-white"
              }`}
            >
              {labelFor(k)}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-[#4a524a]">
          {filtered.length} match{filtered.length !== 1 ? "es" : ""}
        </span>
      </div>

      {/* Table */}
      {visible.length === 0 ? (
        <EmptyState>No players match your filter.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px] font-mono">
            <thead className="text-[#6b7068] uppercase tracking-[0.12em] border-b border-[#1e2220]">
              <tr>
                <th className="py-1.5 px-1 font-semibold">Player</th>
                <th className="py-1.5 px-1 font-semibold">Country</th>
                {haveSquads && <th className="py-1.5 px-1 font-semibold">Pos</th>}
                <th className="py-1.5 px-1 font-semibold text-right">Goals</th>
                <th className="py-1.5 px-1 font-semibold text-right">Matches</th>
                <th className="py-1.5 px-1 font-semibold text-right">g/90</th>
                <th className="py-1.5 px-1 font-semibold">Comps</th>
                {havePriors && (
                  <>
                    <th className="py-1.5 px-1 font-semibold text-right">Any scorer</th>
                    <th className="py-1.5 px-1 font-semibold text-right">First scorer</th>
                    <th className="py-1.5 px-1 font-semibold text-right">xG</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141714]">
              {visible.map((p) => (
                <tr key={p.player_name} className="text-[#c4c7c0]">
                  <td className="py-1.5 px-1 text-white whitespace-nowrap">
                    {p.player_name}
                    {p.shirt_number && (
                      <span className="ml-1 text-[8px] text-[#4a524a]">#{p.shirt_number}</span>
                    )}
                  </td>
                  <td className="py-1.5 px-1 text-[#9ca39a] whitespace-nowrap">{p.country ?? "—"}</td>
                  {haveSquads && (
                    <td className="py-1.5 px-1 text-[#9ca39a] whitespace-nowrap">
                      {p.position ? posShort(p.position) : "—"}
                    </td>
                  )}
                  <td className="py-1.5 px-1 text-right text-[#3ee68a] font-bold">{p.total_goals}</td>
                  <td className="py-1.5 px-1 text-right text-[#9ca39a]">{p.total_matches}</td>
                  <td className="py-1.5 px-1 text-right text-white">
                    {fmtRate(p.goals_per_90)}
                  </td>
                  <td className="py-1.5 px-1 text-[#6b7068]">
                    {p.comps.slice(0, 3).join(", ")}
                    {p.comps.length > 3 && (
                      <span className="text-[#4a524a]"> +{p.comps.length - 3}</span>
                    )}
                  </td>
                  {havePriors && (
                    <>
                      <td className="py-1.5 px-1 text-right">{fmtPct(p.anytime_scorer_prob)}</td>
                      <td className="py-1.5 px-1 text-right">{fmtPct(p.first_scorer_prob)}</td>
                      <td className="py-1.5 px-1 text-right">{fmtRate(p.expected_goals_lambda)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {filtered.length > limit && (
            <div className="mt-3 flex items-center justify-center gap-3">
              <button
                onClick={() => setLimit((n) => n + 30)}
                className="text-[10px] uppercase tracking-[0.12em] text-[#6b7068] hover:text-white px-3 py-1 rounded border border-[#1e2220] hover:border-[#2e332a] transition-colors"
              >
                Show 30 more
              </button>
              <span className="text-[10px] text-[#4a524a]">
                {visible.length} of {filtered.length}
              </span>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function sortValue(p: PlayerAggregate, k: SortKey): number {
  switch (k) {
    case "goals":   return p.total_goals;
    case "gpm":     return p.goals_per_90 ?? -1;
    case "comps":   return p.comps_count;
    case "matches": return p.total_matches;
    case "prior":   return p.anytime_scorer_prob ?? -1;
  }
}
function labelFor(k: SortKey): string {
  switch (k) {
    case "goals":   return "Goals";
    case "gpm":     return "g/90";
    case "comps":   return "Comps";
    case "matches": return "Matches";
    case "prior":   return "Prior";
  }
}
function posShort(p: string): string {
  const s = p.toLowerCase();
  if (s.includes("attack") || s.includes("forward") || s.includes("strik")) return "ATT";
  if (s.includes("mid"))      return "MID";
  if (s.includes("def") || s.includes("back")) return "DEF";
  if (s.includes("goal"))     return "GK";
  return p.slice(0, 3).toUpperCase();
}
