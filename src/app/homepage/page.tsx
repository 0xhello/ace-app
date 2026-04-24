"use client";

import Image from "next/image";
import Link from "next/link";
import { Outfit } from "next/font/google";

const outfit = Outfit({ subsets: ["latin"], display: "swap" });

// ─── Data ────────────────────────────────────────────────────────────────────

const TICKER = [
  "NBA · BOS/MIA  -170 · DK",
  "NBA · DEN/PHX  O184.5 · FD",
  "NFL · SF/SEA  +105 · BET365",
  "CBB · UCLA/ARIZ  -3.5 · ESPN",
  "MLB · LAD/SD  -155 · PRIZE",
  "NHL · NYR/TOR  +118 · MGM",
  "NBA · OKC/LAL  -110 · BET365",
  "MLB · ATL/NYM  +126 · DK",
];

const LOOP_STEPS = [
  {
    n: "01",
    title: "Read the full board.",
    body: "Every line, every book, one sortable view. Filter by sport, market, or confidence tier. The whole picture in seconds.",
  },
  {
    n: "02",
    title: "Identify the edge.",
    body: "Fair price, expected value, factor weights — with reasoning shown. Streaks, injuries, sharp money, pace. You see what moved the model.",
  },
  {
    n: "03",
    title: "Route the slip.",
    body: "Click the leg. ACE assigns each piece to the best-priced book. You go place it. ACE never touches your money.",
  },
];

const TOOLS = [
  {
    n: "I",
    title: "Live odds across 43+ books",
    body: "Continuous coverage across every major book. The +EV radar flags lines drifting off fair price before the market corrects. You're reading it first — not catching it after.",
    variant: "odds" as const,
    flip: false,
  },
  {
    n: "II",
    title: "An AI engine that shows its work",
    body: "Confidence scores backed by factor weights, historical comps, and a live model card. When the model changes its call, you see the exact reason — and the moment it happened.",
    variant: "model" as const,
    flip: true,
  },
  {
    n: "III",
    title: "Smart routing to the best price per leg",
    body: "Build a parlay. ACE spreads each leg to the book offering the best price for it, computes the true combined probability, and hands you the place-here list. Pennies per leg compound into real money.",
    variant: "parlay" as const,
    flip: false,
  },
];

const STATS = [
  { value: "68.4%", label: "Pick accuracy",   sub: "1,847 graded"  },
  { value: "+4.8%", label: "Avg. EV closed",  sub: "trailing 6 mo" },
  { value: "14,382", label: "Bets graded",    sub: "all public"    },
  { value: "$2.1M",  label: "Edge surfaced",  sub: "auditable log" },
];

const MODEL_REASONS = [
  { label: "Boston 8-2 ATS last 10 on road", val: "+3.72", pos: true  },
  { label: "Miami without Herro (Q)",          val: "+3.55", pos: true  },
  { label: "BOS net rating edge +14.8",        val: "+3.48", pos: true  },
  { label: "Heat 12-3 SU at home",             val: "-3.34", pos: false },
];

// ─── Utility ─────────────────────────────────────────────────────────────────

function SectionLabel({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[10px] uppercase tracking-[0.32em] text-[#64d78d]/55">
      <span className="font-mono">{n}</span>
      <span className="h-px w-5 bg-[#64d78d]/30" />
      <span>{label}</span>
    </div>
  );
}

// ─── HeroTerminal ─────────────────────────────────────────────────────────────

function HeroTerminal() {
  const rows = [
    { match: "OKC Thunder",     vs: "LA Lakers",      ml: "-218", book: "DK",   spread: "-6.5", ev: "+2.4", hot: true  },
    { match: "Boston Celtics",  vs: "Miami Heat",     ml: "-138", book: "FD",   spread: "-3.5", ev: "+4.1", hot: false },
    { match: "Denver Nuggets",  vs: "PHX Suns",       ml: "+126", book: "B365", spread: "+4.0", ev: "+1.8", hot: false },
    { match: "NYY Yankees",     vs: "TOR Blue Jays",  ml: "-110", book: "MGM",  spread: "-1.5", ev: "+3.2", hot: false },
  ];

  return (
    <div className="overflow-hidden rounded-[18px] border border-white/[0.1] bg-[#07080a] shadow-[0_32px_80px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.06)]">
      {/* Chrome */}
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#0b0d10] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#3ef08b]" />
          <span className="font-mono text-[9px] uppercase tracking-[0.24em] text-white/32">ace · live board</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.2em] text-white/22">
          <span>43 books</span>
          <span className="h-3 w-px bg-white/10" />
          <span>updated 3s ago</span>
        </div>
      </div>

      {/* Col headers */}
      <div className="grid grid-cols-[2fr_0.8fr_0.7fr_0.6fr_0.52fr] border-b border-white/[0.05] px-4 py-2">
        {["GAME", "ML BEST", "BOOK", "SPREAD", "+EV"].map((h) => (
          <div key={h} className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/18">{h}</div>
        ))}
      </div>

      {/* Rows */}
      <div className="divide-y divide-white/[0.04]">
        {rows.map((row) => (
          <div
            key={row.match}
            className={`grid grid-cols-[2fr_0.8fr_0.7fr_0.6fr_0.52fr] items-center px-4 py-3.5 ${
              row.hot ? "bg-[#0c1611]" : ""
            }`}
          >
            <div>
              <div className="text-[12.5px] font-medium leading-tight text-white/90">{row.match}</div>
              <div className="mt-0.5 font-mono text-[10px] text-white/30">vs {row.vs}</div>
            </div>
            <div className={`font-mono text-[13px] font-semibold ${row.hot ? "text-[#7dffad]" : "text-white/62"}`}>
              {row.ml}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/28">{row.book}</div>
            <div className="font-mono text-[12px] text-white/38">{row.spread}</div>
            <div className={`font-mono text-[13px] font-semibold ${row.ev.startsWith("+") ? "text-[#7dffad]" : "text-white/28"}`}>
              {row.ev}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-white/[0.05] bg-[#090b0e] px-4 py-2.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/18">4 of 214 markets shown</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#3ef08b]/55">+EV radar active</span>
      </div>
    </div>
  );
}

// ─── DashboardMockup ─────────────────────────────────────────────────────────

function DashboardMockup() {
  return (
    <div className="rounded-[26px] border border-white/[0.08] bg-[#0a0c0d] p-3 shadow-[0_40px_120px_rgba(0,0,0,0.55)]">
      <div className="overflow-hidden rounded-[20px] border border-white/[0.08] bg-[#080909]">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#3ef08b]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/26">ace.app/dashboard</span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/20">Live</span>
        </div>

        <div className="grid min-h-[430px] grid-cols-[170px_1fr_220px] bg-[#0a0b0c]">
          <aside className="border-r border-white/[0.06] p-4">
            <div className="mb-4 font-mono text-[9px] uppercase tracking-[0.24em] text-white/22">Workspace</div>
            <div className="space-y-1.5 text-[13px]">
              <div className="rounded-lg border border-[#2f6f46] bg-[#0f1711] px-3 py-2 text-[#b8ffd0]">Games</div>
              {["AI Picks", "Watchlist", "Parlay", "Settings"].map((item) => (
                <div key={item} className="px-3 py-2 text-white/40">{item}</div>
              ))}
            </div>
            <div className="mt-8 rounded-xl border border-[#284733] bg-[#0d1410] p-3 text-[11px] leading-relaxed text-white/32">
              Unlock AI picks, real-time alerts, and sharper routing.
            </div>
          </aside>

          <div className="border-r border-white/[0.06] p-4">
            <div className="mb-4 flex flex-wrap gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-white/24">
              {["All", "NBA", "NHL", "NFL", "MLB"].map((item, i) => (
                <span key={item} className={`rounded-full border px-3 py-1 ${i === 1 ? "border-[#2c7547] bg-[#0d1610] text-[#baffd2]" : "border-white/[0.08]"}`}>
                  {item}
                </span>
              ))}
            </div>

            <div className="space-y-3">
              {[
                { away: "OKC Thunder",    home: "LA Lakers",     odds: ["-218",  "-110", "108"]  },
                { away: "Boston Celtics", home: "Miami Heat",    odds: ["+126",  "-3.5", "-108"] },
                { away: "Kansas City",    home: "Buffalo Bills", odds: ["-130",  "-110", "-112"] },
              ].map((game) => (
                <div key={game.away} className="rounded-[16px] border border-white/[0.06] bg-[#0d0f10] p-3">
                  <div className="mb-3 space-y-2">
                    <div className="flex items-center justify-between text-[13px] text-white/86">
                      <span>{game.away}</span>
                      <span className="font-mono text-[11px] text-white/34">best: fd -105</span>
                    </div>
                    <div className="flex items-center justify-between text-[13px] text-white/56">
                      <span>{game.home}</span>
                      <span className="font-mono text-[12px] text-[#7cffad]">+EV +2.4</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center font-mono text-[12px]">
                    {game.odds.map((odd, idx) => (
                      <div key={idx} className={`rounded-lg border px-2 py-2 ${idx === 1 ? "border-[#326848] bg-[#111a13] text-[#d9ffe8]" : "border-white/[0.07] bg-[#111214] text-white/62"}`}>
                        {odd}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <aside className="p-4">
            <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.22em] text-white/22">Parlay · 3 legs</div>
            <div className="space-y-2 rounded-[16px] border border-white/[0.06] bg-[#0d0f10] p-3 font-mono text-[12px] text-white/56">
              {[["BOS ML", "-138"], ["OKC -6.5", "-185"], ["Total U224", "-110"]].map(([leg, price]) => (
                <div key={leg} className="flex items-center justify-between"><span>{leg}</span><span>{price}</span></div>
              ))}
              <div className="border-t border-white/[0.06] pt-3">
                <div className="flex items-center justify-between text-white/30"><span>Combined</span><span>+127</span></div>
                <div className="mt-3 rounded-lg border border-[#2f6f46] bg-[#14301d] px-3 py-2.5 text-center font-medium text-[#baffd2]">
                  Route 3 places →
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── Mini cards ───────────────────────────────────────────────────────────────

function OddsMiniCard() {
  return (
    <div className="rounded-[20px] border border-white/[0.09] bg-[#0b0d10] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-[0.26em] text-white/26">NYY vs TOR · tonight</span>
        <span className="text-[9px] uppercase tracking-[0.26em] text-white/26">fair price</span>
      </div>
      <div className="space-y-2 font-mono text-[12px]">
        {[
          ["NYY ML", "-110", "-107", "+2.1"],
          ["TOR ML", "-112", "-114", "+1.9"],
          ["O 8.5",  "-108", "-105", "+2.3"],
          ["U 8.5",  "-114", "-116", "+1.8"],
        ].map(([name, market, fair, edge]) => (
          <div key={name} className="grid grid-cols-[1.4fr_0.6fr_0.6fr_0.5fr] gap-2 rounded-lg border border-white/[0.05] bg-[#0f1215] px-3 py-2.5 text-white/62">
            <span>{name}</span>
            <span>{market}</span>
            <span className="text-white/30">{fair}</span>
            <span className="text-[#7cffad]">{edge}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelMiniCard() {
  return (
    <div className="rounded-[20px] border border-white/[0.09] bg-[#0b0d10] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-[0.26em] text-white/26">AI reasoning · MIA ML</span>
        <span className="rounded-full border border-[#2d6d46] bg-[#101911] px-3 py-1 text-[9px] uppercase tracking-[0.2em] text-[#bcffd2]">78% conf.</span>
      </div>
      <div className="space-y-3">
        {[
          { label: "Miami ATS form",    val: "805 > 472", w: 76 },
          { label: "Injury report",     val: "Herro ?",   w: 62 },
          { label: "Net rating edge",   val: "+4.1",      w: 52 },
          { label: "Pace differential", val: "+3.7",      w: 42 },
        ].map(({ label, val, w }) => (
          <div key={label}>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] text-white/46">
              <span>{label}</span>
              <span>{val}</span>
            </div>
            <div className="h-1 rounded-full bg-white/[0.06]">
              <div className="h-1 rounded-full bg-[#62e08f]" style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 font-mono text-[11px] leading-relaxed text-white/30">
        Sharp money drove line -122 → -148. Model fair: -170. Value remains.
      </p>
    </div>
  );
}

function ParlayMiniCard() {
  return (
    <div className="rounded-[20px] border border-white/[0.09] bg-[#0b0d10] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-4 text-[9px] uppercase tracking-[0.26em] text-white/26">4-leg parlay · routed</div>
      <div className="space-y-2 font-mono text-[12px] text-white/62">
        {[
          ["BOS ML",     "-138", "+4.2"],
          ["OKC -6.5",   "-185", "+3.9"],
          ["Total U224", "-110", "+2.6"],
          ["MIA ML",     "+102", "+5.1"],
        ].map(([leg, price, edge]) => (
          <div key={leg} className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-[#0f1215] px-3 py-2.5">
            <span>{leg}</span>
            <div className="flex items-center gap-4">
              <span>{price}</span>
              <span className="text-[#7cffad]">{edge}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-[#2f6f46] bg-[#14301d] px-3 py-3 text-center font-mono text-[12px] text-[#baffd2]">
        Saved vs single-book: +$8.40 / $100
      </div>
    </div>
  );
}

// ─── ToolSection ──────────────────────────────────────────────────────────────

function ToolSection({ n, title, body, variant, flip }: (typeof TOOLS)[number]) {
  const card = variant === "odds" ? <OddsMiniCard /> : variant === "model" ? <ModelMiniCard /> : <ParlayMiniCard />;
  return (
    <div className="grid gap-10 border-t border-white/[0.07] py-12 lg:grid-cols-2 lg:items-center lg:gap-16">
      <div className={flip ? "order-1" : "order-2 lg:order-1"}>
        <div className="font-mono text-[1.8rem] font-semibold leading-none tracking-[-0.04em] text-[#3ef08b]/35">{n}</div>
        <h3 className="mt-5 max-w-[16ch] text-[1.85rem] font-semibold leading-[1.06] tracking-[-0.055em] text-white md:text-[2.2rem]">
          {title}
        </h3>
        <p className="mt-4 max-w-[44ch] text-[0.97rem] leading-relaxed text-white/44">{body}</p>
      </div>
      <div className={flip ? "order-2" : "order-1 lg:order-2"}>{card}</div>
    </div>
  );
}

// ─── ReceiptCard ──────────────────────────────────────────────────────────────

function ReceiptCard() {
  return (
    <div className="rounded-[24px] border border-white/[0.09] bg-[#0c100d] p-5 shadow-[0_30px_80px_rgba(0,0,0,0.4)]">
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div>
          <div className="text-[9px] uppercase tracking-[0.28em] text-[#8af3ae]/50">AI pick · NBA · Tuesday 7:30 PM ET</div>
          <div className="mt-2.5 text-[2rem] font-semibold tracking-[-0.05em] text-white md:text-[2.4rem]">Boston Celtics ML</div>
          <div className="mt-1.5 font-mono text-[12px] text-white/34">vs. Miami Heat · best @ DraftKings -138</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[9px] uppercase tracking-[0.26em] text-white/24">Confidence</div>
          <div className="mt-2 text-[3rem] font-semibold leading-none tracking-[-0.08em] text-[#74f09f] md:text-[3.6rem]">78%</div>
        </div>
      </div>

      <div className="grid gap-5 py-5 lg:grid-cols-[1fr_0.9fr_0.8fr]">
        <div>
          <div className="mb-3 text-[9px] uppercase tracking-[0.26em] text-white/22">What moved the model</div>
          <div className="space-y-3">
            {MODEL_REASONS.map((item) => (
              <div key={item.label}>
                <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] text-white/46">
                  <span>{item.label}</span>
                  <span className={item.pos ? "text-[#7cffad]" : "text-[#ff7d7d]"}>{item.val}</span>
                </div>
                <div className="h-1 rounded-full bg-white/[0.05]">
                  <div className={`h-1 rounded-full ${item.pos ? "bg-[#6ae692]" : "bg-[#b84d4d]"}`} style={{ width: `${item.pos ? 72 : 36}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-3 text-[9px] uppercase tracking-[0.26em] text-white/22">Line movement · 24h</div>
          <div className="flex h-[150px] items-end rounded-[16px] border border-white/[0.06] bg-[#0f1214] p-4">
            <svg viewBox="0 0 240 110" className="h-full w-full">
              <defs>
                <linearGradient id="lgR" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#69e391" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#69e391" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M8 80 C40 78, 48 44, 72 46 S110 60, 130 34 S172 30, 190 38 S220 28, 232 24" fill="none" stroke="#69e391" strokeWidth="2.5" />
              <path d="M8 80 C40 78, 48 44, 72 46 S110 60, 130 34 S172 30, 190 38 S220 28, 232 24 L232 110 L8 110 Z" fill="url(#lgR)" />
            </svg>
          </div>
          <div className="mt-2 font-mono text-[11px] text-white/28">Opened -132 → now -148. Sharp money on BOS.</div>
        </div>

        <div>
          <div className="mb-3 text-[9px] uppercase tracking-[0.26em] text-white/22">Model output</div>
          <div className="space-y-3 rounded-[16px] border border-white/[0.06] bg-[#0f1214] p-4 font-mono text-[12px] text-white/50">
            {[
              ["Fair price",         "-178",          false],
              ["Edge vs. best book",  "+6.2%",         true ],
              ["Expected return",     "+$6.20 / $100", true ],
              ["Historical comps",    "124 games",     false],
            ].map(([label, val, green]) => (
              <div key={label as string} className="flex items-center justify-between">
                <span>{label}</span>
                <span className={green ? "text-[#7cffad]" : "text-white/80"}>{val}</span>
              </div>
            ))}
            <button className="mt-3 w-full rounded-lg bg-[#3ef08b] px-4 py-3 text-center text-[13px] font-semibold text-black transition hover:bg-[#58f5a0] active:scale-[0.98]">
              Add to slip →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Homepage ─────────────────────────────────────────────────────────────────

export default function Homepage() {
  return (
    <main className={`${outfit.className} min-h-[100dvh] overflow-x-hidden bg-[#07080a] text-[#edf0f3]`}>

      {/* Background grid — very subtle */}
      <div className="pointer-events-none fixed inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:80px_80px]" />
      {/* Green glow — committed, not hiding */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_68%_-5%,rgba(62,240,139,0.13),transparent_50%)]" />

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="relative z-20 border-b border-white/[0.07] bg-[#07080a]/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1300px] items-center justify-between px-5 py-3.5 lg:px-10">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/[0.09] bg-white/[0.02]">
                <Image src="/ace-logo.png" alt="ACE" width={18} height={18} className="h-[18px] w-[18px] object-contain" priority />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/88">ACE</span>
            </div>
            <nav className="hidden items-center gap-7 text-[11px] text-white/34 md:flex">
              {["Product", "Intelligence", "Pricing", "Manifesto"].map((item) => (
                <span key={item} className="cursor-pointer transition hover:text-white/65">{item}</span>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-5">
            <div className="hidden items-center gap-1.5 md:flex">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3ef08b]" />
              <span className="text-[10px] uppercase tracking-[0.24em] text-[#89f4ae]">43 books · live</span>
            </div>
            <span className="hidden cursor-pointer text-[11px] text-white/38 transition hover:text-white/65 sm:inline">Log in</span>
            <Link href="/dashboard" className="inline-flex items-center gap-1.5 rounded-full bg-[#3ef08b] px-4 py-2 text-[11px] font-semibold text-black transition hover:bg-[#58f5a0] active:scale-[0.98]">
              Get early access
            </Link>
          </div>
        </div>
      </header>

      {/* ── Status strip ─────────────────────────────────────────────────── */}
      <div className="relative z-10 border-b border-white/[0.06]">
        <div className="mx-auto flex max-w-[1300px] items-center justify-between px-5 py-2.5 lg:px-10">
          <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-white/20">Terminal online · 2026.04.23</span>
          <span className="hidden font-mono text-[9px] uppercase tracking-[0.28em] text-white/14 md:inline">A research tool for serious bettors</span>
          <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-white/20">Est. 2026 · v3.02</span>
        </div>
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-b border-white/[0.06] px-5 py-12 lg:px-10 lg:py-20">
        <div className="mx-auto max-w-[1300px]">
          <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-14">

            {/* Left */}
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.03] px-3 py-1.5 text-[9px] uppercase tracking-[0.3em] text-[#72ec9e]/75">
                <span className="h-1.5 w-1.5 rounded-full bg-[#3ef08b]" />
                Intelligence terminal · not a sportsbook
              </div>

              <h1 className="mt-6 text-[4rem] font-semibold leading-[0.88] tracking-[-0.1em] text-white md:text-[5.4rem] lg:text-[6rem]">
                The research
                <br />
                terminal.
              </h1>

              <p className="mt-5 max-w-[44ch] text-[1.05rem] leading-relaxed text-white/50">
                What the sportsbooks built for themselves — rebuilt for the other side of the bet. Live odds, AI-scored signals, and a slip router that finds the best price per leg.
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-full bg-[#3ef08b] px-6 py-3 text-[13px] font-semibold text-black transition hover:bg-[#58f5a0] active:scale-[0.98]">
                  Get early access
                </Link>
                <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-6 py-3 text-[13px] text-white/56 transition hover:border-white/[0.2] hover:text-white">
                  Launch live demo →
                </Link>
              </div>

              <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.28em] text-white/20">
                No credit card · 7 live markets included
              </div>
            </div>

            {/* Right */}
            <div className="relative">
              <div className="pointer-events-none absolute -inset-8 rounded-[60px] bg-[radial-gradient(circle_at_50%_50%,rgba(62,240,139,0.08),transparent_65%)]" />
              <HeroTerminal />
            </div>
          </div>
        </div>
      </section>

      {/* ── Ticker ───────────────────────────────────────────────────────── */}
      <section className="relative z-10 overflow-hidden border-b border-white/[0.06] bg-[#050607]">
        <div className="flex items-center">
          <div className="shrink-0 border-r border-white/[0.08] bg-[#07080a] px-5 py-3">
            <span className="flex items-center gap-2 text-[9px] uppercase tracking-[0.26em] text-[#74f09f]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3ef08b]" />
              Live
            </span>
          </div>
          <div className="ace-ticker flex whitespace-nowrap gap-10 py-3 pl-8 font-mono text-[10px] uppercase tracking-[0.22em] text-white/30">
            {[...TICKER, ...TICKER].map((item, idx) => (
              <span key={idx}>{item}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── The field ────────────────────────────────────────────────────── */}
      <section className="relative z-10 px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <SectionLabel n="01" label="The field" />

          <h2 className="mt-6 max-w-[20ch] text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.07em] text-white md:text-[3.6rem]">
            Sportsbooks built models
            <br className="hidden md:block" /> to take your money.
            <br />
            <span className="text-white/38">ACE reads them back.</span>
          </h2>

          <p className="mt-6 max-w-[48ch] text-[0.97rem] leading-relaxed text-white/44">
            Fair price engines, sharp money positioning, injury-adjusted lines — they've had the data advantage for 20 years.
            ACE is the terminal that surfaces those signals and puts them in your hands before the line moves.
          </p>

          {/* Three advantages */}
          <div className="mt-12 grid gap-0 border-t border-white/[0.08] lg:grid-cols-3">
            {[
              { stat: "43+",    unit: "books tracked live",           detail: "Continuous · every major market" },
              { stat: "AI",     unit: "confidence with factor weights", detail: "Reasoning shown · not just a score" },
              { stat: "100%",   unit: "best-price routing per leg",   detail: "You place it · we never touch money" },
            ].map(({ stat, unit, detail }, idx) => (
              <div key={stat + unit} className={`pt-8 ${idx !== 0 ? "lg:pl-10 lg:border-l lg:border-white/[0.07]" : ""} ${idx !== 2 ? "pb-8 border-b border-white/[0.07] lg:pb-0 lg:pr-10 lg:border-b-0" : ""}`}>
                <div className="text-[2.4rem] font-semibold tracking-[-0.07em] text-white">{stat}</div>
                <div className="mt-1.5 text-[13px] font-medium text-white/70">{unit}</div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-white/28">{detail}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Loop ─────────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] bg-[#050607] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <SectionLabel n="02" label="The loop" />
              <h2 className="mt-5 max-w-[20ch] text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
                Three moves. Every session.
              </h2>
            </div>
            <div className="font-mono text-right text-[9px] uppercase tracking-[0.24em] text-white/18">
              not a picks service<br />
              not a sportsbook<br />
              just the tool.
            </div>
          </div>

          <div className="mt-10 grid gap-0 border-t border-white/[0.07] lg:grid-cols-3">
            {LOOP_STEPS.map((step, idx) => (
              <div
                key={step.n}
                className={`py-8 ${idx !== 2 ? "border-b border-white/[0.07] lg:border-b-0 lg:border-r lg:border-white/[0.07] lg:pr-10" : ""} ${idx !== 0 ? "lg:pl-10" : ""}`}
              >
                <div className="font-mono text-[2.2rem] font-bold leading-none tracking-[-0.06em] text-[#3ef08b]/40">
                  {step.n}
                </div>
                <div className="mt-7 text-[1.6rem] font-semibold tracking-[-0.05em] text-white">{step.title}</div>
                <p className="mt-3 max-w-[30ch] text-[0.96rem] leading-relaxed text-white/40">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Terminal ─────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1280px]">
          <SectionLabel n="03" label="The terminal" />
          <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
            <h2 className="max-w-[20ch] text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
              One screen. Every book. Zero clutter.
            </h2>
            <p className="max-w-[36ch] text-[0.95rem] leading-relaxed text-white/36">
              Games, AI picks, watchlist, and parlay builder — one workspace. No tabs, no hunting.
            </p>
          </div>
          <div className="mt-10">
            <DashboardMockup />
          </div>
        </div>
      </section>

      {/* ── Tools ────────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] bg-[#050607] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <SectionLabel n="04" label="Inside the terminal" />
          <h2 className="mt-5 text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
            Three tools. A dozen tabs closed.
          </h2>
          <div className="mt-6">
            {TOOLS.map((tool) => (
              <ToolSection key={tool.n} {...tool} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-12 lg:grid-cols-[0.76fr_1.24fr] lg:items-start">
            <div>
              <SectionLabel n="05" label="Track record" />
              <h2 className="mt-5 max-w-[11ch] text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
                We publish the losses too.
              </h2>
              <p className="mt-5 max-w-[36ch] text-[0.97rem] leading-relaxed text-white/40">
                Every graded pick is logged, public, and auditable. The model has cold months. We run diagnostics on them — not press releases.
              </p>
            </div>

            <div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-8 border-t border-white/[0.08] pt-8 lg:grid-cols-4 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
                {STATS.map((stat) => (
                  <div key={stat.label}>
                    <div className="text-[2rem] font-semibold tracking-[-0.06em] text-white">{stat.value}</div>
                    <div className="mt-1.5 text-[11px] font-medium text-white/56">{stat.label}</div>
                    <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-white/22">{stat.sub}</div>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-[20px] border border-white/[0.08] bg-[#0a0d0b] p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[9px] uppercase tracking-[0.26em] text-white/24">Model accuracy · 18 mo</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#79efa4]">trailing: 68.4%</span>
                </div>
                <div className="h-[160px] rounded-[14px] border border-white/[0.06] bg-[#0d1110] p-4">
                  <svg viewBox="0 0 600 160" className="h-full w-full">
                    <defs>
                      <linearGradient id="lgS" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#6ce897" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#6ce897" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path d="M40 120 L140 72 L220 84 L300 44 L360 28 L420 58 L500 24 L560 38" fill="none" stroke="#6ce897" strokeWidth="2.5" />
                    <path d="M40 120 L140 72 L220 84 L300 44 L360 28 L420 58 L500 24 L560 38 L560 140 L40 140 Z" fill="url(#lgS)" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Receipt card ─────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] bg-[#050607] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <SectionLabel n="06" label="Show the work" />
          <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
            <h2 className="max-w-[16ch] text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
              One call. Every receipt.
            </h2>
            <p className="max-w-[36ch] text-[0.95rem] leading-relaxed text-white/36">
              A live pick from tonight's board — the exact card you'll see in the feed.
            </p>
          </div>
          <div className="mt-8">
            <ReceiptCard />
          </div>
        </div>
      </section>

      {/* ── Testimonials ─────────────────────────────────────────────────── */}
      <section className="relative z-10 border-t border-white/[0.06] px-5 py-16 lg:px-10 lg:py-22">
        <div className="mx-auto max-w-[1180px]">
          <SectionLabel n="07" label="Early users" />
          <h2 className="mt-5 text-[2.4rem] font-semibold tracking-[-0.07em] text-white md:text-[3rem]">
            From the private beta.
          </h2>

          <div className="mt-10 grid gap-0 divide-y divide-white/[0.07] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            {[
              {
                quote: "Finally a betting product that feels like a terminal instead of a casino ad.",
                attr: "Sharp bettor · Chicago · 4+ books",
              },
              {
                quote: "The router alone paid for itself. Stopped leaking value on every parlay leg.",
                attr: "High-volume parlay bettor · 3yr",
              },
              {
                quote: "The model card is the part. You can actually see why it likes the play.",
                attr: "Recreational turned serious · 8 mo",
              },
            ].map(({ quote, attr }) => (
              <div key={attr} className="py-8 lg:px-8 lg:py-0 lg:first:pl-0 lg:last:pr-0">
                <p className="text-[1rem] leading-relaxed text-white/60">{`"${quote}"`}</p>
                <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.24em] text-white/24">{attr}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing CTA ──────────────────────────────────────────────────── */}
      <section className="relative z-10 overflow-hidden border-t border-white/[0.06] px-5 py-24 lg:px-10 lg:py-36">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full bg-[radial-gradient(ellipse_at_50%_15%,rgba(62,240,139,0.09),transparent_52%)]" />
        <div className="relative mx-auto max-w-[820px] text-center">
          <div className="font-mono text-[9px] uppercase tracking-[0.36em] text-[#64d78d]/45">— ready —</div>
          <h2 className="mx-auto mt-7 max-w-[14ch] text-[3rem] font-semibold leading-[0.9] tracking-[-0.08em] text-white md:text-[4.6rem]">
            Stop hunting lines.
            <br />
            <span className="text-[#3ef08b]">Start finding edges.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-[38ch] text-[1rem] leading-relaxed text-white/40">
            Seven live markets included. No card. No commitment.<br className="hidden md:block" />
            Pull the data, read the signal, make the call.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
            <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-full bg-[#3ef08b] px-8 py-4 text-[14px] font-semibold text-black transition hover:bg-[#58f5a0] active:scale-[0.98]">
              Get early access →
            </Link>
            <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-8 py-4 text-[14px] text-white/48 transition hover:border-white/[0.2] hover:text-white">
              Launch live demo
            </Link>
          </div>
          <div className="mt-7 font-mono text-[9px] uppercase tracking-[0.28em] text-white/16">
            ACE · Intelligence terminal · Not a sportsbook. Not a picks service.
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/[0.06] px-5 py-6 lg:px-10">
        <div className="mx-auto flex max-w-[1300px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Image src="/ace-logo.png" alt="ACE" width={16} height={16} className="h-4 w-4 object-contain opacity-36" />
            <span className="text-[10px] uppercase tracking-[0.26em] text-white/24">ACE</span>
          </div>
          <div className="hidden items-center gap-7 text-[10px] text-white/18 md:flex">
            {["Product", "Manifesto", "Pricing", "Privacy"].map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/16">
            Not a sportsbook. Never placed a bet.
          </div>
        </div>
      </footer>
    </main>
  );
}
