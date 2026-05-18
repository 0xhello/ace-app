"use client";

import { useEffect, useState } from "react";
import { Outfit, JetBrains_Mono } from "next/font/google";

// ─── Kickoff target: WC 2026 opening match, 9 PM ET (8 PM CDMX), June 11 ──
const KICKOFF_ISO = "2026-06-11T21:00:00-04:00";

function useCountdown(targetIso: string) {
  const [diff, setDiff] = useState<number | null>(null);
  useEffect(() => {
    const target = new Date(targetIso).getTime();
    const tick = () => setDiff(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [targetIso]);
  if (diff === null) return null;
  return {
    days:  Math.floor(diff / 86_400_000),
    hours: Math.floor((diff % 86_400_000) / 3_600_000),
    mins:  Math.floor((diff %  3_600_000) / 60_000),
  };
}
const pad2 = (n: number) => String(n).padStart(2, "0");

const outfit = Outfit({ subsets: ["latin"], weight: ["300","400","500","600","700"], display: "swap", variable: "--v4-outfit" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400","500"], display: "swap", variable: "--v4-jetbrains" });

// ─── Design tokens ───────────────────────────────────────────────────────────
const V4 = {
  bg:        "#07080a",
  bgWarm:    "#090a0c",
  bgDeep:    "#050607",
  card:      "#0b0d10",
  cardHover: "#0f1216",
  surface:   "#0d1014",
  line:      "rgba(255,255,255,0.06)",
  lineMid:   "rgba(255,255,255,0.09)",
  lineHigh:  "rgba(255,255,255,0.18)",
  green:     "#3ef08b",
  greenSoft: "#58f5a0",
  greenDeep: "#1ea866",
  greenInk:  "#02160c",
  greenDim:  "rgba(62,240,139,0.10)",
  greenTint: "rgba(62,240,139,0.04)",
  text:      "rgba(255,255,255,0.92)",
  textDim:   "rgba(255,255,255,0.62)",
  secondary: "rgba(255,255,255,0.42)",
  muted:     "rgba(255,255,255,0.26)",
  faint:     "rgba(255,255,255,0.14)",
  ghost:     "rgba(255,255,255,0.08)",
  red:       "#ef4444",
};

const OUTFIT = "var(--v4-outfit), system-ui, sans-serif";
const MONO = "var(--v4-jetbrains), ui-monospace, monospace";

// ─── Global keyframes / classes ──────────────────────────────────────────────
const V4_STYLES = `
  .v4-root { font-family: ${OUTFIT}; color: ${V4.text}; background: ${V4.bg}; }
  .v4-root * { box-sizing: border-box; }
  .v4-mono { font-family: ${MONO}; font-variant-numeric: tabular-nums; }
  .v4-h1 { font-weight: 500; letter-spacing: -0.028em; line-height: 0.92; }
  .v4-h2 { font-weight: 500; letter-spacing: -0.025em; line-height: 0.96; }
  .v4-h3 { font-weight: 500; letter-spacing: -0.018em; line-height: 1.04; }
  .v4-kicker { font-family: ${MONO}; font-size: 10px; letter-spacing: 0.28em; text-transform: uppercase; }
  @keyframes v4Pulse { 0%,100% { opacity: 0.55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
  @keyframes v4Tick { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  @keyframes v4Cursor { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
  .v4-cta { background: ${V4.green}; color: ${V4.greenInk}; border: none; cursor: pointer; transition: background .12s, transform .12s; font-family: ${OUTFIT}; font-weight: 600; }
  .v4-cta:hover { background: ${V4.greenSoft}; }
  .v4-cta:active { transform: translateY(1px); }
  .v4-ghost { background: transparent; color: ${V4.text}; border: 1px solid ${V4.lineHigh}; cursor: pointer; transition: border-color .12s, background .12s; font-family: ${OUTFIT}; }
  .v4-ghost:hover { border-color: ${V4.green}; background: ${V4.greenTint}; }

  /* ── Responsive layer ── */
  /* Tablets and below: ease padding, allow stacking */
  @media (max-width: 1024px) {
    .v4-pad-x { padding-left: 28px !important; padding-right: 28px !important; }
    .v4-pad-tall { padding-top: 88px !important; padding-bottom: 80px !important; }
  }
  /* Small tablets / large phones: stack 2-col grids, scale headlines */
  @media (max-width: 900px) {
    .v4-stack { grid-template-columns: 1fr !important; gap: 40px !important; }
    .v4-4col { grid-template-columns: repeat(2, 1fr) !important; }
    .v4-h1-fit { font-size: clamp(48px, 11vw, 96px) !important; }
    .v4-h2-fit { font-size: clamp(36px, 7vw, 60px) !important; }
    .v4-h3-fit { font-size: clamp(26px, 5.5vw, 40px) !important; }
    .v4-stat-fit { font-size: clamp(56px, 9vw, 80px) !important; }
    .v4-wordmark-fit { font-size: clamp(80px, 18vw, 180px) !important; }
    .v4-countdown-fit { font-size: clamp(72px, 14vw, 112px) !important; }
    .v4-pct-fit { font-size: clamp(48px, 8vw, 72px) !important; }
    .v4-nav-wrap { flex-wrap: wrap !important; gap: 16px !important; }
    .v4-footer-grid { grid-template-columns: 1fr 1fr 1fr !important; gap: 28px !important; }
    .v4-pad-x { padding-left: 22px !important; padding-right: 22px !important; }
    .v4-pad-tall { padding-top: 72px !important; padding-bottom: 64px !important; }
    .v4-hide-md { display: none !important; }
  }
  /* Phones */
  @media (max-width: 640px) {
    .v4-pad-x { padding-left: 16px !important; padding-right: 16px !important; }
    .v4-pad-tall { padding-top: 56px !important; padding-bottom: 56px !important; }
    .v4-stack { gap: 32px !important; }
    .v4-3col { grid-template-columns: 1fr !important; }
    .v4-4col { grid-template-columns: 1fr 1fr !important; gap: 20px !important; }
    .v4-h1-fit { font-size: clamp(40px, 13vw, 72px) !important; line-height: 0.95 !important; }
    .v4-h2-fit { font-size: clamp(28px, 9vw, 48px) !important; }
    .v4-h3-fit { font-size: clamp(22px, 7vw, 32px) !important; }
    .v4-stat-fit { font-size: clamp(40px, 11vw, 64px) !important; }
    .v4-wordmark-fit { font-size: clamp(64px, 22vw, 140px) !important; }
    .v4-countdown-fit { font-size: clamp(48px, 18vw, 84px) !important; }
    .v4-pct-fit { font-size: clamp(36px, 12vw, 56px) !important; }
    .v4-pick-h2-fit { font-size: clamp(32px, 9vw, 52px) !important; }
    .v4-card-pad { padding: 18px !important; }
    .v4-card-pad-lg { padding: 20px !important; }
    .v4-hide-sm { display: none !important; }
    .v4-footer-grid { grid-template-columns: 1fr 1fr !important; gap: 24px !important; }
    .v4-nav-pad { padding: 12px 16px !important; }
    .v4-cta-fit { padding: 13px 20px !important; font-size: 13px !important; }
    .v4-hero-card-grid { grid-template-columns: 1fr !important; gap: 18px !important; }
    .v4-bottom-row-stack { flex-direction: column !important; align-items: flex-start !important; gap: 14px !important; }
  }
`;

function InjectV4Styles() {
  return <style dangerouslySetInnerHTML={{ __html: V4_STYLES }} />;
}

// ─── Shared atoms ────────────────────────────────────────────────────────────
function V4Kicker({ n, label, accent = false }: { n: string; label: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <span className="v4-mono" style={{ fontSize: 11, color: V4.green, letterSpacing: 2 }}>{n}</span>
      <span style={{ height: 1, width: 28, background: V4.green, opacity: 0.5 }} />
      <span className="v4-mono" style={{ fontSize: 11, color: accent ? V4.green : V4.secondary, letterSpacing: 2.4 }}>{label}</span>
    </div>
  );
}

function V4Dot({ color = V4.green, size = 6 }: { color?: string; size?: number }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: color, animation: "v4Pulse 2s ease-in-out infinite",
    }} />
  );
}

function V4PitchBackdrop({ opacity = 0.5 }: { opacity?: number }) {
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity, pointerEvents: "none" }} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
      <g stroke={V4.green} strokeOpacity="0.18" strokeWidth="1" fill="none">
        <line x1="720" y1="0" x2="720" y2="900" />
        <circle cx="720" cy="450" r="110" />
        <rect x="0" y="280" width="160" height="340" />
        <rect x="0" y="380" width="60" height="140" />
        <rect x="1280" y="280" width="160" height="340" />
        <rect x="1380" y="380" width="60" height="140" />
      </g>
    </svg>
  );
}

function V4CountryChip({ code, size = 30, tone = 1, accent = false }: { code: string; size?: number; tone?: number; accent?: boolean }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      border: `1px solid ${accent ? V4.green : V4.lineMid}`,
      background: accent ? `rgba(62,240,139,${0.08 * tone})` : `rgba(255,255,255,${0.02 * tone})`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: MONO, fontSize: Math.round(size * 0.32), fontWeight: 500,
      color: accent ? V4.green : V4.textDim, letterSpacing: 0.5,
    }}>{code}</div>
  );
}

function V4Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, color: V4.text, fontFamily: OUTFIT, letterSpacing: "-0.02em", lineHeight: 1 }}>{n}</div>
      <div className="v4-mono" style={{ fontSize: 9, color: V4.muted, letterSpacing: 1.4, marginTop: 4 }}>{label.toUpperCase()}</div>
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────
function V4Nav() {
  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 40,
      borderBottom: `1px solid ${V4.line}`,
      background: "rgba(7,8,10,0.88)",
      backdropFilter: "blur(14px)",
    }}>
      <div className="v4-nav-pad v4-nav-wrap" style={{
        maxWidth: 1320, margin: "0 auto", padding: "14px 36px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          <a href="/" style={{ display: "flex", alignItems: "center" }}>
            <img src="/ace-logo.png" alt="ACE" style={{ height: 56, width: "auto", display: "block" }} />
          </a>
          <nav className="v4-hide-sm" style={{ display: "flex", gap: 28 }}>
            {[
              { l: "World Cup", h: "#wc" },
              { l: "How it works", h: "#how-it-works" },
              { l: "Track record", h: "#track-record" },
              { l: "FAQ", h: "#faq" },
            ].map(({ l, h }) => (
              <a key={l} href={h} style={{ fontSize: 13, color: V4.textDim, textDecoration: "none", fontFamily: OUTFIT }}>{l}</a>
            ))}
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <a href="/login" style={{ fontSize: 13, color: V4.secondary, textDecoration: "none" }}>Log in</a>
          <a href="/register" className="v4-cta" style={{ padding: "9px 16px", borderRadius: 999, fontSize: 12.5, textDecoration: "none", display: "inline-block" }}>Join the beta</a>
        </div>
      </div>
    </header>
  );
}

// ─── Status bar ──────────────────────────────────────────────────────────────
function V4StatusBar() {
  return (
    <div style={{ borderBottom: `1px solid ${V4.line}`, background: V4.bgDeep }}>
      <div className="v4-mono" style={{
        maxWidth: 1320, margin: "0 auto", padding: "8px 36px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        fontSize: 9.5, letterSpacing: 2, color: V4.muted,
      }}>
        <span>WORLD CUP 2026 · OPENS JUN 11</span>
        <span>BETA · INVITE ONLY</span>
      </div>
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────
function V4HeroHomeworkCard() {
  const pct = 78;
  return (
    <div style={{ position: "relative" }}>
      <div style={{
        position: "absolute", top: -14, left: 24, zIndex: 4,
        background: V4.green, color: V4.greenInk,
        padding: "7px 14px",
        fontFamily: MONO,
        fontSize: 10, letterSpacing: 1.8, fontWeight: 600,
        boxShadow: "0 12px 30px -8px rgba(62,240,139,0.45)",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span style={{ fontSize: 11 }}>★</span> TONIGHT&apos;S TOP PICK
      </div>

      <div style={{
        background: V4.card, border: `1px solid ${V4.lineMid}`,
        borderRadius: 18, padding: 28, position: "relative",
        boxShadow: "0 32px 80px -20px rgba(0,0,0,0.7)",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 22, marginTop: 6,
        }} className="v4-mono">
          <span style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12 }}>⚽</span> WORLD CUP · GROUP D · 9PM ET
          </span>
          <span style={{ fontSize: 10, color: V4.green, letterSpacing: 1.6, display: "flex", alignItems: "center", gap: 6 }}>
            <V4Dot size={5} /> LIVE
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
          <V4CountryChip code="ARG" size={44} accent />
          <span className="v4-mono" style={{ fontSize: 11, color: V4.muted, letterSpacing: 2 }}>vs</span>
          <V4CountryChip code="MEX" size={44} tone={0.6} />
          <div style={{ flex: 1, textAlign: "right" }}>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.4 }}>JUN 16 · GROUP STAGE</div>
          </div>
        </div>

        <div style={{ marginBottom: 4 }}>
          <div className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 1.8, marginBottom: 8 }}>
            ↳ ACE SAYS
          </div>
          <h3 className="v4-h2 v4-pick-h2-fit" style={{
            fontSize: 64, color: V4.text, margin: 0,
            fontFamily: OUTFIT, fontWeight: 500,
            letterSpacing: "-0.025em", lineHeight: 0.95,
          }}>
            Argentina to <span style={{ color: V4.green }}>win.</span>
          </h3>
        </div>

        <div className="v4-hero-card-grid" style={{
          display: "grid", gridTemplateColumns: "128px 1fr", gap: 24, alignItems: "center",
          marginTop: 28, padding: "24px 0", borderTop: `1px solid ${V4.line}`, borderBottom: `1px solid ${V4.line}`,
        }}>
          <div style={{
            width: 128, height: 128, borderRadius: "50%",
            background: `conic-gradient(${V4.green} 0% ${pct}%, ${V4.ghost} ${pct}% 100%)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            position: "relative",
            boxShadow: "0 0 32px -8px rgba(62,240,139,0.35)",
          }}>
            <div style={{
              width: 100, height: 100, borderRadius: "50%",
              background: V4.card,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ fontSize: 42, fontWeight: 500, color: V4.green, fontFamily: OUTFIT, letterSpacing: "-0.035em", lineHeight: 1 }}>
                {pct}<span style={{ fontSize: 18 }}>%</span>
              </span>
              <span className="v4-mono" style={{ fontSize: 9, color: V4.muted, letterSpacing: 1.4, marginTop: 4 }}>CONFIDENT</span>
            </div>
          </div>
          <div>
            <p style={{ fontSize: 16.5, color: V4.textDim, lineHeight: 1.5, margin: 0 }}>
              <span style={{ color: V4.text }}>Argentina&apos;s been dominant in the group.</span> Mexico
              is missing their starting center-back, and the line keeps moving in our favor.
              Easy call.
            </p>
            <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1.4, marginTop: 14 }}>
              — ACE AI · UPDATED MOMENTS AGO
            </div>
          </div>
        </div>

        <div style={{
          marginTop: 22,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1.4 }}>BEST PRICE FOUND</div>
            <div style={{ fontSize: 18, color: V4.text, fontFamily: OUTFIT, fontWeight: 500, marginTop: 4, letterSpacing: "-0.012em" }}>
              DraftKings <span style={{ color: V4.green, marginLeft: 4 }}>-148</span>
            </div>
          </div>
          <button className="v4-cta" style={{ padding: "13px 22px", fontSize: 13, borderRadius: 999 }}>
            Add to my bets →
          </button>
        </div>
      </div>

    </div>
  );
}

function V4Hero() {
  return (
    <section style={{ position: "relative", overflow: "hidden" }}>
      <div style={{
        position: "absolute", inset: "-200px 0 auto 0", height: 640, pointerEvents: "none",
        background: "radial-gradient(ellipse 60% 60% at 65% 0%, rgba(62,240,139,0.10), transparent 55%)",
      }} />
      <V4PitchBackdrop opacity={0.35} />

      <div className="v4-pad-x" style={{ position: "relative", maxWidth: 1320, margin: "0 auto", padding: "72px 36px 100px" }}>
        <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 64, alignItems: "flex-start" }}>
          <div>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "6px 12px", borderRadius: 999,
              border: `1px solid ${V4.lineMid}`, background: V4.greenTint,
            }}>
              <V4Dot size={6} />
              <span className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 2.4 }}>
                BETA · OPENING WITH WC 2026
              </span>
            </div>

            <h1 className="v4-h1 v4-h1-fit" style={{
              fontSize: 132, color: V4.text, margin: "32px 0 0",
              fontFamily: OUTFIT,
            }}>
              We do the<br />homework.<br />
              <span style={{ color: V4.secondary }}>You bet </span>
              <span style={{ color: V4.green, position: "relative" }}>
                smarter.
                <span style={{
                  display: "inline-block", verticalAlign: "baseline",
                  width: "0.5ch", height: "0.78em",
                  background: V4.green, marginLeft: 6, marginBottom: "-0.08em",
                  animation: "v4Cursor 1.1s steps(1) infinite",
                }} />
              </span>
            </h1>

            <p style={{
              marginTop: 36, fontSize: 18, color: V4.textDim, lineHeight: 1.5, maxWidth: 520,
            }}>
              Stop guessing. The AI does the work — finds the bets, shows you why,
              points you to the best price.
            </p>

            <div style={{ display: "flex", gap: 12, marginTop: 36 }}>
              <a href="/register" className="v4-cta" style={{ padding: "15px 26px", borderRadius: 999, fontSize: 14, textDecoration: "none", display: "inline-block" }}>
                Join the beta →
              </a>
              <a href="#how-it-works" className="v4-ghost" style={{ padding: "15px 26px", borderRadius: 999, fontSize: 14, textDecoration: "none", display: "inline-block" }}>
                See how it works
              </a>
            </div>

            <div className="v4-mono" style={{ marginTop: 22, fontSize: 10, color: V4.muted, letterSpacing: 2 }}>
              INVITE ONLY · BETA · WC 2026 READY
            </div>
          </div>

          <div>
            <V4HeroHomeworkCard />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Ticker ──────────────────────────────────────────────────────────────────
function V4Ticker() {
  const lines: Array<[string, string, string, string]> = [
    ["WC", "ARG / MEX", "-178", "▲"],
    ["WC", "BRA / SRB", "-245", "▲"],
    ["WC", "FRA / DEN", "-132", "▼"],
    ["NBA","BOS / MIA", "-148", "▲"],
    ["WC", "ENG / IRN", "-198", "▲"],
    ["WC", "GER / JPN", "-105", "▼"],
    ["WC", "POR / GHA", "-260", "▲"],
    ["NHL","EDM / COL", "+105", "▲"],
    ["WC", "ESP / CRC", "-340", "▲"],
    ["WC", "NED / SEN", "-148", "▼"],
    ["MLB","LAD / SF",  "-155", "▲"],
    ["WC", "BEL / CAN", "-185", "▲"],
  ];

  const Strip = () => (
    <div style={{ display: "flex", gap: 36, padding: "12px 0", flexShrink: 0 }}>
      {lines.map((l, i) => (
        <div key={i} className="v4-mono" style={{ display: "flex", gap: 8, fontSize: 10.5, whiteSpace: "nowrap", letterSpacing: 1, alignItems: "baseline" }}>
          <span style={{ color: l[0] === "WC" ? V4.green : V4.muted, fontWeight: 500 }}>{l[0]}</span>
          <span style={{ color: V4.textDim }}>{l[1]}</span>
          <span style={{ color: V4.text }}>{l[2]}</span>
          <span style={{ color: l[3] === "▲" ? V4.green : V4.red }}>{l[3]}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{
      borderTop: `1px solid ${V4.line}`, borderBottom: `1px solid ${V4.line}`,
      background: V4.bgDeep, display: "flex", alignItems: "stretch",
    }}>
      <div style={{
        padding: "12px 20px", borderRight: `1px solid ${V4.line}`,
        display: "flex", alignItems: "center", gap: 8,
        background: V4.bg, flexShrink: 0,
      }} className="v4-mono">
        <V4Dot size={5} />
        <span style={{ fontSize: 10, color: V4.green, letterSpacing: 2, fontWeight: 500 }}>LIVE</span>
      </div>
      <div style={{
        flex: 1, overflow: "hidden",
        maskImage: "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
        WebkitMaskImage: "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
      }}>
        <div style={{ display: "flex", width: "max-content", animation: "v4Tick 60s linear infinite" }}>
          <Strip /><Strip />
        </div>
      </div>
    </div>
  );
}

// ─── Loop ────────────────────────────────────────────────────────────────────
function V4Loop() {
  const steps = [
    { n: "01", title: "We watch every game.", body: "ACE watches every NBA, NFL, MLB, NHL, and soccer game across every major sportsbook. All night." },
    { n: "02", title: "AI calls the smart bet.", body: "The picks worth your money — with confidence and reasoning attached. No spreadsheets." },
    { n: "03", title: "You place it. We track it.", body: "ACE points you to the sportsbook with the best price. You place the bet. We track the result." },
  ];
  return (
    <section style={{ borderTop: `1px solid ${V4.line}`, background: V4.bgDeep }}>
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 40, flexWrap: "wrap", gap: 20 }}>
          <div>
            <V4Kicker n="01" label="THE LOOP" />
            <h2 className="v4-h2 v4-h2-fit" style={{ fontSize: 72, color: V4.text, margin: "20px 0 0" }}>
              Three moves. <span style={{ color: V4.secondary }}>Every session.</span>
            </h2>
          </div>
          <div className="v4-mono v4-hide-sm" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.5, textAlign: "right", lineHeight: 1.8 }}>
            NOT A PICKS SERVICE<br />NOT A SPORTSBOOK<br />
            <span style={{ color: V4.green }}>JUST THE TOOL.</span>
          </div>
        </div>
        <div className="v4-3col" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: V4.line, border: `1px solid ${V4.line}` }}>
          {steps.map((s, i) => (
            <div key={s.n} style={{ background: V4.bg, padding: "40px 32px", minHeight: 240, position: "relative" }}>
              <div className="v4-mono" style={{
                fontSize: 80, fontWeight: 400, color: V4.green, opacity: 0.45,
                lineHeight: 1, letterSpacing: "-0.04em", marginBottom: 24,
              }}>{s.n}</div>
              <div className="v4-h3" style={{ fontSize: 32, color: V4.text, fontFamily: OUTFIT }}>
                {s.title}
              </div>
              <p style={{ fontSize: 14, color: V4.secondary, lineHeight: 1.6, marginTop: 14, maxWidth: 320 }}>{s.body}</p>
              <div className="v4-mono" style={{ position: "absolute", top: 28, right: 24, fontSize: 9, color: V4.muted, letterSpacing: 1.4 }}>
                STEP · {i + 1}/3
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── WC moment ───────────────────────────────────────────────────────────────
function V4WCMoment() {
  const cd = useCountdown(KICKOFF_ISO);
  const daysLabel = cd ? `${cd.days} DAYS OUT` : "OPENING JUN 11";
  return (
    <section style={{ position: "relative", overflow: "hidden", background: "#020503" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 80% 60% at 50% 70%, #06301a 0%, #021207 60%, #020503 100%)",
        }} />
        <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
            <rect key={i} x="0" y={i * 112} width="1440" height="56" fill="#031309" opacity="0.4" />
          ))}
          <g stroke={V4.green} strokeOpacity="0.6" strokeWidth="1.2" fill="none">
            <rect x="80" y="80" width="1280" height="740" />
            <line x1="720" y1="80" x2="720" y2="820" />
            <circle cx="720" cy="450" r="140" />
            <circle cx="720" cy="450" r="3" fill={V4.green} fillOpacity="0.5" />
            <rect x="80" y="280" width="220" height="340" />
            <rect x="80" y="380" width="90" height="140" />
            <rect x="1140" y="280" width="220" height="340" />
            <rect x="1270" y="380" width="90" height="140" />
            <circle cx="300" cy="450" r="55" strokeDasharray="4 6" />
            <circle cx="1140" cy="450" r="55" strokeDasharray="4 6" />
          </g>
          <defs>
            <radialGradient id="halo1" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={V4.green} stopOpacity="0.16" />
              <stop offset="100%" stopColor={V4.green} stopOpacity="0" />
            </radialGradient>
            <linearGradient id="topv" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#020503" stopOpacity="1" />
              <stop offset="100%" stopColor="#020503" stopOpacity="0" />
            </linearGradient>
          </defs>
          <ellipse cx="300" cy="450" rx="380" ry="280" fill="url(#halo1)" />
          <ellipse cx="1140" cy="450" rx="380" ry="280" fill="url(#halo1)" />
          <rect width="1440" height="220" fill="url(#topv)" />
        </svg>
        <div style={{
          position: "absolute", inset: 0, opacity: 0.04, pointerEvents: "none",
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.3) 1px, transparent 1px)",
          backgroundSize: "3px 3px",
        }} />
      </div>

      <div className="v4-pad-x v4-pad-tall" style={{ position: "relative", maxWidth: 1320, margin: "0 auto", padding: "120px 36px 100px", minHeight: 900 }}>
        <div className="v4-mono" style={{ display: "flex", justifyContent: "center", fontSize: 10, color: "rgba(62,240,139,0.7)", letterSpacing: 2.4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <V4Dot size={5} /> KICKOFF · JUN 11, 2026 · {daysLabel}
          </span>
        </div>

        <div style={{ marginTop: 80 }}>
          <div className="v4-mono" style={{ fontSize: 13, color: V4.green, letterSpacing: 6, marginBottom: 32, fontWeight: 500 }}>
            FIFA WORLD CUP 2026
          </div>
          <h2 className="v4-h1" style={{
            fontSize: "clamp(120px, 16vw, 220px)", color: "#e9ffef", margin: 0,
            fontFamily: OUTFIT, fontWeight: 500,
            textShadow: "0 4px 80px rgba(62,240,139,0.18)",
          }}>
            Five <span style={{ color: V4.green }}>weeks.</span>
          </h2>
          <h2 className="v4-h1" style={{
            fontSize: "clamp(120px, 16vw, 220px)", color: "#e9ffef", margin: "-12px 0 0",
            fontFamily: OUTFIT, fontWeight: 500,
          }}>
            One <span style={{ color: V4.green }}>edge.</span>
          </h2>
        </div>

        <div className="v4-4col" style={{
          marginTop: 80, paddingTop: 28, borderTop: "1px solid rgba(62,240,139,0.18)",
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 32, alignItems: "flex-start",
        }}>
          {[
            ["104", "matches", "group stage through final"],
            ["48", "nations", "every roster, every match"],
            ["1", "AI", "calling every match"],
            [cd ? String(cd.days) : "—", "days", "until kickoff"],
          ].map(([n, t, sub], i) => (
            <div key={i}>
              <div className="v4-h2 v4-stat-fit" style={{
                fontSize: 96, color: "#eaffef", fontFamily: OUTFIT,
                lineHeight: 0.9, letterSpacing: "-0.04em", fontWeight: 500,
              }}>{n}</div>
              <div style={{ fontSize: 14, color: V4.text, marginTop: 6, opacity: 0.85 }}>{t}</div>
              <div className="v4-mono" style={{ fontSize: 9.5, color: "rgba(62,240,139,0.55)", marginTop: 2, letterSpacing: 1.4 }}>{sub.toUpperCase()}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 48, display: "flex", gap: 12 }}>
          <a href="/register" className="v4-cta" style={{ padding: "16px 28px", fontSize: 14, borderRadius: 999, textDecoration: "none", display: "inline-block" }}>
            Join the beta →
          </a>
          <a href="#how-it-works" className="v4-ghost" style={{ padding: "16px 28px", fontSize: 14, borderRadius: 999, textDecoration: "none", display: "inline-block" }}>
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}

// ─── Bracket ─────────────────────────────────────────────────────────────────
function V4Bracket() {
  const groups: Array<[string, Array<[string, number]>]> = [
    ["A", [["ARG", 92], ["MEX", 64], ["POL", 48], ["SAU", 22]]],
    ["B", [["ENG", 88], ["NED", 71], ["IRN", 38], ["CAN", 28]]],
    ["C", [["BRA", 94], ["SRB", 58], ["SUI", 52], ["CMR", 24]]],
    ["D", [["FRA", 86], ["DEN", 62], ["TUN", 36], ["AUS", 26]]],
    ["E", [["ESP", 90], ["GER", 78], ["JPN", 54], ["CRC", 18]]],
    ["F", [["POR", 84], ["URU", 68], ["KOR", 44], ["GHA", 24]]],
  ];

  return (
    <section style={{ position: "relative", borderTop: `1px solid ${V4.line}` }}>
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px 88px" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 40, flexWrap: "wrap", gap: 20 }}>
          <div>
            <V4Kicker n="04" label="THE BRACKET" />
            <h2 className="v4-h2" style={{ fontSize: 80, color: V4.text, margin: "20px 0 0", maxWidth: 880 }}>
              Six groups. <span style={{ color: V4.secondary }}>Sixteen sleepers.</span>
              <br />One model running through <span style={{ color: V4.green }}>all of it.</span>
            </h2>
          </div>
          <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.5, textAlign: "right", lineHeight: 1.8 }}>
            UPDATED HOURLY<br />
            BACKED BY 43 BOOKS<br />
            <span style={{ color: V4.green }}>+ NO-VIG FAIR-PRICE BENCHMARK</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 36 }}>

          <div>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.8, marginBottom: 16 }}>
              GROUP STAGE · ACE WIN PROBABILITY (TO ADVANCE)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
              {groups.map(([letter, teams]) => (
                <div key={letter} style={{
                  border: `1px solid ${V4.line}`, background: V4.card, padding: 16,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${V4.line}` }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span className="v4-h3" style={{ fontSize: 26, color: V4.text, fontFamily: OUTFIT, fontWeight: 500 }}>Group {letter}</span>
                    </div>
                    <span className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1.5 }}>6 MATCHES</span>
                  </div>
                  {teams.map(([code, prob], i) => (
                    <div key={i} style={{
                      display: "grid", gridTemplateColumns: "30px 1fr 38px",
                      gap: 10, alignItems: "center", padding: "6px 0",
                    }}>
                      <V4CountryChip code={code} size={26} tone={1 - i * 0.15} accent={i === 0} />
                      <div style={{ height: 3, background: V4.ghost, borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${prob}%`,
                          background: i === 0 ? V4.green : V4.faint,
                        }} />
                      </div>
                      <span className="v4-mono" style={{
                        fontSize: 11,
                        color: i === 0 ? V4.green : V4.textDim,
                        textAlign: "right",
                      }}>{prob}%</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="v4-mono" style={{ marginTop: 16, fontSize: 10, color: V4.muted, letterSpacing: 1.4 }}>
              + 6 MORE GROUPS · 48 NATIONS TOTAL · LIVE THROUGH JULY 19
            </div>
          </div>

          <div>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.8, marginBottom: 16 }}>
              KNOCKOUT FUNNEL · ACE TITLE ODDS
            </div>
            <div style={{
              border: `1px solid ${V4.line}`, background: V4.card,
              padding: 22, position: "relative",
            }}>
              {[
                { round: "GROUP STAGE",   n: 48, w: 100, gold: false },
                { round: "ROUND OF 16",   n: 32, w: 76,  gold: false },
                { round: "QUARTERFINALS", n: 16, w: 58,  gold: false },
                { round: "SEMIFINALS",    n: 8,  w: 42,  gold: false },
                { round: "FINAL",         n: 4,  w: 28,  gold: false },
                { round: "CHAMPION",      n: 2,  w: 14,  gold: true },
              ].map((s, i) => (
                <div key={i} style={{ marginBottom: i === 5 ? 0 : 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="v4-mono" style={{ fontSize: 10, color: s.gold ? V4.green : V4.muted, letterSpacing: 1.4 }}>{s.round}</span>
                    <span className="v4-mono" style={{ fontSize: 10, color: V4.textDim }}>{s.n} TEAMS</span>
                  </div>
                  <div style={{
                    height: 28, background: V4.bgDeep, border: `1px solid ${V4.line}`,
                    position: "relative", display: "flex", alignItems: "center",
                  }}>
                    <div style={{
                      height: "100%", width: `${s.w}%`,
                      background: s.gold
                        ? `linear-gradient(90deg, ${V4.green}, ${V4.greenDeep})`
                        : V4.greenDim,
                      borderRight: `1px solid ${V4.green}`,
                    }} />
                    {s.gold && (
                      <span style={{
                        position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
                        fontFamily: OUTFIT, fontSize: 12, fontWeight: 600, color: V4.greenInk, letterSpacing: 0.3,
                      }}>ARG  ·  68% · top model pick</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14, border: `1px solid ${V4.line}`, background: V4.card, padding: 18 }}>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.8, marginBottom: 12 }}>
                TITLE CONTENDERS · ACE TOP 4
              </div>
              {[
                ["ARG", "Argentina", "+340", 68],
                ["BRA", "Brazil", "+420", 54],
                ["FRA", "France", "+550", 46],
                ["ESP", "Spain", "+700", 38],
              ].map(([c, n, odds, conf], i) => (
                <div key={c as string} style={{ display: "grid", gridTemplateColumns: "34px 1fr auto auto", gap: 12, alignItems: "center", padding: "8px 0", borderTop: i === 0 ? "none" : `1px solid ${V4.line}` }}>
                  <V4CountryChip code={c as string} size={26} accent={i === 0} />
                  <span style={{ fontSize: 13, color: V4.text }}>{n}</span>
                  <span className="v4-mono" style={{ fontSize: 11, color: V4.text }}>{odds}</span>
                  <span className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 0.6 }}>{conf}% conf</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Tools ───────────────────────────────────────────────────────────────────
function V4ToolI() {
  const books = Array.from({ length: 43 }, (_, i) => {
    const seed = i * 17.31;
    const odds = -120 - Math.round((Math.sin(seed) + 1) * 30);
    return { i, odds, best: i === 7, hot: i === 7 || Math.abs(odds + 140) < 10 };
  });
  return (
    <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "0.85fr 1fr", gap: 64, alignItems: "center", padding: "40px 0 80px", borderTop: `1px solid ${V4.line}` }}>
      <div>
        <div className="v4-mono" style={{ fontSize: 64, color: V4.green, opacity: 0.45, letterSpacing: "-0.03em", lineHeight: 1 }}>I.</div>
        <h3 className="v4-h3" style={{ fontSize: 42, color: V4.text, marginTop: 20, fontFamily: OUTFIT, maxWidth: 460 }}>
          ACE watches <br /><span style={{ color: V4.green }}>every game.</span>
        </h3>
        <p style={{ fontSize: 15, color: V4.secondary, lineHeight: 1.55, marginTop: 18, maxWidth: 440 }}>
          Every line at every major sportsbook, all night.
          ACE knows the real price — and tells you the moment a book gets it wrong.
        </p>
        <div style={{ marginTop: 24, display: "flex", gap: 28 }}>
          <V4Stat n="Live" label="every line" />
          <V4Stat n="20+" label="books watched" />
          <V4Stat n="AI" label="scores them all" />
        </div>
      </div>

      <div style={{
        position: "relative", border: `1px solid ${V4.line}`, background: V4.card,
        padding: 36, minHeight: 460,
      }}>
        <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span>ARG ML · ALL BOOKS · LIVE</span>
          <span style={{ color: V4.green, display: "flex", alignItems: "center", gap: 6 }}><V4Dot size={5} /> +EV RADAR ACTIVE</span>
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12,
          padding: 18, background: V4.bgDeep, border: `1px solid ${V4.line}`,
        }}>
          {books.map((b) => (
            <div key={b.i} style={{
              aspectRatio: "1", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              border: `1px solid ${b.best ? V4.green : V4.line}`,
              background: b.best ? V4.greenDim : "transparent",
              position: "relative",
              boxShadow: b.best ? "0 0 24px -4px rgba(62,240,139,0.5)" : "none",
            }}>
              <span style={{
                width: b.best ? 7 : 4, height: b.best ? 7 : 4, borderRadius: "50%",
                background: b.best ? V4.green : b.hot ? V4.green : V4.faint,
                animation: b.best ? "v4Pulse 1.6s ease-in-out infinite" : "none",
              }} />
              <span className="v4-mono" style={{
                position: "absolute", bottom: 4,
                fontSize: 8.5, color: b.best ? V4.green : V4.muted, letterSpacing: 0.4,
              }}>{b.odds}</span>
              {b.best && (
                <span className="v4-mono" style={{
                  position: "absolute", top: 3,
                  fontSize: 7.5, color: V4.green, letterSpacing: 1, fontWeight: 600,
                }}>BEST</span>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "center" }} className="v4-mono">
          <span style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.4 }}>BEST PRICE FOUND · DK -148</span>
          <span style={{ fontSize: 10, color: V4.green, letterSpacing: 1.4 }}>EDGE +6.2% vs FAIR -178</span>
        </div>
      </div>
    </div>
  );
}

function V4MiniPickCard({ tag, match, pick, pct, reason, odds, book }: { tag: string; match: string; pick: string; pct: number; reason: string; odds: string; book: string }) {
  return (
    <div style={{
      background: V4.card, border: `1px solid ${V4.line}`,
      padding: 18,
      display: "grid", gridTemplateColumns: "72px 1fr auto", gap: 18, alignItems: "center",
      transition: "border-color .12s, background .12s",
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: "50%",
        background: `conic-gradient(${V4.green} 0% ${pct}%, ${V4.ghost} ${pct}% 100%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: V4.card,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: 18, color: V4.green, fontWeight: 500, fontFamily: OUTFIT, letterSpacing: "-0.02em", lineHeight: 1 }}>{pct}<span style={{ fontSize: 11 }}>%</span></span>
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1.4, marginBottom: 6 }}>
          {tag} · {match}
        </div>
        <div style={{ fontSize: 19, color: V4.text, fontFamily: OUTFIT, fontWeight: 500, marginBottom: 6, letterSpacing: "-0.014em" }}>
          {pick}
        </div>
        <div style={{ fontSize: 12.5, color: V4.secondary, lineHeight: 1.45 }}>
          &quot;{reason}&quot;
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div className="v4-mono" style={{ fontSize: 15, color: V4.text, fontWeight: 500 }}>{odds}</div>
        <div className="v4-mono" style={{ fontSize: 9, color: V4.muted, letterSpacing: 1.2, marginTop: 3 }}>BEST · {book}</div>
        <button className="v4-cta" style={{ marginTop: 10, padding: "7px 12px", fontSize: 10.5, borderRadius: 5, letterSpacing: 0.3 }}>
          Add to bets
        </button>
      </div>
    </div>
  );
}

function V4ToolII() {
  const picks = [
    { tag: "⚽ WC · GROUP D",    match: "Argentina vs Mexico",  pick: "Argentina to win",  pct: 78, reason: "Argentina's been dominant. Mexico's missing their starting CB.",     odds: "-148", book: "DK"  },
    { tag: "🏀 NBA · TONIGHT 7PM",match: "Celtics vs Heat",     pick: "Celtics by 4+",     pct: 74, reason: "Boston covers when rested. Miami on a 2nd of back-to-back.",         odds: "-110", book: "FD"  },
    { tag: "⚾ MLB · TONIGHT 9PM",match: "Dodgers vs Giants",   pick: "Under 8.5 runs",    pct: 69, reason: "Two aces pitching. Wind blowing in. Classic pitchers' duel.",        odds: "-108", book: "MGM" },
  ];
  return (
    <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "1fr 0.85fr", gap: 64, alignItems: "center", padding: "60px 0 80px", borderTop: `1px solid ${V4.line}` }}>
      <div>
        <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.8, marginBottom: 18, display: "flex", justifyContent: "space-between" }}>
          <span>TONIGHT&apos;S TOP PICKS</span>
          <span style={{ color: V4.green, display: "flex", alignItems: "center", gap: 6 }}>
            <V4Dot size={5} /> 3 OF 28 SHOWN
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {picks.map((p, i) => <V4MiniPickCard key={i} {...p} />)}
        </div>
        <div className="v4-mono" style={{
          marginTop: 16, padding: "14px 18px", background: V4.card,
          border: `1px solid ${V4.line}`, fontSize: 11, color: V4.textDim,
          letterSpacing: 0.5, display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ color: V4.muted, letterSpacing: 1.4 }}>+ 25 MORE PICKS WAITING IN YOUR FEED</span>
          <span style={{ color: V4.green }}>see all →</span>
        </div>
      </div>

      <div>
        <div className="v4-mono" style={{ fontSize: 64, color: V4.green, opacity: 0.45, letterSpacing: "-0.03em", lineHeight: 1 }}>II.</div>
        <h3 className="v4-h3" style={{ fontSize: 42, color: V4.text, marginTop: 20, fontFamily: OUTFIT, maxWidth: 460 }}>
          Then tells you <br /><span style={{ color: V4.green }}>what to bet.</span>
        </h3>
        <p style={{ fontSize: 15, color: V4.secondary, lineHeight: 1.55, marginTop: 18, maxWidth: 440 }}>
          Just the picks worth your money — with the reasoning attached.
          Like having the smartest bettor you know in your pocket.
        </p>
        <div style={{ marginTop: 24, display: "flex", gap: 28 }}>
          <V4Stat n="Picks" label="worth your money" />
          <V4Stat n="Why" label="shown every time" />
          <V4Stat n="Live" label="all night" />
        </div>
      </div>
    </div>
  );
}

function V4ToolIII() {
  const legs = [
    { label: "BRA ML",             odds: "-198", book: "FD",  diff: "+$2.40" },
    { label: "ARG -1.5",           odds: "+105", book: "DK",  diff: "+$3.10" },
    { label: "ENG / NED Over 2.5", odds: "-110", book: "MGM", diff: "+$1.80" },
    { label: "POR ML",             odds: "-150", book: "365", diff: "+$1.10" },
  ];
  return (
    <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "0.85fr 1fr", gap: 64, alignItems: "center", padding: "60px 0 40px", borderTop: `1px solid ${V4.line}` }}>
      <div>
        <div className="v4-mono" style={{ fontSize: 64, color: V4.green, opacity: 0.45, letterSpacing: "-0.03em", lineHeight: 1 }}>III.</div>
        <h3 className="v4-h3" style={{ fontSize: 42, color: V4.text, marginTop: 20, fontFamily: OUTFIT, maxWidth: 460 }}>
          And gets you the <br /><span style={{ color: V4.green }}>best price.</span>
        </h3>
        <p style={{ fontSize: 15, color: V4.secondary, lineHeight: 1.55, marginTop: 18, maxWidth: 440 }}>
          ACE tells you which sportsbook has the best price right now.
          Free money you used to leave on the table.
        </p>
        <div style={{ marginTop: 24, display: "flex", gap: 28 }}>
          <V4Stat n="+$8.40" label="avg saved / $100" />
          <V4Stat n="0" label="of your money touched" />
        </div>
      </div>

      <div style={{ position: "relative", minHeight: 460, padding: 32, border: `1px solid ${V4.line}`, background: V4.card }}>
        <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, marginBottom: 18, display: "flex", justifyContent: "space-between" }}>
          <span>4-LEG PARLAY · ROUTED</span>
          <span style={{ color: V4.green }}>SAVING vs single-book: +$8.40 / $100</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 80px 1fr", gap: 0, position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {legs.map((l, i) => (
              <div key={i} style={{
                background: V4.bg, border: `1px solid ${V4.line}`,
                padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontSize: 13, color: V4.text }}>{l.label}</div>
                  <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1, marginTop: 2 }}>LEG {String(i + 1).padStart(2, "0")}</div>
                </div>
                <span className="v4-mono" style={{ fontSize: 13, color: V4.text }}>{l.odds}</span>
              </div>
            ))}
          </div>
          <svg width="80" height="220" style={{ alignSelf: "center", overflow: "visible" }}>
            {legs.map((_, i) => {
              const y1 = 22 + i * 52;
              const y2 = 22 + i * 52;
              return (
                <g key={i}>
                  <path
                    d={`M 0 ${y1} C 30 ${y1}, 50 ${y2}, 80 ${y2}`}
                    stroke={V4.green} strokeOpacity="0.45" strokeWidth="1.2" fill="none" strokeDasharray="2 3"
                  />
                  <circle cx="0" cy={y1} r="3" fill={V4.green} />
                  <circle cx="80" cy={y2} r="3" fill={V4.green} />
                </g>
              );
            })}
          </svg>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {legs.map((l, i) => (
              <div key={i} style={{
                background: V4.bg, border: `1px solid ${V4.green}`,
                padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div className="v4-mono" style={{ fontSize: 13, color: V4.green, letterSpacing: 1.2, fontWeight: 500 }}>{l.book}</div>
                  <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1, marginTop: 2 }}>BEST PRICE</div>
                </div>
                <span className="v4-mono" style={{ fontSize: 11, color: V4.green }}>{l.diff}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${V4.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.5 }}>COMBINED · TRUE PRICE</div>
            <div className="v4-mono" style={{ fontSize: 22, color: V4.text, marginTop: 4 }}>+524</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 1.5 }}>PLACE-HERE LIST READY</div>
            <button className="v4-cta" style={{ marginTop: 8, padding: "10px 18px", fontSize: 12, borderRadius: 6 }}>Open in 4 books →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function V4Tools() {
  return (
    <section style={{ position: "relative" }}>
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1320, margin: "0 auto", padding: "100px 36px" }}>
        <V4Kicker n="03" label="WHAT ACE DOES" />
        <h2 className="v4-h2 v4-h2-fit" style={{ fontSize: 80, color: V4.text, margin: "20px 0 14px", maxWidth: 1000 }}>
          The AI does the work. <br /><span style={{ color: V4.secondary }}>You just bet.</span>
        </h2>
        <p style={{ fontSize: 16, color: V4.secondary, maxWidth: 620, lineHeight: 1.6, marginBottom: 32 }}>
          Open ACE and the board is already doing the work.
        </p>

        <V4ToolI />
        <V4ToolII />
        <V4ToolIII />
      </div>
    </section>
  );
}

// ─── Track record ────────────────────────────────────────────────────────────
function V4Chart({ months, values }: { months: string[]; values: number[] }) {
  const w = 600, h = 200, pad = 12;
  const min = 50, max = 78;
  const pts: Array<[number, number]> = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / (values.length - 1);
    const y = pad + ((max - v) / (max - min)) * (h - pad * 2);
    return [x, y];
  });
  const pathLine = pts.map(([x, y], i) => (i === 0 ? "M" : "L") + x + "," + y).join(" ");
  const pathArea = pathLine + ` L${w - pad},${h - pad} L${pad},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
      <defs>
        <linearGradient id="v4ChartGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={V4.green} stopOpacity="0.32" />
          <stop offset="100%" stopColor={V4.green} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[55, 60, 65, 70, 75].map(g => {
        const y = pad + ((max - g) / (max - min)) * (h - pad * 2);
        return <line key={g} x1={pad} x2={w - pad} y1={y} y2={y} stroke={V4.line} strokeDasharray="1 4" />;
      })}
      <path d={pathArea} fill="url(#v4ChartGrad)" />
      <path d={pathLine} fill="none" stroke={V4.green} strokeWidth="1.6" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 4 : 1.8}
          fill={i === pts.length - 1 ? V4.green : V4.bg}
          stroke={V4.green} strokeWidth="1.2" />
      ))}
    </svg>
  );
}

function V4TrackRecord() {
  const months = ["JUN","JUL","AUG","SEP","OCT","NOV","DEC","JAN","FEB","MAR","APR","MAY"];
  const values = [54, 61, 58, 66, 70, 63, 72, 68, 74, 71, 65, 68.4];
  return (
    <section style={{ borderTop: `1px solid ${V4.line}`, background: V4.bgDeep }}>
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 72, alignItems: "center" }}>
          <div>
            <V4Kicker n="04" label="THE LEDGER" />
            <h2 className="v4-h2 v4-h2-fit" style={{ fontSize: 72, color: V4.text, margin: "20px 0 18px" }}>
              We&apos;ll publish the <br /><span style={{ color: V4.secondary }}>losses too.</span>
            </h2>
            <p style={{ fontSize: 15, color: V4.secondary, lineHeight: 1.6, margin: 0, marginBottom: 26 }}>
              Every pick — win or loss — gets logged publicly from beta day one.
              When ACE has cold weeks, you&apos;ll see them too.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              {[
                ["68.4%", "backtest accuracy"],
                ["+4.8%", "avg edge vs market"],
                ["Public", "win-loss ledger"],
                ["WC2026", "coverage from kickoff"],
              ].map(([v, l]) => (
                <div key={l} style={{ paddingTop: 18, borderTop: `1px solid ${V4.line}` }}>
                  <div style={{ fontSize: 38, fontWeight: 500, color: V4.text, fontFamily: OUTFIT, letterSpacing: "-0.025em", lineHeight: 0.95 }}>{v}</div>
                  <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.4, marginTop: 6 }}>{l.toUpperCase()}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ border: `1px solid ${V4.line}`, background: V4.card, padding: 28 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }} className="v4-mono">
              <span style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6 }}>BACKTEST ACCURACY · TRAILING 12 MONTHS</span>
              <span style={{ fontSize: 10, color: V4.green, letterSpacing: 1.6 }}>TARGET · 68.4%</span>
            </div>
            <V4Chart months={months} values={values} />
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: `repeat(${months.length}, 1fr)` }}>
              {months.map(m => <span key={m} className="v4-mono" style={{ fontSize: 9, color: V4.muted, letterSpacing: 0.5, textAlign: "center" }}>{m}</span>)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Receipt ─────────────────────────────────────────────────────────────────
function V4Receipt() {
  const reasons = [
    { ok: true,  text: "Argentina's been dominant — won every group match by 2+." },
    { ok: true,  text: "Mexico is missing their starting center-back (knee, 4-6 weeks)." },
    { ok: true,  text: "Sharp money has been pouring in on Argentina all week." },
    { ok: true,  text: "Argentina got 3 extra days of rest. Mexico travelled in last night." },
    { ok: false, text: "Mexico plays well at MetLife. Their fans always travel." },
  ];
  return (
    <section style={{ position: "relative", borderTop: `1px solid ${V4.line}` }}>
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <V4Kicker n="05" label="EVERY PICK" />
        <h2 className="v4-h2 v4-h2-fit" style={{ fontSize: 72, color: V4.text, margin: "20px 0 12px", maxWidth: 900 }}>
          A pick. <span style={{ color: V4.secondary }}>And why.</span>
        </h2>
        <p style={{ fontSize: 15, color: V4.secondary, lineHeight: 1.6, maxWidth: 620, margin: 0, marginBottom: 32 }}>
          Every pick comes with the reasoning. Here&apos;s what tonight&apos;s biggest match looks like in ACE.
        </p>

        <div className="v4-card-pad" style={{
          border: `1px solid ${V4.lineMid}`, background: V4.card,
          padding: 32, boxShadow: "0 30px 80px -20px rgba(0,0,0,0.6)",
        }}>
          <div className="v4-bottom-row-stack" style={{
            display: "flex", justifyContent: "space-between", alignItems: "flex-start",
            paddingBottom: 24, borderBottom: `1px solid ${V4.line}`,
          }}>
            <div>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 2.4 }}>
                ⚽ WORLD CUP 2026 · GROUP D · 16 JUN · 9PM ET
              </div>
              <div className="v4-h2 v4-pick-h2-fit" style={{ fontSize: 64, color: V4.text, marginTop: 18, fontFamily: OUTFIT }}>
                Argentina <span style={{ color: V4.muted }}>vs</span> Mexico
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 2.4 }}>ACE SAYS</div>
              <div className="v4-h2" style={{ fontSize: 36, color: V4.green, marginTop: 8, fontFamily: OUTFIT, fontWeight: 500, letterSpacing: "-0.02em" }}>Argentina ML</div>
              <div className="v4-h1 v4-pct-fit" style={{ fontSize: 80, color: V4.green, lineHeight: 1, marginTop: 8, fontFamily: OUTFIT, letterSpacing: "-0.04em" }}>78<span style={{ fontSize: 28, color: V4.greenSoft }}>%</span></div>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 1.6, marginTop: 6 }}>CONFIDENT</div>
            </div>
          </div>

          <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 48, paddingTop: 32 }}>
            <div>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, marginBottom: 18 }}>
                ↳ WHY ACE LIKES IT
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {reasons.map((r, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 12, alignItems: "flex-start" }}>
                    <span style={{
                      width: 20, height: 20, borderRadius: "50%",
                      background: r.ok ? V4.greenDim : "rgba(239,68,68,0.08)",
                      border: `1px solid ${r.ok ? V4.green : "rgba(239,68,68,0.4)"}`,
                      color: r.ok ? V4.green : V4.red,
                      fontSize: 11, fontWeight: 600,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      marginTop: 2, flexShrink: 0,
                    }}>{r.ok ? "✓" : "×"}</span>
                    <span style={{ fontSize: 15, color: r.ok ? V4.textDim : V4.secondary, lineHeight: 1.5 }}>
                      {r.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, marginBottom: 18 }}>
                ↳ WHERE TO PLACE IT
              </div>
              <div style={{ background: V4.bgDeep, border: `1px solid ${V4.line}`, padding: 20 }}>
                <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.5 }}>BEST PRICE OF 43 BOOKS</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8 }}>
                  <span style={{ fontSize: 28, color: V4.text, fontFamily: OUTFIT, fontWeight: 500, letterSpacing: "-0.02em" }}>DraftKings</span>
                  <span className="v4-mono" style={{ fontSize: 28, color: V4.green, fontWeight: 500 }}>-148</span>
                </div>
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${V4.line}`, display: "flex", justifyContent: "space-between" }}>
                  <span className="v4-mono" style={{ fontSize: 11, color: V4.muted, letterSpacing: 1.2 }}>BET $100</span>
                  <span className="v4-mono" style={{ fontSize: 11, color: V4.green, letterSpacing: 1.2 }}>→ WIN $67.57</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="v4-mono" style={{ fontSize: 11, color: V4.muted, letterSpacing: 1.2 }}>NEXT BEST (FANDUEL)</span>
                  <span className="v4-mono" style={{ fontSize: 11, color: V4.textDim, letterSpacing: 1.2 }}>-152 · WIN $65.79</span>
                </div>
                <button className="v4-cta" style={{ marginTop: 18, width: "100%", padding: "13px", fontSize: 13, borderRadius: 6 }}>
                  Add to my bets →
                </button>
              </div>

              <div style={{ marginTop: 14, padding: 16, border: `1px solid ${V4.line}`, background: V4.card }}>
                <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.5, marginBottom: 8 }}>FOR THE NERDS</div>
                <div style={{ fontSize: 12.5, color: V4.secondary, lineHeight: 1.55 }}>
                  Want all the factors, line history, and historical comps that drove this pick?
                  <span style={{ color: V4.green }}> It&apos;s one tap away</span> — but you don&apos;t need to read any of it to bet.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Testimonials ────────────────────────────────────────────────────────────
function V4ProfileQuote({ name, role, tag, quote, stat1, stat2 }: { name: string; role: string; tag: string; quote: string; stat1: [string, string]; stat2: [string, string] }) {
  return (
    <div style={{
      border: `1px solid ${V4.line}`, background: V4.card,
      padding: 28, display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, background: V4.bgDeep, border: `1px solid ${V4.line}`, position: "relative", overflow: "hidden" }}>
            <svg viewBox="0 0 38 38" style={{ position: "absolute", inset: 0 }}>
              <defs>
                <pattern id={`ht-${name.replace(/\s|\./g, "")}`} width="3" height="3" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="0.8" fill={V4.green} fillOpacity="0.8" />
                </pattern>
              </defs>
              <ellipse cx="19" cy="14" rx="8" ry="9" fill={`url(#ht-${name.replace(/\s|\./g, "")})`} />
              <ellipse cx="19" cy="38" rx="14" ry="10" fill={`url(#ht-${name.replace(/\s|\./g, "")})`} />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 14, color: V4.text, fontFamily: OUTFIT, fontWeight: 500 }}>{name}</div>
            <div className="v4-mono" style={{ fontSize: 9.5, color: V4.muted, letterSpacing: 1.2, marginTop: 2 }}>{role.toUpperCase()}</div>
          </div>
        </div>
        <span className="v4-mono" style={{ fontSize: 9, color: V4.green, letterSpacing: 1.6, padding: "3px 6px", border: `1px solid ${V4.green}`, background: V4.greenDim }}>{tag}</span>
      </div>
      <p style={{ fontSize: 14, color: V4.textDim, lineHeight: 1.55, margin: 0, flex: 1 }}>
        &quot;{quote}&quot;
      </p>
      <div style={{ marginTop: 22, paddingTop: 16, borderTop: `1px solid ${V4.line}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {[stat1, stat2].map(([k, v], i) => (
          <div key={i}>
            <div className="v4-mono" style={{ fontSize: 9, color: V4.muted, letterSpacing: 1.4 }}>{k.toUpperCase()}</div>
            <div style={{ fontSize: 16, color: V4.green, fontFamily: OUTFIT, fontWeight: 500, marginTop: 4, letterSpacing: "-0.012em" }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function V4Testimonials() {
  return (
    <section style={{ borderTop: `1px solid ${V4.line}`, background: V4.bgDeep }}>
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <V4Kicker n="08" label="THE BETA" />
        <h2 className="v4-h2" style={{ fontSize: 72, color: V4.text, margin: "20px 0 48px" }}>
          From the <span style={{ color: V4.secondary }}>private beta.</span>
        </h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr", gap: 18, alignItems: "stretch" }}>
          <V4ProfileQuote
            name="Marc V."
            role="$500/wk · Austin"
            tag="PRO · 6 MO"
            quote="Replaced five tabs and my Action Network sub in a week. The router alone pays for the subscription."
            stat1={["L30 ROI", "+12.8%"]}
            stat2={["Picks taken", "47"]}
          />

          <div style={{
            border: `1px solid ${V4.lineMid}`,
            background: `linear-gradient(180deg, ${V4.card}, ${V4.bg})`,
            padding: "40px 36px", display: "flex", flexDirection: "column", justifyContent: "space-between",
            position: "relative",
          }}>
            <div className="v4-h1" style={{
              fontSize: 240, lineHeight: 0.6, color: V4.green, opacity: 0.85,
              position: "absolute", top: 18, left: 22, fontFamily: OUTFIT, fontWeight: 400,
              letterSpacing: "-0.06em",
            }}>&quot;</div>
            <div style={{ marginTop: 80 }}>
              <p className="v4-h3" style={{
                fontSize: 32, color: V4.text,
                fontFamily: OUTFIT, fontWeight: 400, lineHeight: 1.18,
              }}>
                Finally a betting product that feels like a
                <span style={{ color: V4.green }}> terminal </span>
                instead of a casino ad. The model card is the part —
                you can actually see <em style={{ color: V4.secondary, fontStyle: "italic" }}>why</em> it likes the play.
              </p>
            </div>
            <div style={{ marginTop: 32, paddingTop: 22, borderTop: `1px solid ${V4.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <div>
                <div style={{ fontSize: 17, color: V4.text, fontFamily: OUTFIT, fontWeight: 500 }}>Priya R.</div>
                <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.4, marginTop: 4 }}>QUANT · NYC · PRO · 9 MO</div>
              </div>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.green, letterSpacing: 1.6, textAlign: "right" }}>
                — FROM THE BETA<br />
                <span style={{ color: V4.muted }}>VERIFIED USER</span>
              </div>
            </div>
          </div>

          <V4ProfileQuote
            name="Dev K."
            role="Semi-pro · Toronto"
            tag="SHARP · 1 YR"
            quote="Was paying $199 to OddsJam. Switched for a tenth of the price with 80% of what I actually used. No contest."
            stat1={["Switched from", "OddsJam"]}
            stat2={["Saved / mo", "$180"]}
          />
        </div>
      </div>
    </section>
  );
}

// ─── Manifesto ───────────────────────────────────────────────────────────────
function V4Manifesto() {
  const lines: Array<["No" | "Yes", string]> = [
    ["No", "lucky pick of the day."],
    ["No", "fake urgency or manufactured scarcity."],
    ["No", "confetti when you win."],
    ["No", "\"crush the books\" marketing."],
    ["No", "dark patterns or auto-renewals."],
    ["Yes", "published losses with the wins."],
    ["Yes", "full math behind every pick."],
    ["Yes", "a tool built by people who bet."],
  ];
  return (
    <section style={{ position: "relative", borderTop: `1px solid ${V4.line}` }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 700, height: 400,
        background: "radial-gradient(ellipse, rgba(62,240,139,0.08), transparent 70%)",
        pointerEvents: "none", filter: "blur(20px)",
      }} />
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1080, margin: "0 auto", padding: "120px 36px", position: "relative" }}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <V4Kicker n="06" label="MANIFESTO" />
          <h2 className="v4-h1 v4-h2-fit" style={{ fontSize: 96, color: V4.text, margin: "24px 0 0", display: "inline-block" }}>
            What ACE <span style={{ color: V4.secondary, fontStyle: "italic" }}>isn&apos;t.</span>
            <br />
            What ACE <span style={{ color: V4.green, fontStyle: "italic" }}>is.</span>
          </h2>
        </div>
        {lines.map(([k, v], i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "70px 1fr 30px",
            padding: "20px 0",
            borderTop: i === 0 ? `1px solid ${V4.line}` : "none",
            borderBottom: `1px solid ${V4.line}`,
            alignItems: "baseline",
          }}>
            <span className="v4-mono" style={{
              fontSize: 13,
              color: k === "Yes" ? V4.green : V4.muted,
              letterSpacing: 1.4,
            }}>{k.toLowerCase()}.</span>
            <span className="v4-h3 v4-h3-fit" style={{
              fontSize: 28,
              fontFamily: OUTFIT, fontWeight: 400,
              color: k === "Yes" ? V4.text : V4.textDim,
              textDecoration: k === "No" ? "line-through" : "none",
              textDecorationColor: V4.faint,
              textDecorationThickness: "1px",
            }}>{v}</span>
            <span className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1, textAlign: "right" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Pricing ─────────────────────────────────────────────────────────────────
function V4Pricing() {
  const tiers = [
    {
      name: "Free", price: "$0", tag: "Start researching today.",
      features: ["Live odds · 43+ books", "Basic line comparison", "Manual parlay builder", "Lines delayed 15 min"],
      cta: "Start free",
      featured: false,
    },
    {
      name: "Pro", price: "$19", tag: "For the serious casual.",
      featured: true,
      features: ["Everything in Free", "AI picks with reasoning", "Real-time line movement", "Best-book alerts", "+EV radar", "WC2026 playbook"],
      cta: "Go Pro",
    },
    {
      name: "Sharp", price: "$49", tag: "Institutional tools.",
      features: ["Everything in Pro", "Custom model builder", "CLV tracking", "Arbitrage scanner", "API access", "Private Discord"],
      cta: "Go Sharp",
      featured: false,
    },
  ];
  return (
    <section style={{ borderTop: `1px solid ${V4.line}`, background: V4.bgDeep }}>
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 48, flexWrap: "wrap", gap: 24 }}>
          <div>
            <V4Kicker n="09" label="ACCESS" />
            <h2 className="v4-h2" style={{ fontSize: 72, color: V4.text, margin: "20px 0 0" }}>
              Pricing that <span style={{ color: V4.secondary }}>respects you.</span>
            </h2>
          </div>
          <div style={{ fontSize: 14, color: V4.secondary, lineHeight: 1.6, maxWidth: 360 }}>
            Month-to-month, cancel any time. The free tier is genuinely useful — not a trial.
            We don&apos;t believe data access should cost $200/mo.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
          {tiers.map(t => (
            <div key={t.name} style={{
              position: "relative",
              border: `1px solid ${t.featured ? V4.green : V4.lineMid}`,
              background: t.featured ? `linear-gradient(180deg, rgba(62,240,139,0.06), ${V4.card})` : V4.card,
              padding: "32px 28px", display: "flex", flexDirection: "column",
              transform: t.featured ? "translateY(-10px)" : "none",
              boxShadow: t.featured ? "0 24px 80px -20px rgba(62,240,139,0.3)" : "none",
            }}>
              {t.featured && (
                <div style={{
                  position: "absolute", top: -13, left: 28, padding: "4px 10px",
                  background: V4.green, color: V4.greenInk,
                  fontFamily: MONO, fontSize: 9.5, fontWeight: 600, letterSpacing: 1.6,
                }}>MOST PICKED</div>
              )}
              <div className="v4-mono" style={{ fontSize: 11, color: V4.textDim, letterSpacing: 2 }}>
                {t.name.toUpperCase()}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 16, marginBottom: 6 }}>
                <span className="v4-h1" style={{ fontSize: 72, color: V4.text, fontFamily: OUTFIT, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1 }}>{t.price}</span>
                <span style={{ fontSize: 13, color: V4.muted }}>/ mo</span>
              </div>
              <div style={{ fontSize: 13, color: V4.secondary, marginBottom: 24 }}>{t.tag}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 11, flex: 1, paddingTop: 18, borderTop: `1px solid ${V4.line}` }}>
                {t.features.map(f => (
                  <div key={f} style={{ display: "flex", gap: 10, fontSize: 13, color: V4.textDim, alignItems: "flex-start" }}>
                    <span style={{
                      marginTop: 6, width: 4, height: 4, borderRadius: "50%",
                      background: t.featured ? V4.green : V4.faint, flexShrink: 0,
                    }} />
                    {f}
                  </div>
                ))}
              </div>
              <button className={t.featured ? "v4-cta" : "v4-ghost"} style={{ marginTop: 24, padding: "12px 16px", fontSize: 13.5, borderRadius: 999 }}>
                {t.cta} →
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────
function V4FAQ() {
  const items: Array<[string, string]> = [
    ["Is ACE a sportsbook?",
      "No. ACE picks the bets — you place them wherever you already have an account."],
    ["How accurate are the picks?",
      "Backtest accuracy targets 68%+ on graded picks. Every pick — win or loss — is logged publicly from beta day one."],
    ["How does ACE decide which picks to show me?",
      "Every game gets scored on real value, live signals, and confidence. The best ones get surfaced. Bad bets (player not playing, retired) get blocked. The reasoning is always shown."],
    ["Will ACE cover the World Cup?",
      "Yes — WC2026 is our launch focus. Every match, every group, every knockout. Live picks from kickoff on June 11."],
  ];
  const [open, setOpen] = useState<number>(2);
  return (
    <section style={{ borderTop: `1px solid ${V4.line}` }}>
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1320, margin: "0 auto", padding: "88px 36px" }}>
        <div className="v4-stack" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 72 }}>
          <div>
            <V4Kicker n="07" label="FAQ" />
            <h2 className="v4-h2 v4-h2-fit" style={{ fontSize: 64, color: V4.text, margin: "20px 0 18px" }}>
              Straight <br /><span style={{ color: V4.secondary }}>answers.</span>
            </h2>
            <p style={{ fontSize: 14, color: V4.secondary, lineHeight: 1.6, margin: 0 }}>
              Still stuck? Email <a href="mailto:team@ace.so" style={{ color: V4.green }}>team@ace.so</a> — a real human replies same day.
            </p>
          </div>
          <div>
            {items.map(([q, a], i) => (
              <div key={i} style={{
                borderTop: i === 0 ? `1px solid ${V4.line}` : "none",
                borderBottom: `1px solid ${V4.line}`,
              }}>
                <button
                  onClick={() => setOpen(open === i ? -1 : i)}
                  style={{
                    width: "100%", padding: "22px 0",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    background: "transparent", border: "none", color: "inherit", cursor: "pointer",
                    fontSize: 18, fontWeight: 500, textAlign: "left", fontFamily: OUTFIT,
                    letterSpacing: "-0.012em",
                  }}
                >
                  <span>{q}</span>
                  <span className="v4-mono" style={{ color: V4.green, fontSize: 18, marginLeft: 20 }}>
                    {open === i ? "−" : "+"}
                  </span>
                </button>
                {open === i && (
                  <div style={{ padding: "0 0 24px 0", fontSize: 14.5, color: V4.textDim, lineHeight: 1.65, maxWidth: 680 }}>
                    {a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Close ───────────────────────────────────────────────────────────────────
function V4Close() {
  const cd = useCountdown(KICKOFF_ISO);
  const parts: Array<[string, string]> = cd
    ? [
        [pad2(cd.days),  "DAYS"],
        [pad2(cd.hours), "HRS"],
        [pad2(cd.mins),  "MIN"],
      ]
    : [["—", "DAYS"], ["—", "HRS"], ["—", "MIN"]];

  return (
    <section style={{ position: "relative", overflow: "hidden", borderTop: `1px solid ${V4.line}` }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 1200, height: 700,
        background: "radial-gradient(ellipse, rgba(62,240,139,0.14), transparent 65%)",
        pointerEvents: "none", filter: "blur(40px)",
      }} />
      <div className="v4-pad-x v4-pad-tall" style={{ maxWidth: 1200, margin: "0 auto", padding: "120px 36px", position: "relative", textAlign: "center" }}>
        <V4Kicker n="08" label="READY" />

        <div style={{ marginTop: 36, display: "inline-flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", justifyContent: "center" }}>
          {parts.map(([n, l], i) => (
            <div key={i} style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <div>
                <div className="v4-h1 v4-countdown-fit" style={{
                  fontSize: 132, color: V4.text, fontFamily: OUTFIT,
                  fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 0.9,
                }}>{n}</div>
                <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 2, marginTop: 8 }}>{l}</div>
              </div>
              {i < parts.length - 1 && <div style={{ fontSize: 48, color: V4.faint, lineHeight: 1, paddingBottom: 26 }}>:</div>}
            </div>
          ))}
        </div>
        <div className="v4-mono" style={{ marginTop: 24, fontSize: 11, color: V4.green, letterSpacing: 2.4 }}>
          UNTIL KICKOFF · WC 2026 · JUN 11 · 9PM ET
        </div>

        <h2 className="v4-h1 v4-h1-fit" style={{
          fontSize: 120, color: V4.text, margin: "60px 0 28px",
          fontFamily: OUTFIT, fontWeight: 500,
        }}>
          Stop hunting lines.<br />
          <span style={{ color: V4.green }}>Start finding edges.</span>
        </h2>
        <p style={{ fontSize: 17, color: V4.secondary, maxWidth: 580, margin: "0 auto 36px", lineHeight: 1.5 }}>
          Beta is open. Invite only. Two minutes to set up. Be ready when the
          ball drops on June 11.
        </p>
        <div style={{ display: "inline-flex", gap: 12 }}>
          <a href="/register" className="v4-cta" style={{ padding: "16px 28px", fontSize: 14, borderRadius: 999, textDecoration: "none", display: "inline-block" }}>Join the beta →</a>
          <a href="/login" className="v4-ghost" style={{ padding: "16px 28px", fontSize: 14, borderRadius: 999, textDecoration: "none", display: "inline-block" }}>Sign in</a>
        </div>
        <div className="v4-mono" style={{ marginTop: 22, fontSize: 10, color: V4.muted, letterSpacing: 2 }}>
          INVITE ONLY · WC 2026 READY
        </div>
      </div>
    </section>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────────
function V4Footer() {
  return (
    <footer className="v4-pad-x" style={{ borderTop: `1px solid ${V4.line}`, background: V4.bgDeep, padding: "72px 36px 28px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div className="v4-h1 v4-wordmark-fit" style={{
          fontSize: 240, lineHeight: 0.85, letterSpacing: "-0.05em",
          color: "transparent",
          WebkitTextStroke: `1px ${V4.lineMid}`,
          marginBottom: 36, fontWeight: 600,
          fontFamily: OUTFIT,
        }}>
          ACE<span style={{ WebkitTextStroke: `1px ${V4.green}` }}>.</span>
        </div>

        <div className="v4-footer-grid" style={{
          display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", gap: 36,
          paddingTop: 32, borderTop: `1px solid ${V4.line}`,
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <img src="/ace-logo.png" alt="ACE" style={{ height: 72, width: "auto", display: "block" }} />
            </div>
            <p style={{ fontSize: 13, color: V4.secondary, lineHeight: 1.6, maxWidth: 320, margin: 0 }}>
              We do the homework. You bet smarter. <br />
              An intelligence terminal for sports bettors — not a sportsbook, not a picks service.
            </p>
            <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, marginTop: 18, letterSpacing: 1.5, display: "flex", alignItems: "center", gap: 8 }}>
              <V4Dot size={5} /> ALL SYSTEMS NOMINAL
            </div>
          </div>
          {[
            ["Product",   ["Games", "AI picks", "Watchlist", "Parlay", "Changelog"]],
            ["World Cup", ["The bracket", "Group stage", "Knockout odds", "Daily playbook"]],
            ["Company",   ["About", "Manifesto", "Careers", "Contact"]],
            ["Legal",     ["Terms", "Privacy", "Responsible play"]],
          ].map(([h, links]) => (
            <div key={h as string}>
              <div className="v4-mono" style={{ fontSize: 10, color: V4.muted, letterSpacing: 1.6, marginBottom: 16 }}>{(h as string).toUpperCase()}</div>
              {(links as string[]).map(l => (
                <div key={l} style={{ fontSize: 13, color: V4.textDim, marginBottom: 10 }}>{l}</div>
              ))}
            </div>
          ))}
        </div>

        <div className="v4-mono" style={{
          marginTop: 56, paddingTop: 24, borderTop: `1px solid ${V4.line}`,
          display: "flex", justifyContent: "space-between", fontSize: 10, color: V4.muted, letterSpacing: 1.4,
          flexWrap: "wrap", gap: 12,
        }}>
          <span>© 2026 ACE INTELLIGENCE · 21+ · GAMBLE RESPONSIBLY · 1-800-GAMBLER</span>
          <span>NOT A SPORTSBOOK · NEVER PLACED A BET</span>
        </div>
      </div>
    </footer>
  );
}

// ─── Homepage ────────────────────────────────────────────────────────────────
// Note: V4Bracket / V4Testimonials / V4Pricing are defined below but intentionally
// not composed into the page. Bracket comes back as a dashboard feature once the
// WC model is producing real probabilities. Testimonials return after real beta
// users come in. Pricing returns when beta ends and we start charging.
export default function Homepage() {
  return (
    <main className={`v4-root ${outfit.variable} ${jetbrains.variable}`} style={{ background: V4.bg, minHeight: "100dvh", position: "relative", overflow: "hidden" }}>
      <InjectV4Styles />
      <V4Nav />
      <V4StatusBar />
      <V4Hero />
      <V4Ticker />
      <div id="how-it-works"><V4Loop /></div>
      <div id="wc"><V4WCMoment /></div>
      <V4Tools />
      <div id="track-record"><V4TrackRecord /></div>
      <V4Receipt />
      <V4Manifesto />
      <div id="faq"><V4FAQ /></div>
      <V4Close />
      <V4Footer />
    </main>
  );
}
