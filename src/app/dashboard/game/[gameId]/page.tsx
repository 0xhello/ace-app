/**
 * /dashboard/game/[gameId] — the dedicated game research + live match-center.
 *
 * Premium, consumer-facing, NO model/no-vig jargon. Reuses the board pipeline
 * (generateIntelMap → ranked news + injuries; odds off the cached board so this
 * never burns Odds API credits) and adds:
 *   • "What the line says" — plain-English market read (marketRead).
 *   • Recent form — last-5 per team, real Sportmonks results (fetchSoccerRecentForm).
 *   • Head-to-head — derived from those results, with an honest low-sample state.
 * Scrolls inside the h-screen/overflow-hidden dashboard layout via its own
 * flex-1 overflow-y-auto root.
 */
import { notFound } from "next/navigation";
import { Newspaper, HeartPulse, BarChart3, Activity, Swords, Radio, Clock3, ShieldCheck, Database, AlertTriangle } from "lucide-react";
import GamePageBackButton from "@/components/dashboard/GamePageBackButton";
import { fetchAllGames } from "@/lib/odds-api";
import { normTeamKey, type TeamRecentForm } from "@/lib/soccer-recent-form";
import { marketRead } from "@/lib/market-read";
import { getPreparedGameIntel, warmGameIntelCacheSoon } from "@/lib/game-intel-cache";
import { getMatchAlphaDigest, type MatchAlphaDigest } from "@/lib/match-alpha";
import { getMockGames } from "@/lib/mock-games";
import { getTeamLogoUrl } from "@/lib/team-logos";
import { getNationFlagUrl } from "@/lib/nation-flags";
import { formatAmericanOdds } from "@/lib/utils";
import { bookMeta } from "@/lib/books";
import * as serverCache from "@/lib/server-cache";
import type { Game } from "@/types/game";

export const dynamic = "force-dynamic";
const IS_DEV = process.env.NODE_ENV !== "production";

async function getGame(id: string): Promise<Game | null> {
  try {
    const entry = await serverCache.get("board-games");
    const hit = (entry?.data?.games ?? []).find((g: Game) => g.id === id);
    if (hit) return hit;
  } catch { /* ignore */ }
  let games: Game[] = [];
  try { games = (await fetchAllGames()).games ?? []; } catch { games = []; }
  if (games.length === 0 && IS_DEV) games = getMockGames();
  return games.find((g) => g.id === id) ?? null;
}

function initials(team: string): string {
  return team.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}
function kickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) + " ET";
  } catch { return "TBD"; }
}
function countdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Kickoff imminent";
  const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d > 0 ? `${d}d ${h}h to kickoff` : `${h}h to kickoff`;
}
function fmtDate(iso: string): string {
  // iso is a date-only "YYYY-MM-DD"; build a local Date to avoid a UTC -1 day shift.
  try {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = (y && m && d) ? new Date(y, m - 1, d) : new Date(iso);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "2-digit" }).format(dt);
  } catch { return iso; }
}
function best(game: Game, market: "h2h" | "spreads" | "totals", name: string) {
  let top: { price: number; book: string; point?: number } | null = null;
  for (const b of game.bookmakers) for (const o of (b.markets[market] ?? [])) {
    if (o.name === name && (!top || o.price > top.price)) top = { price: o.price, book: b.sportsbook, point: o.point };
  }
  return top;
}

function TeamCrest({ team, sport, size = 38 }: { team: string; sport: string; size?: number }) {
  const isSoccer = sport.startsWith("soccer");
  const flag = isSoccer ? getNationFlagUrl(team) : null;
  if (flag) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={flag} alt="" width={size * 1.47} height={size}
        style={{ height: size, width: Math.round(size * 1.47) }}
        className="rounded-md object-cover ring-1 ring-white/10 shadow-[0_4px_14px_-6px_rgba(0,0,0,0.7)]" />
    );
  }
  const logo = getTeamLogoUrl(team, sport);
  return logo
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={logo} alt="" style={{ height: size, width: size }} className="object-contain" />
    : <span style={{ height: size, width: size }} className="rounded-xl bg-[#141814] border border-[#262c24] flex items-center justify-center text-[12px] font-bold text-[#8a9286]">{initials(team)}</span>;
}

function Label({ icon: Icon, children, accent = true }: { icon: any; children: React.ReactNode; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={accent ? "h-3.5 w-3.5 text-[#3ee68a]" : "h-3.5 w-3.5 text-[#6b7068]"} strokeWidth={1.9} />
      <h2 className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-[#aab0a4]">{children}</h2>
    </div>
  );
}

const RES_CLASS: Record<string, string> = {
  W: "bg-[#16331f] text-[#5fe39a] ring-[#215a2e]",
  D: "bg-[#2a2710] text-[#d8c879] ring-[#3a3518]",
  L: "bg-[#331515] text-[#ef8e8e] ring-[#4a2020]",
};
function FormPills({ form }: { form: string }) {
  // form is newest→oldest; show oldest→newest left-to-right for a natural timeline
  const letters = form.split("").reverse();
  return (
    <div className="flex gap-1">
      {letters.map((c, i) => (
        <span key={i} className={`h-5 w-5 rounded-[5px] flex items-center justify-center text-[10px] font-bold font-mono ring-1 ${RES_CLASS[c] ?? "bg-[#16181500] text-[#6b7068] ring-[#262c24]"}`}>{c}</span>
      ))}
    </div>
  );
}

function FormColumn({ team, sport, form, align }: { team: string; sport: string; form?: TeamRecentForm; align: "left" | "right" }) {
  const s = form?.summary;
  return (
    <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] p-4">
      <div className={`flex items-center gap-2.5 ${align === "right" ? "flex-row-reverse text-right" : ""}`}>
        <TeamCrest team={team} sport={sport} size={26} />
        <span className="text-[13.5px] font-semibold text-[#e7eae4] truncate">{team}</span>
      </div>
      {!form || !s ? (
        <p className="text-[11.5px] text-[#6b7068] mt-3 leading-relaxed">Recent results not available yet — they populate as fixtures are tracked.</p>
      ) : (
        <>
          <div className={`mt-3 flex items-center gap-2 ${align === "right" ? "justify-end" : ""}`}>
            <FormPills form={s.form} />
            <span className="text-[11px] font-mono text-[#7a8278]">{s.w}-{s.d}-{s.l}</span>
          </div>
          <div className={`mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#8a9286] ${align === "right" ? "justify-end" : ""}`}>
            <span><span className="text-[#c4c7c0] font-mono">{s.gf}</span> GF · <span className="text-[#c4c7c0] font-mono">{s.ga}</span> GA</span>
            <span><span className="text-[#c4c7c0] font-mono">{s.clean_sheets}</span> CS</span>
            {s.run && <span className="text-[#5fe39a]">{s.run}</span>}
          </div>
          <div className="mt-3 pt-2 border-t border-[#161a16] space-y-1.5">
            {form.results.slice(0, 5).map((r, i) => (
              <div key={i} className={`flex items-center gap-2 text-[11px] ${align === "right" ? "flex-row-reverse" : ""}`}>
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${r.result === "W" ? "bg-[#3ee68a]" : r.result === "L" ? "bg-[#ef6b6b]" : "bg-[#9a8e45]"}`} />
                <span className="text-[#9ca39a] tabular-nums w-[34px] shrink-0 font-mono text-[10px]">{r.venue} {r.gf}-{r.ga}</span>
                <span className="text-[#c4c7c0] truncate">{r.opponent}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface Meeting { date: string; competition: string | null; homeName: string; homeGoals: number; awayName: string; awayGoals: number; }
function deriveMeetings(home: string, away: string, homeForm?: TeamRecentForm, awayForm?: TeamRecentForm): Meeting[] {
  const akey = normTeamKey(away), hkey = normTeamKey(home);
  const byDate = new Map<string, Meeting>();
  for (const r of homeForm?.results ?? [])
    if (normTeamKey(r.opponent) === akey)
      byDate.set(r.date, { date: r.date, competition: r.competition, homeName: home, homeGoals: r.gf, awayName: away, awayGoals: r.ga });
  for (const r of awayForm?.results ?? [])
    if (normTeamKey(r.opponent) === hkey && !byDate.has(r.date))
      byDate.set(r.date, { date: r.date, competition: r.competition, homeName: home, homeGoals: r.ga, awayName: away, awayGoals: r.gf });
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

type LiveCenterStory = { title: string; detail?: string; time: string };
type LiveCenterInjury = { playerName: string; status: string; teamName: string };

function GameCommandStack({
  game,
  away,
  home,
  stories,
  injuries,
  awayForm,
  homeForm,
  alpha,
}: {
  game: Game;
  away: string;
  home: string;
  stories: LiveCenterStory[];
  injuries: LiveCenterInjury[];
  awayForm?: TeamRecentForm;
  homeForm?: TeamRecentForm;
  alpha: MatchAlphaDigest;
}) {
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const awayScore = game.scoreboard?.away_score;
  const homeScore = game.scoreboard?.home_score;
  const readiness = [
    { label: "Lineups", value: alpha.coverage.lineups ? `${alpha.coverage.lineups} cached` : "Missing" },
    { label: "Events", value: alpha.coverage.events ? `${alpha.coverage.events} events` : "Not live" },
    { label: "Source", value: alpha.coverage.sportmonksBundle ? "Sportmonks" : "Cache miss" },
  ];

  return (
    <section className="mt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Label icon={Radio} accent={false}>Match Desk</Label>
        <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[#1b241a] bg-[#0d110d] px-2.5 py-1 text-[9px] font-mono uppercase tracking-[0.14em] text-[#7f867c]">
          <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "bg-[#ef4444] animate-pulse" : "bg-[#3ee68a]"}`} />
          {isLive ? "Side-by-side betting companion" : "Alpha runway"}
        </span>
      </div>
      <div className="relative overflow-hidden rounded-3xl border border-[#24311f] bg-[#080a08] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="pointer-events-none absolute inset-0 opacity-[0.06] bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,#3ee68a_3px,#3ee68a_4px)]" />
        <div className="relative grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="border-b border-[#151b14] lg:border-b-0 lg:border-r px-5 py-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    {isLive && <span className="absolute inline-flex h-full w-full rounded-full bg-[#ef4444]/50 animate-ping" />}
                    <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isLive ? "bg-[#ef4444]" : isFinal ? "bg-[#6b7068]" : "bg-[#3ee68a]"}`} />
                  </span>
                  <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#aab0a4]">
                    {isLive ? "Scoreboard + market state" : isFinal ? "Final state" : "At a glance"}
                  </p>
                </div>
                <p className="mt-2 text-[24px] md:text-[28px] font-black tracking-tight text-white">
                  {isLive && awayScore != null ? <>{away}<span className="text-[#3a4033] mx-2">{awayScore}</span><span className="text-[#3a4033] mx-2">/</span><span className="text-[#3a4033] mx-2">{homeScore}</span>{home}</> : alpha.coverage.sportmonksBundle ? "Source intel loaded" : "Waiting on source pull"}
                </p>
                <p className="mt-1 text-[12px] text-[#9ca39a]">
                  {isLive ? (game.scoreboard?.clock ?? "Clock updating") : kickoff(game.commence_time)}
                </p>
              </div>
              <div className="rounded-2xl border border-[#202820] bg-[#0d110d] px-4 py-3 text-right">
                <p className="text-[9px] uppercase tracking-[0.18em] text-[#565c52]">State</p>
                <p className="mt-1 text-[12px] font-semibold text-[#dfe4dc]">{isLive ? "Betting watch" : isFinal ? "Closed" : "Upcoming"}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              {readiness.map((r) => (
                <div key={r.label} className="rounded-2xl border border-[#171d16] bg-[#0b0e0b] px-3 py-3">
                  <p className="text-[9px] uppercase tracking-[0.18em] text-[#4f574d]">{r.label}</p>
                  <p className="mt-1 text-[12px] font-semibold text-[#d6dbd2] truncate">{r.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-[#171d16] bg-[#0b0e0b] p-4">
              <div className="flex items-center gap-2 mb-3">
                <Database className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.7} />
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#aab0a4]">Source coverage</p>
              </div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-[12px]">
                <div className="flex items-center justify-between gap-3 border-b border-[#151b14] pb-2"><span className="text-[#8a9286]">Fixture</span><span className="font-mono font-bold text-[#dfe4dc]">{alpha.coverage.fixtureId ?? "-"}</span></div>
                <div className="flex items-center justify-between gap-3 border-b border-[#151b14] pb-2"><span className="text-[#8a9286]">State</span><span className="font-mono font-bold text-[#dfe4dc]">{alpha.coverage.stateName ?? game.status}</span></div>
                <div className="flex items-center justify-between gap-3"><span className="text-[#8a9286]">Sidelined</span><span className="font-mono font-bold text-[#dfe4dc]">{alpha.coverage.sidelined || "-"}</span></div>
                <div className="flex items-center justify-between gap-3"><span className="text-[#8a9286]">Predictions</span><span className="font-mono font-bold text-[#dfe4dc]">{alpha.coverage.predictions || "-"}</span></div>
              </div>
              {alpha.gaps[0] && (
                <div className="mt-3 flex gap-2 rounded-xl border border-[#3a3216] bg-[#171407] px-3 py-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#d8bd5f]" strokeWidth={1.7} />
                  <p className="text-[11px] leading-relaxed text-[#b9ad79]">{alpha.gaps[0]}</p>
                </div>
              )}
            </div>
          </div>

          <div className="relative px-5 py-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock3 className="h-3.5 w-3.5 text-[#7a8278]" strokeWidth={1.7} />
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#aab0a4]">Alpha digest</p>
            </div>
            <div className="space-y-2.5">
              {alpha.cards.map((card, i) => (
                <div key={`${card.label}-${i}`} className="rounded-2xl border border-[#171d16] bg-[#0b0e0b] px-3.5 py-3">
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${card.tone === "alert" ? "bg-[#ef6666]" : card.tone === "warn" ? "bg-[#d8bd5f]" : card.tone === "good" ? "bg-[#3ee68a]" : "bg-[#6f766d]"}`} />
                    <div className="min-w-0">
                      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#596156]">{card.label}</p>
                      <p className="mt-1 text-[12.5px] font-semibold text-[#e4e8df] leading-snug">{card.title}</p>
                      <p className="mt-1 text-[11px] text-[#9ca39a] leading-relaxed line-clamp-2">{card.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-2xl border border-[#172117] bg-[#0c120d] px-3.5 py-3">
              <ShieldCheck className="h-4 w-4 text-[#3ee68a] shrink-0" strokeWidth={1.7} />
              <p className="text-[11px] text-[#9ca39a] leading-relaxed">No fake play-by-play: lineup, score, clock and key moments only appear when a provider feed has them.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const game = await getGame(gameId);
  if (!game) notFound();

  // Fast path: the match page reads prepared research only. Expensive ESPN +
  // Sportmonks/Python work runs in background via game-intel cache warming.
  // If the cache is cold, render a good partial page immediately and trigger a
  // non-blocking warm for the next load.
  const prepared = await getPreparedGameIntel(game.id);
  if (!prepared) warmGameIntelCacheSoon(`cold-game-page:${game.id}`);

  const researchLoaded = !!prepared;
  const stories = prepared?.stories ?? [];
  const injuries = prepared?.injuryAlerts ?? [];
  const away = game.away_team, home = game.home_team;
  const isSoccer = game.sport.startsWith("soccer");
  const awayML = best(game, "h2h", away), homeML = best(game, "h2h", home);
  const isLive = game.status === "live";
  const read = marketRead(game);

  const alpha = getMatchAlphaDigest(game, prepared);
  const awayForm = isSoccer ? prepared?.awayForm ?? undefined : undefined;
  const homeForm = isSoccer ? prepared?.homeForm ?? undefined : undefined;
  const hasForm = !!(awayForm || homeForm);
  const meetings = hasForm ? deriveMeetings(home, away, homeForm, awayForm) : [];

  const hasTotals = game.bookmakers.some((b) => (b.markets.totals ?? []).length > 0);
  const hasSpreads = game.bookmakers.some((b) => (b.markets.spreads ?? []).length > 0);
  const lead = stories[0], rest = stories.slice(1);

  const oddsCols: Array<{ label: string; rows: Array<{ label: string; market: "h2h" | "spreads" | "totals"; key: string }> }> = [
    { label: "Moneyline", rows: [{ label: away, market: "h2h", key: away }, { label: home, market: "h2h", key: home }] },
  ];
  if (hasSpreads) oddsCols.push({ label: "Spread", rows: [{ label: away, market: "spreads", key: away }, { label: home, market: "spreads", key: home }] });
  if (hasTotals) oddsCols.push({ label: "Total", rows: [{ label: "Over", market: "totals", key: "Over" }, { label: "Under", market: "totals", key: "Under" }] });

  const pct = (p: number) => `${Math.round(p * 100)}%`;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a] text-white">
      <div className="max-w-[920px] mx-auto px-4 md:px-6 py-5 pb-24">

        <GamePageBackButton />

        {/* ── Match-center hero ─────────────────────────────────────────── */}
        <header className="relative overflow-hidden rounded-3xl border border-[#1f261d] bg-[#0c0e0c] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(circle_at_50%_0%,rgba(62,230,138,0.10),transparent_70%)]" />
          <div className="relative px-6 pt-4 pb-3 flex items-center justify-between border-b border-[#141a14]">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6b7068]">{game.sport_title}</span>
            <span className={isLive
              ? "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#ef6b6b]"
              : "inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.12em] text-[#7a8278]"}>
              {isLive ? <><span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />Live</> : countdown(game.commence_time)}
            </span>
          </div>

          <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-6">
            <div className="flex flex-col items-center text-center gap-2.5">
              <TeamCrest team={away} sport={game.sport} size={44} />
              <span className="text-[17px] md:text-[20px] font-bold tracking-tight leading-tight">{away}</span>
              {awayML && <span className="text-[13px] font-mono font-bold text-[#3ee68a]">{formatAmericanOdds(awayML.price)}</span>}
            </div>
            <div className="flex flex-col items-center gap-1.5 px-2">
              {isLive && game.scoreboard?.away_score != null
                ? <span className="text-[30px] font-black font-mono tabular-nums leading-none">{game.scoreboard.away_score}<span className="text-[#3a4033] mx-1">–</span>{game.scoreboard.home_score}</span>
                : <span className="text-[15px] font-black tracking-[0.18em] text-[#3a4033]">VS</span>}
              <span className="text-[10px] text-[#6b7068] whitespace-nowrap">{isLive ? (game.scoreboard?.clock ?? "Live") : kickoff(game.commence_time)}</span>
            </div>
            <div className="flex flex-col items-center text-center gap-2.5">
              <TeamCrest team={home} sport={game.sport} size={44} />
              <span className="text-[17px] md:text-[20px] font-bold tracking-tight leading-tight">{home}</span>
              {homeML && <span className="text-[13px] font-mono font-bold text-[#3ee68a]">{formatAmericanOdds(homeML.price)}</span>}
            </div>
          </div>
        </header>

        <GameCommandStack
          game={game}
          away={away}
          home={home}
          stories={stories}
          injuries={injuries}
          awayForm={awayForm}
          homeForm={homeForm}
          alpha={alpha}
        />

        {/* ── What the line says (market read) ──────────────────────────── */}
        {read && (
          <section className="mt-5 rounded-2xl border border-[#23301f] bg-gradient-to-b from-[#0e120d] to-[#0c0e0c] p-5">
            <Label icon={Activity}>What the line says</Label>
            <p className="text-[15px] md:text-[16px] font-semibold text-white leading-snug">{read.headline}</p>
            <p className="text-[12.5px] text-[#9ca39a] mt-1.5 leading-relaxed">{read.detail}</p>
            {/* implied-probability bar */}
            <div className="mt-4">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#141714]">
                <div className="bg-[#3ee68a]" style={{ width: `${read.fav.prob * 100}%` }} />
                {read.draw != null && <div className="bg-[#6b6f3a]" style={{ width: `${read.draw * 100}%` }} />}
                <div className="bg-[#3a4250]" style={{ width: `${read.dog.prob * 100}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10.5px] font-mono">
                <span className="text-[#5fe39a]">{read.fav.name} {pct(read.fav.prob)}</span>
                {read.draw != null && <span className="text-[#b8b06a]">Draw {pct(read.draw)}</span>}
                <span className="text-[#8a93a3]">{read.dog.name} {pct(read.dog.prob)}</span>
              </div>
              <p className="mt-2.5 text-[10px] text-[#5f655c]">Implied from current market prices.</p>
            </div>
          </section>
        )}

        {/* ── Recent form (two columns) ─────────────────────────────────── */}
        {isSoccer && (
          <section className="mt-6">
            <Label icon={Activity}>Recent form · last 5</Label>
            {hasForm ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormColumn team={away} sport={game.sport} form={awayForm} align="left" />
                <FormColumn team={home} sport={game.sport} form={homeForm} align="right" />
              </div>
            ) : (
              <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] px-5 py-4">
                <p className="text-[12.5px] text-[#9ca39a]">Recent results for these sides aren&apos;t tracked yet — form fills in as fixtures are pulled.</p>
              </div>
            )}
          </section>
        )}

        {/* ── Head-to-head ──────────────────────────────────────────────── */}
        {isSoccer && hasForm && (
          <section className="mt-6">
            <Label icon={Swords}>Head-to-head</Label>
            {meetings.length > 0 ? (
              <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] divide-y divide-[#141714]">
                {meetings.slice(0, 4).map((m, i) => {
                  const homeWin = m.homeGoals > m.awayGoals, draw = m.homeGoals === m.awayGoals;
                  return (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
                      <span className="text-[10px] font-mono text-[#565c52] w-[52px] shrink-0">{fmtDate(m.date)}</span>
                      <span className={`flex-1 truncate ${homeWin ? "text-[#c4c7c0]" : "text-[#7a8278]"}`}>{m.homeName}</span>
                      <span className="font-mono font-bold tabular-nums text-[#e7eae4]">{m.homeGoals}<span className="text-[#3a4033] mx-0.5">-</span>{m.awayGoals}</span>
                      <span className={`flex-1 truncate text-right ${!homeWin && !draw ? "text-[#c4c7c0]" : "text-[#7a8278]"}`}>{m.awayName}</span>
                      {m.competition && <span className="hidden md:inline text-[9.5px] text-[#4a524a] w-[110px] truncate text-right">{m.competition}</span>}
                    </div>
                  );
                })}
                <p className="px-4 py-2 text-[9.5px] text-[#4a524a] uppercase tracking-wide">Recent meetings only · small sample — read as flavor, not signal</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] px-5 py-4 flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#565c52]" />
                <p className="text-[12.5px] text-[#9ca39a]">No recent meetings between these sides — a rare matchup. Nothing to read into here.</p>
              </div>
            )}
          </section>
        )}

        {/* ── Storylines ────────────────────────────────────────────────── */}
        <section className="mt-7">
          <Label icon={Newspaper}>Storylines{stories.length ? ` · ${stories.length}` : ""}</Label>
          {stories.length === 0 ? (
            <p className="text-[12.5px] text-[#6b7068] leading-relaxed">{researchLoaded ? "No useful storylines yet — coverage builds as kickoff nears." : "Storylines are warming in the background; the page stays fast while research catches up."}</p>
          ) : (
            <div className="space-y-4">
              {lead && (
                <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] p-5">
                  <p className="text-[15px] md:text-[16px] font-semibold text-white leading-snug">{lead.title}</p>
                  {lead.detail && <p className="text-[12.5px] text-[#9ca39a] mt-2 leading-relaxed">{lead.detail}</p>}
                  <p className="text-[10px] text-[#4a524a] mt-2.5 font-mono uppercase tracking-wide">{lead.time}</p>
                </div>
              )}
              {rest.length > 0 && (
                <div className="divide-y divide-[#141714] rounded-2xl border border-[#1b201a] bg-[#0d0f0d] px-5">
                  {rest.map((s, i) => (
                    <div key={i} className="flex gap-3 py-3.5">
                      <Newspaper className="h-3.5 w-3.5 text-[#3ee68a]/70 mt-0.5 shrink-0" strokeWidth={1.6} />
                      <div className="min-w-0">
                        <p className="text-[13px] text-[#e0e3dc] font-medium leading-snug">{s.title}</p>
                        {s.detail && <p className="text-[11.5px] text-[#8a9286] mt-1 leading-relaxed line-clamp-2">{s.detail}</p>}
                        <p className="text-[10px] text-[#4a524a] mt-1 font-mono uppercase tracking-wide">{s.time}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Injuries ──────────────────────────────────────────────────── */}
        <section className="mt-7">
          <Label icon={HeartPulse}>Injuries &amp; team news{injuries.length ? ` · ${injuries.length}` : ""}</Label>
          {injuries.length === 0 ? (
            <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] px-5 py-4 flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a]/50" />
              <p className="text-[12.5px] text-[#9ca39a]">{researchLoaded ? "No injuries or suspensions reported. National-team squad news firms up closer to kickoff." : "Team news is warming in the background; this page no longer waits on the slow research pull."}</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {injuries.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-2 rounded-xl border border-[#ef4444]/30 bg-[#1a0e0e] px-3 py-2 text-[12px]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444]" />
                  <span className="font-semibold text-[#ef9a9a]">{a.playerName}</span>
                  <span className="text-[#9ca39a] text-[11px]">{a.status} · {a.teamName}</span>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* ── Best odds ─────────────────────────────────────────────────── */}
        <section className="mt-7">
          <Label icon={BarChart3}>Best odds across books</Label>
          <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] p-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {oddsCols.map((col) => (
              <div key={col.label}>
                <p className="text-[9px] uppercase tracking-[0.18em] text-[#5f655c] mb-2">{col.label}</p>
                <div className="space-y-1">
                  {col.rows.map((r) => {
                    const b = best(game, r.market, r.key);
                    const pt = b?.point != null ? (r.market === "spreads" ? (b.point > 0 ? `+${b.point}` : `${b.point}`) : `${b.point}`) : null;
                    return (
                      <div key={r.key} className="flex items-center justify-between gap-3 py-1.5 border-b border-[#141714] last:border-0">
                        <span className="text-[12.5px] text-[#c4c7c0] truncate">{r.label}{pt && <span className="text-[#7a8278]"> {pt}</span>}</span>
                        {b ? (
                          <span className="text-[12.5px] font-mono shrink-0">
                            <span className="text-[#3ee68a] font-bold">{formatAmericanOdds(b.price)}</span>
                            <span className="text-[#565c52] ml-2 text-[10px]">{bookMeta(b.book)?.name ?? b.book}</span>
                          </span>
                        ) : <span className="text-[11px] text-[#3a4033]">—</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>


      </div>
    </div>
  );
}
