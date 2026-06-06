"use client";

/**
 * FriendliesPanel — data-only international-friendly rehearsal lane.
 *
 * Pulls synced friendly fixture intelligence into the Soccer ops dashboard.
 * This intentionally does not approve or imply picks: friendlies exist here to
 * rehearse live-state coverage before the World Cup match room goes fully live.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowUpRight, CalendarClock, Database, FlaskConical, RefreshCw, UsersRound } from "lucide-react";

interface FriendlySnapshot {
  provider_fixture_id?: string | number | null;
  state_name?: string | null;
  lineup_count?: number | null;
  starters_count?: number | null;
  bench_count?: number | null;
  sidelined_count?: number | null;
  event_count?: number | null;
  statistic_count?: number | null;
  updated_at?: string | null;
  history_count?: number | null;
  latest_history_at?: string | null;
  unavailable?: Array<{ playerName: string; teamName: string; reason?: string | null }>;
}

interface FriendlyFixture {
  game_id: string;
  sport: string;
  sport_title: string;
  provider_fixture_id: string;
  home_team: string;
  away_team: string;
  name?: string | null;
  commence_time: string | null;
  mapped: boolean;
  synced: boolean;
  feature_snapshot?: FriendlySnapshot | null;
  error?: string;
}

interface FriendlyIntelResponse {
  ok: boolean;
  mode?: { sync?: boolean };
  note?: string;
  days?: number;
  limit?: number;
  discovered?: number;
  mapped?: number;
  synced?: number;
  fixtures?: FriendlyFixture[];
  errors?: Array<{ fixture_id?: string | number; error: string }>;
  durationSec?: number;
  error?: string;
}

function fmtKickoff(iso: string | null): string {
  if (!iso) return "TBD";
  try {
    const value = iso.includes("T") ? iso : iso.replace(" ", "T");
    const d = new Date(value.endsWith("Z") ? value : `${value}Z`);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 16);
  }
}

function fmtAge(iso?: string | null): string {
  if (!iso) return "never synced";
  try {
    const d = new Date(String(iso).replace(" ", "T") + (String(iso).includes("Z") ? "" : "Z"));
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
    if (mins < 90) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return "synced";
  }
}

function metricLabel(value: number | null | undefined, fallback = "0") {
  return value == null ? fallback : String(value);
}

function SnapshotStrip({ snapshot }: { snapshot?: FriendlySnapshot | null }) {
  const cells = [
    { label: "Lineups", value: metricLabel(snapshot?.lineup_count), hot: (snapshot?.lineup_count ?? 0) > 0 },
    { label: "XI", value: metricLabel(snapshot?.starters_count), hot: (snapshot?.starters_count ?? 0) >= 22 },
    { label: "Bench", value: metricLabel(snapshot?.bench_count), hot: (snapshot?.bench_count ?? 0) > 0 },
    { label: "Out", value: metricLabel(snapshot?.sidelined_count), hot: (snapshot?.sidelined_count ?? 0) > 0 },
    { label: "Events", value: metricLabel(snapshot?.event_count), hot: (snapshot?.event_count ?? 0) > 0 },
    { label: "Stats", value: metricLabel(snapshot?.statistic_count), hot: (snapshot?.statistic_count ?? 0) > 0 },
  ];
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border border-[#171d16] bg-[#080b08] px-2 py-2">
          <p className="text-[8px] uppercase tracking-[0.16em] text-[#4f574d]">{c.label}</p>
          <p className={`mt-0.5 font-mono text-[12px] font-bold ${c.hot ? "text-[#3ee68a]" : "text-[#8a9286]"}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

export default function FriendliesPanel() {
  const [data, setData] = useState<FriendlyIntelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (sync = false) => {
    if (sync) setSyncing(true); else setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/ops/soccer/sync-friendly-intel?days=7&limit=8${sync ? "&sync=true" : ""}`, {
        cache: "no-store",
        method: sync ? "POST" : "GET",
      });
      const json = await res.json() as FriendlyIntelResponse;
      if (json.ok) setData(json);
      else setErr(json.error || "failed to load friendly rehearsal data");
    } catch (e) {
      setErr(String(e).slice(0, 160));
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const fixtures = useMemo(() => data?.fixtures ?? [], [data]);
  const totals = useMemo(() => {
    let withSnapshot = 0, lineupFixtures = 0, eventFixtures = 0, unavailable = 0;
    for (const f of fixtures) {
      const s = f.feature_snapshot;
      if (s) withSnapshot += 1;
      if ((s?.lineup_count ?? 0) > 0) lineupFixtures += 1;
      if ((s?.event_count ?? 0) > 0 || (s?.statistic_count ?? 0) > 0) eventFixtures += 1;
      unavailable += s?.sidelined_count ?? 0;
    }
    return { withSnapshot, lineupFixtures, eventFixtures, unavailable };
  }, [fixtures]);

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-[#181c18] bg-[#0d0f0d]">
      <header className="px-5 md:px-7 pt-5 pb-4 border-b border-[#151a14]">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="h-3.5 w-3.5 text-[#f5c062]" strokeWidth={1.5} />
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#e6e9e4]">
                Friendlies rehearsal feed
              </h3>
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#f5c062]/12 text-[#f5c062] border border-[#f5c062]/20">
                Data only
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-[#6b7068]">
              WC-team warmups wired into the same match-room state path: mapping, lineups, unavailable players,
              live events and stats. These are rehearsal fixtures, not ACE-validated picks.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void load(false)}
              disabled={loading || syncing}
              className="rounded-lg border border-[#202820] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#8a9286] hover:text-[#d6dbd2] hover:bg-[#111511] disabled:opacity-50 active:translate-y-[1px] transition"
            >
              <RefreshCw className={`mr-1.5 inline h-3 w-3 ${loading ? "animate-spin" : ""}`} strokeWidth={1.5} />
              refresh
            </button>
            <button
              onClick={() => void load(true)}
              disabled={loading || syncing}
              className="rounded-lg border border-[#f5c062]/25 bg-[#f5c062]/[0.05] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#f5c062] hover:bg-[#f5c062]/[0.09] disabled:opacity-50 active:translate-y-[1px] transition"
              title="Explicitly syncs the limited friendly window"
            >
              <Database className={`mr-1.5 inline h-3 w-3 ${syncing ? "animate-pulse" : ""}`} strokeWidth={1.5} />
              {syncing ? "syncing" : "sync window"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            ["Fixtures", fixtures.length],
            ["Snapshots", totals.withSnapshot],
            ["Lineup hits", totals.lineupFixtures],
            ["Unavailable", totals.unavailable],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-[#171d16] bg-[#090c09] px-3 py-2.5">
              <p className="text-[8px] uppercase tracking-[0.18em] text-[#4f574d]">{label}</p>
              <p className="mt-1 font-mono text-[15px] font-black text-[#e6e9e4]">{value}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="px-3 md:px-4 py-4">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-xl bg-[#0a0d0a] animate-pulse" />)}
          </div>
        ) : err ? (
          <div className="rounded-xl border border-[#ef4444]/25 bg-[#ef4444]/[0.05] px-4 py-3 text-[11px] text-[#ef8b8b] flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.5} /> {err}
          </div>
        ) : fixtures.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <CalendarClock className="mx-auto h-6 w-6 text-[#4f574d]" strokeWidth={1.5} />
            <p className="mt-3 text-[12px] font-semibold text-[#d6dbd2]">No friendly fixtures in this window</p>
            <p className="mt-1 text-[11px] text-[#6b7068]">Expand the window later if we need a broader rehearsal slate.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {fixtures.map((f) => {
              const s = f.feature_snapshot;
              const liveish = /live|1st|2nd|half|break/i.test(s?.state_name ?? "");
              return (
                <div key={f.game_id} className="rounded-xl border border-[#181c18] bg-[#0a0d0a] px-4 py-3.5">
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${liveish ? "bg-[#ef4444] animate-pulse" : s ? "bg-[#3ee68a]" : "bg-[#6b7068]"}`} />
                        <h4 className="text-[13px] font-bold text-[#e6e9e4] truncate">
                          {f.away_team} at {f.home_team}
                        </h4>
                        <span className="rounded-md border border-[#202820] px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.12em] text-[#7a8278]">
                          {s?.state_name ?? "mapped"}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#6b7068]">
                        <span>{fmtKickoff(f.commence_time)}</span>
                        <span className="font-mono">{f.game_id}</span>
                        <span>updated {fmtAge(s?.updated_at)}</span>
                      </div>
                    </div>
                    <Link
                      href={`/dashboard/game/${encodeURIComponent(f.game_id)}`}
                      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#24311f] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3ee68a] hover:bg-[#3ee68a]/[0.06] active:translate-y-[1px] transition"
                    >
                      match room <ArrowUpRight className="h-3 w-3" strokeWidth={1.7} />
                    </Link>
                  </div>

                  <div className="mt-3">
                    <SnapshotStrip snapshot={s} />
                  </div>

                  {s?.unavailable?.length ? (
                    <div className="mt-3 flex gap-2 rounded-xl border border-[#2f2413] bg-[#161005] px-3 py-2.5">
                      <UsersRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f5c062]" strokeWidth={1.6} />
                      <p className="text-[11px] leading-relaxed text-[#c8b27b]">
                        {s.unavailable.slice(0, 3).map((p) => `${p.playerName} (${p.teamName})`).join(" · ")}
                        {s.unavailable.length > 3 ? ` +${s.unavailable.length - 3} more` : ""}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
