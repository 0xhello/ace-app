"use client";

/**
 * FeaturedPickCard — subscriber-facing pick of the moment.
 *
 * Premium, trust-leaning surface. Shows ONE backtest-validated bet
 * across the next 14 days of upcoming fixtures, or an honest empty
 * state when nothing clears the model + backtest threshold.
 *
 * Hierarchy (top → bottom):
 *   1. Eyebrow chip · live status
 *   2. The bet — biggest, most legible, asymmetric
 *   3. Fixture + tournament context line
 *   4. Three-stat strip: model %, market %, edge pp
 *   5. Stake + book + price block
 *   6. Backtest receipt — provenance section that earns the trust
 *
 * Restraint notes (per the taste system):
 *   - No emojis. Lucide icons w/ stroke 1.5 for consistency w/ codebase.
 *   - No purple glows / neon gradients / oversaturated accents.
 *   - Mono font for every number; sans-serif for prose.
 *   - 1px inner-edge highlight (`shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`)
 *     to simulate physical refraction at the card lip — no outer glow.
 *   - Active state translates -1px to give tactile feedback.
 *   - Cards used only where elevation communicates hierarchy; the
 *     internal sections use border-t / divide-y, not nested cards.
 */
import { useEffect, useState } from "react";
import { Crosshair, Activity, BarChart3, Clock } from "lucide-react";

interface FeaturedPickResponse {
  featured: null | {
    fixture: {
      home: string;
      away: string;
      tournament: string;
      kickoff: string | null;
      neutral_venue: boolean;
    };
    bet: {
      label: string;
      market: string;
      side: string;
      best_book: string;
      best_price: number;
      stake_units: number;
    };
    math: {
      model_prob: number;
      implied_prob: number;
      edge_pp: number;
    };
    backtest: {
      roi: number;
      n: number;
      note: string;
    };
  };
  message?: string;
  refreshed_at: string;
}

// ── format helpers ──────────────────────────────────────────────────────────

function fmtAmerican(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
function fmtPct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}
function fmtEdgePp(p: number): string {
  return `${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}pp`;
}
function fmtBookName(slug: string): string {
  return ({
    fanduel: "FanDuel",
    draftkings: "DraftKings",
    betmgm: "BetMGM",
    williamhill_us: "Caesars Hill",
    betrivers: "BetRivers",
    pinnacle: "Pinnacle",
    caesars: "Caesars",
    espnbet: "ESPN BET",
    hardrockbet: "Hard Rock",
  } as Record<string, string>)[slug] ?? slug;
}
function fmtKickoff(iso: string | null): string {
  if (!iso) return "TBD";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d).replace(",", "") + " ET";
  } catch {
    return "TBD";
  }
}

// Format the "checked at" timestamp for empty state
function fmtCheckedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d) + " ET";
  } catch {
    return "—";
  }
}

// ── component ───────────────────────────────────────────────────────────────

export default function FeaturedPickCard() {
  const [data, setData] = useState<FeaturedPickResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/picks/featured", { cache: "no-store" });
        const json = (await r.json()) as FeaturedPickResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    // Refresh every 90s so prices / fixture rotation stays current
    const id = setInterval(() => void load(), 90_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loading) return <SkeletonCard />;
  if (error)   return <ErrorCard message={error} />;
  if (!data)   return <ErrorCard message="no response" />;
  if (!data.featured) return <EmptyCard message={data.message ?? "monitoring for the next edge"} refreshedAt={data.refreshed_at} />;

  return <FilledCard data={data.featured} refreshedAt={data.refreshed_at} />;
}

// ─── Filled (the main thing) ────────────────────────────────────────────────

function FilledCard({
  data,
  refreshedAt,
}: {
  data: NonNullable<FeaturedPickResponse["featured"]>;
  refreshedAt: string;
}) {
  const { fixture, bet, math, backtest } = data;

  // Where to deeplink — the user goes to the book to actually place the bet.
  // We don't host odds ourselves; we direct them to the listed sportsbook.
  const bookHomes: Record<string, string> = {
    fanduel: "https://sportsbook.fanduel.com",
    draftkings: "https://sportsbook.draftkings.com",
    betmgm: "https://sports.betmgm.com",
    caesars: "https://www.caesars.com/sportsbook",
    espnbet: "https://espnbet.com",
    hardrockbet: "https://app.hardrock.bet",
    pinnacle: "https://www.pinnacle.com",
    betrivers: "https://www.betrivers.com",
  };
  const bookUrl = bookHomes[bet.best_book] ?? null;

  return (
    <section
      className="
        relative overflow-hidden rounded-2xl bg-[#0d0f0d] border border-[#181c18]
        shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
        mx-4 md:mx-6 mt-4 md:mt-6
      "
    >
      {/* Eyebrow strip — pick of the moment + live indicator */}
      <header
        className="
          flex items-center justify-between gap-3
          px-5 md:px-7 pt-5 md:pt-6 pb-4
          border-b border-[#181c18]/50
        "
      >
        <div className="flex items-center gap-2">
          <Crosshair className="h-3.5 w-3.5 text-[#3ee68a]" strokeWidth={1.5} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#3ee68a]">
            ACE pick · live
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[#6b7068] font-mono">
          <Activity className="h-3 w-3 text-[#3ee68a]" strokeWidth={1.5} />
          <span>refreshed {fmtCheckedAt(refreshedAt)}</span>
        </div>
      </header>

      {/* Hero — bet label asymmetric on left, stake block on right */}
      <div className="
        grid gap-6 md:gap-10
        grid-cols-1 md:grid-cols-[1.4fr_1fr]
        px-5 md:px-7 py-8 md:py-10
      ">
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-[0.28em] text-[#6b7068] mb-3 font-semibold">
            The bet
          </p>
          <h2 className="
            text-[34px] md:text-[44px] font-black leading-[0.96]
            tracking-tight text-white mb-3
          ">
            {bet.label}
          </h2>
          <p className="text-[13px] text-[#c4c7c0] leading-snug mb-1">
            <span className="font-semibold">{fixture.home}</span>
            <span className="mx-1.5 text-[#4a524a]">·</span>
            <span className="font-semibold">{fixture.away}</span>
          </p>
          <p className="text-[11px] text-[#6b7068] font-mono tracking-wide">
            {fixture.tournament}
            <span className="mx-1.5 text-[#3a4033]">·</span>
            {fmtKickoff(fixture.kickoff)}
            {fixture.neutral_venue && (
              <>
                <span className="mx-1.5 text-[#3a4033]">·</span>
                <span>Neutral venue</span>
              </>
            )}
          </p>
        </div>

        {/* Stake block — premium "ticket" feel */}
        <div className="
          relative rounded-xl border border-[#3ee68a]/20
          bg-gradient-to-br from-[#3ee68a]/[0.05] to-transparent
          px-5 py-5 md:py-6
          shadow-[inset_0_1px_0_rgba(62,230,138,0.08)]
        ">
          <p className="text-[9px] uppercase tracking-[0.22em] text-[#3ee68a]/80 font-semibold mb-2.5">
            Stake
          </p>
          <p className="text-[44px] md:text-[52px] font-black leading-none text-white font-mono tracking-tight mb-3">
            {bet.stake_units.toFixed(2)}
            <span className="text-[20px] md:text-[24px] text-[#3ee68a] font-bold ml-1">u</span>
          </p>
          <p className="text-[11px] text-[#9ca39a] mb-1">
            quarter-Kelly · 1u = 1% of bankroll
          </p>
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#3ee68a]/[0.08]">
            <span className="text-[10px] uppercase tracking-wider text-[#6b7068]">Best price</span>
            <span className="text-[12px] font-mono text-white">
              <span className="text-[#c4c7c0]">{fmtBookName(bet.best_book)}</span>
              <span className="mx-1.5 text-[#3a4033]">·</span>
              <span className="font-bold text-[#3ee68a]">{fmtAmerican(bet.best_price)}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Math strip — three stats divided by 1px lines, no card boxes */}
      <div className="
        grid grid-cols-3 divide-x divide-[#181c18]
        border-y border-[#181c18]
      ">
        <Stat label="Our model" value={fmtPct(math.model_prob)} tone="positive" />
        <Stat label="Market"    value={fmtPct(math.implied_prob)} tone="neutral" />
        <Stat label="Edge"      value={fmtEdgePp(math.edge_pp)}  tone="positive" emphasis />
      </div>

      {/* Receipt — provenance / trust anchor */}
      <div className="px-5 md:px-7 py-6 md:py-7">
        <div className="flex items-start gap-3">
          <div className="
            flex-shrink-0 h-9 w-9 rounded-lg
            bg-[#3ee68a]/[0.06] border border-[#3ee68a]/15
            flex items-center justify-center
          ">
            <BarChart3 className="h-4 w-4 text-[#3ee68a]" strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] uppercase tracking-[0.22em] text-[#3ee68a] font-semibold mb-1.5">
              Why we trust this market
            </p>
            <p className="text-[13px] text-white leading-relaxed mb-1">
              Across <span className="font-mono font-bold">{backtest.n}</span> historical Big-5 matches, flat-betting every tier-A edge in this market beat the Pinnacle closing line by
              {" "}
              <span className="font-mono font-bold text-[#3ee68a]">
                +{(backtest.roi * 100).toFixed(1)}% ROI
              </span>
              {" "}per pick.
            </p>
            {backtest.note && (
              <p className="text-[10px] text-[#6b7068] italic mt-1.5 leading-relaxed">
                {backtest.note}
              </p>
            )}
            <p className="text-[10px] text-[#4a524a] mt-2 font-mono tracking-wide">
              — ACE calibration framework, M21
            </p>
          </div>
        </div>
      </div>

      {/* CTA — link to the book */}
      {bookUrl && (
        <div className="px-5 md:px-7 pb-6">
          <a
            href={bookUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="
              group flex items-center justify-between gap-3
              w-full px-5 py-4 rounded-xl
              bg-[#3ee68a] hover:bg-[#57eba0] active:translate-y-[1px]
              text-black transition-[transform,background-color] duration-150
              shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]
            "
          >
            <span className="text-[13px] font-bold tracking-tight">
              Place {bet.stake_units.toFixed(2)}u at {fmtBookName(bet.best_book)}
            </span>
            <span className="
              flex items-center gap-1 text-[11px] font-mono
              opacity-80 group-hover:opacity-100 transition-opacity
            ">
              {bet.label} · {fmtAmerican(bet.best_price)}
              <Arrow className="h-3.5 w-3.5" />
            </span>
          </a>
          <p className="mt-2.5 text-[9px] text-[#3a4033] font-mono tracking-wider text-center uppercase">
            ACE does not place bets · 21+ · gamble responsibly · 1-800-gambler
          </p>
        </div>
      )}
    </section>
  );
}

// ─── Stat (the math strip) ──────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  emphasis = false,
}: {
  label: string;
  value: string;
  tone: "positive" | "neutral";
  emphasis?: boolean;
}) {
  const valueColor = tone === "positive" ? "text-[#3ee68a]" : "text-[#c4c7c0]";
  return (
    <div className="px-5 md:px-7 py-5">
      <p className="text-[9px] uppercase tracking-[0.22em] text-[#6b7068] font-semibold mb-1.5">
        {label}
      </p>
      <p
        className={`
          font-mono font-black tracking-tight leading-none
          ${emphasis ? "text-[28px] md:text-[34px]" : "text-[22px] md:text-[26px]"}
          ${valueColor}
        `}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Empty (honest no-pick state) ───────────────────────────────────────────

function EmptyCard({ message, refreshedAt }: { message: string; refreshedAt: string }) {
  return (
    <section
      className="
        relative overflow-hidden rounded-2xl
        bg-[#0d0f0d] border border-[#181c18]
        shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
        mx-4 md:mx-6 mt-4 md:mt-6
      "
    >
      <header className="
        flex items-center justify-between gap-3
        px-5 md:px-7 pt-5 md:pt-6 pb-4 border-b border-[#181c18]/50
      ">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-[#f5c062]" strokeWidth={1.5} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#f5c062]">
            monitoring · no pick
          </span>
        </div>
        <span className="text-[10px] font-mono text-[#6b7068]">
          checked {fmtCheckedAt(refreshedAt)}
        </span>
      </header>
      <div className="px-5 md:px-7 py-10 md:py-12 max-w-2xl">
        <h2 className="text-[28px] md:text-[34px] font-black leading-tight tracking-tight text-white mb-4">
          We're not betting right now.
        </h2>
        <p className="text-[14px] text-[#c4c7c0] leading-relaxed mb-3">
          {message}
        </p>
        <p className="text-[13px] text-[#9ca39a] leading-relaxed">
          The model is scanning every market on every upcoming fixture
          across the next 14 days, but nothing currently clears our
          backtest-validated edge threshold. We surface a pick the
          moment one does — and only then.
        </p>
        <p className="text-[11px] text-[#6b7068] mt-5 font-mono">
          Auto-refreshes every 90 seconds.
        </p>
      </div>
    </section>
  );
}

// ─── Loading skeleton ───────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <section
      className="
        relative overflow-hidden rounded-2xl
        bg-[#0d0f0d] border border-[#181c18]
        shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]
        mx-4 md:mx-6 mt-4 md:mt-6
      "
    >
      <div className="px-5 md:px-7 pt-5 pb-4 border-b border-[#181c18]/50 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full bg-[#1a1e1a] animate-pulse" />
        <div className="h-2.5 w-24 rounded bg-[#1a1e1a] animate-pulse" />
      </div>
      <div className="px-5 md:px-7 py-10 grid gap-6 md:gap-10 grid-cols-1 md:grid-cols-[1.4fr_1fr]">
        <div className="space-y-3">
          <div className="h-2.5 w-20 rounded bg-[#1a1e1a] animate-pulse" />
          <div className="h-9 md:h-12 w-3/4 rounded-lg bg-[#1a1e1a] animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-[#1a1e1a] animate-pulse" />
        </div>
        <div className="h-32 rounded-xl bg-[#1a1e1a] animate-pulse" />
      </div>
      <div className="grid grid-cols-3 divide-x divide-[#181c18] border-y border-[#181c18]">
        {[0,1,2].map((i) => (
          <div key={i} className="px-5 py-5 space-y-2">
            <div className="h-2 w-16 rounded bg-[#1a1e1a] animate-pulse" />
            <div className="h-6 w-20 rounded bg-[#1a1e1a] animate-pulse" />
          </div>
        ))}
      </div>
      <div className="px-5 md:px-7 py-6">
        <div className="h-16 rounded-lg bg-[#1a1e1a] animate-pulse" />
      </div>
    </section>
  );
}

// ─── Error ──────────────────────────────────────────────────────────────────

function ErrorCard({ message }: { message: string }) {
  return (
    <section className="
      mx-4 md:mx-6 mt-4 md:mt-6 rounded-2xl bg-[#0d0f0d]
      border border-[#ef4444]/25 px-5 md:px-7 py-6
    ">
      <p className="text-[10px] uppercase tracking-[0.22em] text-[#ef4444] font-semibold mb-1.5">
        couldn't load pick
      </p>
      <p className="text-[13px] text-[#c4c7c0]">{message}</p>
    </section>
  );
}

// ─── Small SVG arrow (cheaper than another lucide import) ───────────────────

function Arrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className={className}
      aria-hidden="true"
    >
      <path d="M5 10h10M11 6l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

