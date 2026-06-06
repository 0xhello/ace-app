"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, RefreshCw, AlertTriangle, PlusCircle } from "lucide-react";
import { ActionButton, EmptyState, KpiCard, LoadingState, OpsFooter, OpsPageHeader, Panel, SectionHead, Tag } from "@/components/ops/shared/primitives";
import { formatEtDateTime } from "@/lib/time-format";
import { fmtOdds, fmtPp, fmtSport, marketLabel, rowMatchesSearch, rowMatchesSport, sideLabel, type SportFilter, type TrackedPickRow } from "@/components/ops/shared/ledger";
import OpsFilters from "@/components/ops/shared/Filters";

interface TodayResponse {
  source: "tracked_picks";
  available: boolean;
  message?: string;
  open: TrackedPickRow[];
  awaitingGrade: TrackedPickRow[];
  refreshedAt: string;
}

interface ManualPickFormState {
  sport: "mlb" | "nba" | "soccer";
  matchup_label: string;
  market: string;
  side: string;
  line: string;
  book: string;
  odds_american: string;
  commence_time: string;
  notes: string;
}

const EMPTY_MANUAL_PICK: ManualPickFormState = {
  sport: "mlb",
  matchup_label: "",
  market: "h2h",
  side: "home",
  line: "",
  book: "",
  odds_american: "",
  commence_time: "",
  notes: "",
};

function ManualPickPanel({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ManualPickFormState>(EMPTY_MANUAL_PICK);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function update<K extends keyof ManualPickFormState>(key: K, value: ManualPickFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ops/manual-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          line: form.line === "" ? null : Number(form.line),
          odds_american: form.odds_american === "" ? null : Number(form.odds_american),
          commence_time: form.commence_time ? new Date(form.commence_time).toISOString() : null,
          stake_units: 1,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error ?? "Could not add pick");
      setForm(EMPTY_MANUAL_PICK);
      setMessage("Added to paper tracking.");
      await onCreated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not add pick");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <SectionHead
        icon={PlusCircle}
        title="Manual paper pick"
        right={
          <button onClick={() => setOpen((v) => !v)} className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#6b7068] hover:text-[#9ca39a]">
            {open ? "Close" : "Add pick"}
          </button>
        }
      />
      {!open ? (
        <p className="text-[12px] text-[#6b7068]">Record an operator-researched pick in the same paper ledger as model picks. Internal by default.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Sport
              <select value={form.sport} onChange={(e) => update("sport", e.target.value as ManualPickFormState["sport"])} className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none">
                <option value="mlb">MLB</option>
                <option value="nba">NBA</option>
                <option value="soccer">Soccer</option>
              </select>
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a] md:col-span-2">
              Matchup
              <input value={form.matchup_label} onChange={(e) => update("matchup_label", e.target.value)} placeholder="Away @ Home" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Start time
              <input type="datetime-local" value={form.commence_time} onChange={(e) => update("commence_time", e.target.value)} className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none" />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Market
              <input value={form.market} onChange={(e) => update("market", e.target.value)} placeholder="h2h / totals" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Side
              <input value={form.side} onChange={(e) => update("side", e.target.value)} placeholder="home / away / over" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Line
              <input value={form.line} onChange={(e) => update("line", e.target.value)} placeholder="-1.5" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Book
              <input value={form.book} onChange={(e) => update("book", e.target.value)} placeholder="FanDuel" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
            <label className="space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
              Odds
              <input value={form.odds_american} onChange={(e) => update("odds_american", e.target.value)} placeholder="-110" className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
            </label>
          </div>
          <label className="block space-y-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#4a524a]">
            Notes
            <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)} placeholder="Why this is being tracked" rows={2} className="w-full rounded-lg border border-[#1e2220] bg-[#0a0b0a] px-3 py-2 text-[11px] text-white outline-none placeholder:text-[#3a4033]" />
          </label>
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-[#4a524a]">Paper tracking only · internal visibility</p>
            <button onClick={() => void submit()} disabled={saving || !form.matchup_label || !form.market || !form.side} className="rounded-lg border border-[#3ee68a]/20 bg-[#3ee68a]/5 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#3ee68a] hover:bg-[#3ee68a]/10 disabled:opacity-40">
              {saving ? "Adding…" : "Add paper pick"}
            </button>
          </div>
          {message && <p className="text-[11px] text-[#9ca39a]">{message}</p>}
        </div>
      )}
    </Panel>
  );
}

function isStale(row: TrackedPickRow): boolean {
  if (!row.commence_time) return false;
  return new Date(row.commence_time).getTime() < Date.now();
}

function PickTable({ rows }: { rows: TrackedPickRow[] }) {
  if (rows.length === 0) {
    return <EmptyState>No open paper-tracked picks. Model picks will land here when they are tracked.</EmptyState>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[10px] font-mono">
        <thead className="border-b border-[#22251f] text-[#6b7068] uppercase tracking-[0.12em]">
          <tr>
            <th className="px-2 py-2 font-semibold">Sport</th>
            <th className="px-2 py-2 font-semibold">Game</th>
            <th className="px-2 py-2 font-semibold">Pick</th>
            <th className="px-2 py-2 font-semibold">Book</th>
            <th className="px-2 py-2 font-semibold text-right">Edge</th>
            <th className="px-2 py-2 font-semibold">Time</th>
            <th className="px-2 py-2 font-semibold text-center">State</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#181c18]">
          {rows.map((row) => {
            const stale = isStale(row);
            return (
              <tr key={`${row.source_table}-${row.source_id}`} className="text-[#c4c7c0]">
                <td className="px-2 py-2 text-[#9ca39a]">{fmtSport(row.sport)}</td>
                <td className="px-2 py-2">
                  <p className="max-w-[260px] truncate text-white">{row.matchup_label ?? "Matchup TBD"}</p>
                  <p className="text-[9px] text-[#4a524a]">{row.league ?? row.tournament ?? "—"}</p>
                </td>
                <td className="px-2 py-2">
                  <p className="text-white">{sideLabel(row)}</p>
                  <p className="text-[9px] text-[#6b7068]">{marketLabel(row.market)}</p>
                </td>
                <td className="px-2 py-2 text-[#9ca39a]">{row.book ?? "—"} {fmtOdds(row.odds_american)}</td>
                <td className="px-2 py-2 text-right font-bold text-[#3ee68a]">{fmtPp(row.edge_pp)}</td>
                <td className="px-2 py-2 text-[#9ca39a]">{row.commence_time ? formatEtDateTime(row.commence_time) : "TBD"}</td>
                <td className="px-2 py-2 text-center">
                  <Tag label={stale ? "Needs grade" : "Open"} color={stale ? "#f5c062" : "#3ee68a"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TodayOpsTab() {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [grading, setGrading] = useState(false);
  const [gradeMessage, setGradeMessage] = useState<string | null>(null);
  const [sportFilter, setSportFilter] = useState<SportFilter>("all");
  const [query, setQuery] = useState("");

  async function load() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ops/today", { cache: "no-store" });
      setData((await res.json()) as TodayResponse);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function runGrading() {
    setGrading(true);
    setGradeMessage(null);
    try {
      const res = await fetch("/api/ops/grade-tracked-picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      const payload = await res.json();
      if (!res.ok || payload.ok === false) throw new Error(payload.error ?? "Could not run grading");
      setGradeMessage(`Graded ${payload.rows_graded ?? 0} row${payload.rows_graded === 1 ? "" : "s"}.`);
      await load();
    } catch (err) {
      setGradeMessage(err instanceof Error ? err.message : "Could not run grading");
    } finally {
      setGrading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const open = data?.open ?? [];
  const filteredOpen = useMemo(() => open.filter((row) => rowMatchesSport(row, sportFilter) && rowMatchesSearch(row, query)), [open, sportFilter, query]);
  const awaiting = filteredOpen.filter((row) => isStale(row));
  const upcoming = filteredOpen.filter((row) => !isStale(row));

  if (loading) return <LoadingState label="Loading tracked picks…" />;

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 px-6 py-7">
      <OpsPageHeader
        icon={Clock}
        title="Today"
        tag="paper tracking"
        tagColor="#3ee68a"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => void runGrading()}
              disabled={grading}
              className="rounded-lg border border-[#1e2220] bg-[#0d0f0d] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#9ca39a] hover:border-[#3ee68a]/30 hover:text-[#3ee68a] disabled:opacity-40"
            >
              {grading ? "Grading…" : "Run grading"}
            </button>
            <ActionButton icon={RefreshCw} variant="subtle" busy={refreshing} disabled={refreshing} onClick={() => void load()} />
          </div>
        }
      />

      {gradeMessage && (
        <p className="rounded-lg border border-[#1e2220] bg-[#0d0f0d] px-3 py-2 text-[11px] text-[#9ca39a]">{gradeMessage}</p>
      )}

      {!data?.available && (
        <Panel>
          <SectionHead icon={AlertTriangle} title="Ledger unavailable" />
          <p className="text-[12px] text-[#9ca39a]">{data?.message ?? "Canonical tracked-picks ledger has not been imported yet."}</p>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.3fr_1fr_1fr]">
        <KpiCard label="Open tracked" value={String(filteredOpen.length)} sub="filtered paper picks" />
        <KpiCard label="Upcoming" value={String(upcoming.length)} color="#3ee68a" />
        <KpiCard label="Needs grade" value={String(awaiting.length)} color={awaiting.length > 0 ? "#f5c062" : "#9ca39a"} />
      </div>

      <ManualPickPanel onCreated={load} />

      <Panel>
        <SectionHead icon={Clock} title="Open paper-tracked picks" right={<span className="text-[10px] text-[#6b7068]">{filteredOpen.length} rows</span>} />
        <div className="mb-4">
          <OpsFilters
            sport={sportFilter}
            onSportChange={setSportFilter}
            query={query}
            onQueryChange={setQuery}
            resultCount={filteredOpen.length}
            totalCount={open.length}
          />
        </div>
        <PickTable rows={filteredOpen} />
      </Panel>

      <OpsFooter refreshedAt={data?.refreshedAt ?? new Date().toISOString()} schemaText="tracked_picks · Today" />
    </div>
  );
}
