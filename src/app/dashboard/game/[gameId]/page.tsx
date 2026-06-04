/**
 * /dashboard/game/[gameId] — the dedicated game research page.
 *
 * The deep-dive surface: click a game on the board → land here for the full
 * picture. Research-first, consumer-facing, NO model/no-vig jargon. Reuses the
 * board's data pipeline (generateIntelMap gives ranked news + injuries; odds
 * come straight off the cached board so this never burns Odds API credits).
 *
 * Sections: Matchup header · Storylines (ranked news) · Injuries / team news ·
 * Odds (best price per market across books) · Lineups + Form (honest "available
 * closer to kickoff" until wired).
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Newspaper, HeartPulse, Clock, Users } from "lucide-react";
import { fetchAllGames } from "@/lib/odds-api";
import { fetchAllESPNNews } from "@/lib/espn";
import { fetchSoccerInjuries } from "@/lib/soccer-injuries";
import { generateIntelMap } from "@/lib/live-signals";
import { getMockGames } from "@/lib/mock-games";
import { getTeamLogoUrl } from "@/lib/team-logos";
import { formatAmericanOdds } from "@/lib/utils";
import { bookMeta } from "@/lib/books";
import * as serverCache from "@/lib/server-cache";
import type { Game } from "@/types/game";

export const dynamic = "force-dynamic";
const IS_DEV = process.env.NODE_ENV !== "production";

async function getGame(id: string): Promise<Game | null> {
  // 1) cached board (no Odds API hit) → 2) live fetch → 3) dev mock
  try {
    const entry = await serverCache.get("board-games");
    const cached: Game[] = entry?.data?.games ?? [];
    const hit = cached.find((g) => g.id === id);
    if (hit) return hit;
  } catch { /* ignore */ }
  let games: Game[] = [];
  try {
    games = (await fetchAllGames()).games ?? [];
  } catch { games = []; }
  if (games.length === 0 && IS_DEV) games = getMockGames();
  return games.find((g) => g.id === id) ?? null;
}

function fmtKickoff(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso)) + " ET";
  } catch { return "TBD"; }
}

// Best price for an outcome across all books → { price, book, point }
function best(game: Game, market: "h2h" | "spreads" | "totals", name: string) {
  let top: { price: number; book: string; point?: number } | null = null;
  for (const b of game.bookmakers) {
    for (const o of (b.markets[market] ?? [])) {
      if (o.name !== name) continue;
      if (!top || o.price > top.price) top = { price: o.price, book: b.sportsbook, point: o.point };
    }
  }
  return top;
}

function Section({ icon: Icon, title, children, count }: { icon: any; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#1b201a] bg-[#0d0f0d]">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#161a16]">
        <Icon className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.8} />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#c4c7c0]">{title}</h2>
        {count != null && <span className="text-[10px] font-mono text-[#4a524a]">{count}</span>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function OddsRow({ label, game, market, name }: { label: string; side?: string; game: Game; market: "h2h" | "spreads" | "totals"; name: string }) {
  const b = best(game, market, name);
  // Spreads carry a signed handicap (+3.5 / −3.5); totals are just the line (2.5).
  const pt = b?.point != null ? (market === "spreads" ? (b.point > 0 ? `+${b.point}` : `${b.point}`) : `${b.point}`) : null;
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#141714] last:border-0">
      <span className="text-[12px] text-[#c4c7c0]">{label}{pt && <span className="text-[#7a8278]"> {pt}</span>}</span>
      {b ? (
        <span className="text-[12px] font-mono">
          <span className="text-[#3ee68a] font-bold">{formatAmericanOdds(b.price)}</span>
          <span className="text-[#5f655c] ml-2">{bookMeta(b.book)?.name ?? b.book}</span>
        </span>
      ) : <span className="text-[11px] text-[#3a4033]">—</span>}
    </div>
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

  const storylines = (intel?.signals ?? []).filter((s) => s.type === "news").slice(0, 6);
  const injuries = intel?.injury_alerts ?? [];
  const away = game.away_team, home = game.home_team;
  const isTotals = (game.bookmakers.some((b) => (b.markets.totals ?? []).length > 0));
  const isSpreads = (game.bookmakers.some((b) => (b.markets.spreads ?? []).length > 0));

  return (
    <div className="min-h-screen bg-[#0a0b0a] text-white">
      <div className="max-w-[920px] mx-auto px-4 md:px-6 py-5 space-y-5">

        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[11px] text-[#6b7068] hover:text-[#c4c7c0] transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Board
        </Link>

        {/* Matchup header */}
        <div className="rounded-2xl border border-[#1f241e] bg-[linear-gradient(180deg,rgba(18,20,18,0.9),rgba(13,15,13,0.95))] px-6 py-6">
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#5f655c] mb-4">
            {game.sport_title}<span className="mx-2 text-[#2e332a]">·</span>{fmtKickoff(game.commence_time)}
          </p>
          <div className="space-y-3">
            {[away, home].map((team) => {
              const ml = best(game, "h2h", team);
              const logo = getTeamLogoUrl(team, game.sport);
              return (
                <div key={team} className="flex items-center gap-3">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="" className="h-7 w-7 object-contain shrink-0" />
                  ) : (
                    <span className="h-7 w-7 shrink-0 rounded-md bg-[#161a16] border border-[#22271f] flex items-center justify-center text-[10px] font-bold text-[#7a8278]">
                      {team.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase()}
                    </span>
                  )}
                  <span className="text-[22px] md:text-[26px] font-bold tracking-tight leading-none">{team}</span>
                  {ml && <span className="ml-auto text-[16px] font-mono font-bold text-[#3ee68a]">{formatAmericanOdds(ml.price)}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Storylines */}
        <Section icon={Newspaper} title="Storylines" count={storylines.length}>
          {storylines.length === 0 ? (
            <p className="text-[12px] text-[#6b7068]">No notable storylines for this match yet — check back as kickoff nears.</p>
          ) : (
            <div className="space-y-3">
              {storylines.map((s, i) => (
                <div key={i} className="flex gap-3">
                  <Newspaper className="h-3.5 w-3.5 text-[#3ee68a] mt-0.5 shrink-0" strokeWidth={1.6} />
                  <div className="min-w-0">
                    <p className="text-[13px] text-[#e7eae4] font-medium leading-snug">{s.title}</p>
                    {s.detail && <p className="text-[11.5px] text-[#9ca39a] mt-0.5 leading-relaxed line-clamp-2">{s.detail}</p>}
                    <p className="text-[10px] text-[#4a524a] mt-1 font-mono uppercase tracking-wide">{s.time}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Injuries / team news */}
        <Section icon={HeartPulse} title="Injuries & team news" count={injuries.length}>
          {injuries.length === 0 ? (
            <p className="text-[12px] text-[#6b7068]">No injuries or suspensions reported. (For internationals, squad news firms up closer to kickoff.)</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {injuries.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-[#ef4444]/30 bg-[#1f0e0e] px-2.5 py-1.5 text-[11px]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444]" />
                  <span className="font-semibold text-[#ef8f8f]">{a.playerName}</span>
                  <span className="text-[#9ca39a]">· {a.status} · {a.teamName}</span>
                </span>
              ))}
            </div>
          )}
        </Section>

        {/* Odds */}
        <Section icon={Clock} title="Best odds across books">
          <div className="grid md:grid-cols-3 gap-x-6 gap-y-1">
            <div>
              <p className="text-[9px] uppercase tracking-[0.16em] text-[#5f655c] mb-1.5">Moneyline</p>
              <OddsRow label={away} side="away" game={game} market="h2h" name={away} />
              <OddsRow label={home} side="home" game={game} market="h2h" name={home} />
            </div>
            {isSpreads && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.16em] text-[#5f655c] mb-1.5">Spread</p>
                <OddsRow label={away} side="away" game={game} market="spreads" name={away} />
                <OddsRow label={home} side="home" game={game} market="spreads" name={home} />
              </div>
            )}
            {isTotals && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.16em] text-[#5f655c] mb-1.5">Total</p>
                <OddsRow label="Over" side="over" game={game} market="totals" name="Over" />
                <OddsRow label="Under" side="under" game={game} market="totals" name="Under" />
              </div>
            )}
          </div>
        </Section>

        {/* Lineups + Form — honest placeholders until wired */}
        <div className="grid md:grid-cols-2 gap-5">
          <Section icon={Users} title="Lineups">
            <p className="text-[12px] text-[#6b7068]">Projected lineups appear ~1 hour before kickoff (Sportmonks).</p>
          </Section>
          <Section icon={Clock} title="Recent form">
            <p className="text-[12px] text-[#6b7068]">Last-5 form is coming to this page next.</p>
          </Section>
        </div>

      </div>
    </div>
  );
}
