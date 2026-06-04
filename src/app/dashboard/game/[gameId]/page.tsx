/**
 * /dashboard/game/[gameId] — the dedicated game research + live match-center.
 *
 * Premium, consumer-facing, NO model/no-vig jargon. Reuses the board pipeline
 * (generateIntelMap → ranked news + injuries; odds off the cached board so this
 * never burns Odds API credits). Designed as a live match-center shell: a
 * scoreboard hero + a live-coverage band (score/momentum at kickoff), then the
 * research sections. Scrolls correctly inside the h-screen/overflow-hidden
 * dashboard layout via its own flex-1 overflow-y-auto root.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Newspaper, HeartPulse, BarChart3, Radio, Lock } from "lucide-react";
import { fetchAllGames } from "@/lib/odds-api";
import { fetchAllESPNNews } from "@/lib/espn";
import { fetchSoccerInjuries } from "@/lib/soccer-injuries";
import { generateIntelMap } from "@/lib/live-signals";
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
function best(game: Game, market: "h2h" | "spreads" | "totals", name: string) {
  let top: { price: number; book: string; point?: number } | null = null;
  for (const b of game.bookmakers) for (const o of (b.markets[market] ?? [])) {
    if (o.name === name && (!top || o.price > top.price)) top = { price: o.price, book: b.sportsbook, point: o.point };
  }
  return top;
}

function TeamCrest({ team, sport }: { team: string; sport: string }) {
  const isSoccer = sport.startsWith("soccer");
  const flag = isSoccer ? getNationFlagUrl(team) : null;
  if (flag) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={flag} alt="" width={56} height={38}
        className="h-[38px] w-[56px] rounded-md object-cover ring-1 ring-white/10 shadow-[0_4px_14px_-6px_rgba(0,0,0,0.7)]" />
    );
  }
  const logo = getTeamLogoUrl(team, sport);
  return logo
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={logo} alt="" className="h-12 w-12 object-contain" />
    : <span className="h-12 w-12 rounded-xl bg-[#141814] border border-[#262c24] flex items-center justify-center text-[13px] font-bold text-[#8a9286]">{initials(team)}</span>;
}

function Section({ icon: Icon, title, count, children }: { icon: any; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.9} />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#aab0a4]">{title}</h2>
        {count != null && count > 0 && <span className="text-[10px] font-mono text-[#4a524a]">{count}</span>}
      </div>
      {children}
    </section>
  );
}

export default async function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const game = await getGame(gameId);
  if (!game) notFound();

  const [news, injuryMap] = await Promise.all([
    fetchAllESPNNews().catch(() => [] as any[]),
    Promise.resolve(fetchSoccerInjuries()),
  ]);
  const intel = generateIntelMap([game], news, new Map(), {}, [], injuryMap)[game.id];

  const stories = (intel?.signals ?? []).filter((s) => s.type === "news").slice(0, 6);
  const injuries = intel?.injury_alerts ?? [];
  const away = game.away_team, home = game.home_team;
  const awayML = best(game, "h2h", away), homeML = best(game, "h2h", home);
  const isLive = game.status === "live";
  const hasTotals = game.bookmakers.some((b) => (b.markets.totals ?? []).length > 0);
  const hasSpreads = game.bookmakers.some((b) => (b.markets.spreads ?? []).length > 0);
  const lead = stories[0], rest = stories.slice(1);

  const oddsCols: Array<{ label: string; rows: Array<{ label: string; market: "h2h" | "spreads" | "totals"; key: string }> }> = [
    { label: "Moneyline", rows: [{ label: away, market: "h2h", key: away }, { label: home, market: "h2h", key: home }] },
  ];
  if (hasSpreads) oddsCols.push({ label: "Spread", rows: [{ label: away, market: "spreads", key: away }, { label: home, market: "spreads", key: home }] });
  if (hasTotals) oddsCols.push({ label: "Total", rows: [{ label: "Over", market: "totals", key: "Over" }, { label: "Under", market: "totals", key: "Under" }] });

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0a] text-white">
      <div className="max-w-[860px] mx-auto px-4 md:px-6 py-5 pb-24">

        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[11px] text-[#6b7068] hover:text-[#c4c7c0] transition-colors mb-4">
          <ArrowLeft className="h-3.5 w-3.5" /> Board
        </Link>

        {/* ── Match-center hero (scoreboard) ───────────────────────────── */}
        <header className="relative overflow-hidden rounded-3xl border border-[#1f261d] bg-[#0c0e0c] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(circle_at_50%_0%,rgba(62,230,138,0.10),transparent_70%)]" />
          <div className="relative px-6 pt-5 pb-4 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6b7068]">{game.sport_title}</span>
            <span className={isLive
              ? "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#ef6b6b]"
              : "text-[10px] font-mono uppercase tracking-[0.12em] text-[#7a8278]"}>
              {isLive ? <><span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-pulse" />Live</> : countdown(game.commence_time)}
            </span>
          </div>

          <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 pb-6">
            {/* away */}
            <div className="flex flex-col items-center text-center gap-2.5">
              <TeamCrest team={away} sport={game.sport} />
              <span className="text-[17px] md:text-[20px] font-bold tracking-tight leading-tight">{away}</span>
              {awayML && <span className="text-[13px] font-mono font-bold text-[#3ee68a]">{formatAmericanOdds(awayML.price)}</span>}
            </div>
            {/* center */}
            <div className="flex flex-col items-center gap-1.5 px-2">
              {isLive && game.scoreboard?.away_score != null
                ? <span className="text-[30px] font-black font-mono tabular-nums leading-none">{game.scoreboard.away_score}<span className="text-[#3a4033] mx-1">–</span>{game.scoreboard.home_score}</span>
                : <span className="text-[15px] font-black tracking-[0.18em] text-[#3a4033]">VS</span>}
              <span className="text-[10px] text-[#6b7068] whitespace-nowrap">{isLive ? (game.scoreboard?.clock ?? "Live") : kickoff(game.commence_time)}</span>
            </div>
            {/* home */}
            <div className="flex flex-col items-center text-center gap-2.5">
              <TeamCrest team={home} sport={game.sport} />
              <span className="text-[17px] md:text-[20px] font-bold tracking-tight leading-tight">{home}</span>
              {homeML && <span className="text-[13px] font-mono font-bold text-[#3ee68a]">{formatAmericanOdds(homeML.price)}</span>}
            </div>
          </div>

          {/* live-coverage band — the "monitoring the situation" vibe */}
          <div className="relative flex items-center gap-2.5 px-6 py-3 border-t border-[#161a16] bg-[#0a0c0a]">
            <Radio className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.8} />
            <span className="text-[11px] text-[#9ca39a]">
              {isLive
                ? "Live — score, momentum and key moments update here."
                : "Live coverage begins at kickoff — score, momentum and key moments will track here."}
            </span>
            {!isLive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#3ee68a]/40" />}
          </div>
        </header>

        {/* ── Research sections ────────────────────────────────────────── */}
        <div className="mt-7 space-y-7">

          <Section icon={Newspaper} title="Storylines" count={stories.length}>
            {stories.length === 0 ? (
              <p className="text-[12.5px] text-[#6b7068] leading-relaxed">No notable storylines yet — coverage builds as kickoff nears.</p>
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
                          <p className="text-[10px] text-[#4a524a] mt-1 font-mono uppercase tracking-wide">{s.time}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section icon={HeartPulse} title="Injuries & team news" count={injuries.length}>
            {injuries.length === 0 ? (
              <div className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d] px-5 py-4 flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#3ee68a]/50" />
                <p className="text-[12.5px] text-[#9ca39a]">No injuries or suspensions reported. National-team squad news firms up closer to kickoff.</p>
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
          </Section>

          <Section icon={BarChart3} title="Best odds across books">
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
          </Section>

          {/* Lineups + Form — one intentional "unlocks closer to kickoff" strip */}
          <div className="rounded-2xl border border-dashed border-[#22271f] bg-[#0b0d0b] px-5 py-4 flex items-center gap-3">
            <Lock className="h-4 w-4 text-[#5f655c] shrink-0" strokeWidth={1.7} />
            <div>
              <p className="text-[12.5px] text-[#c4c7c0] font-medium">Lineups &amp; recent form unlock closer to kickoff</p>
              <p className="text-[11px] text-[#6b7068] mt-0.5">Projected XIs land ~1 hour before kickoff; last-5 form is coming to this page next.</p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
