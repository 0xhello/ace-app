/**
 * Node-only research refresh scheduler (imported by src/instrumentation.ts under
 * the nodejs runtime guard). Arming the timers is a side effect of importing this
 * module exactly once per server instance.
 *
 * Keeps soccer pre-match research (injuries + recent form) fresh with NO external
 * cron: a refresh shortly after boot (re-populates the cache after every Railway
 * redeploy) and then every few hours. Non-blocking + fully guarded.
 */
import { refreshSoccerResearch } from "@/lib/research-refresh";
import { warmGameViewBundles } from "@/lib/game-view-bundle";
import { clvLedgerTickFromCache } from "@/lib/clv-ledger";

const REFRESH_EVERY = 3 * 60 * 60 * 1000;      // 3 hours
const GAME_INTEL_EVERY = 10 * 60 * 1000;       // 10 minutes — keeps click path fast/fresh
const FIRST_DELAY = 120_000;                   // let the board cache populate first
const GAME_INTEL_FIRST_DELAY = 150_000;        // after research boot attempt
const RETRY_DELAY = 15 * 60 * 1000;            // if the board wasn't ready yet

async function kick(label: string) {
  try {
    const r = await refreshSoccerResearch();
    console.log(`[research-refresh:${label}]`, JSON.stringify(r));
    return r;
  } catch (e) {
    console.error("[research-refresh] failed:", e);
    return null;
  }
}

async function warmIntel(label: string) {
  try {
    const r = await warmGameViewBundles(label);
    console.log(`[game-intel:${label}]`, JSON.stringify(r));
    return r;
  } catch (e) {
    console.error("[game-intel] failed:", e);
    return null;
  }
}

// Initial run after boot; if the board wasn't cached yet (0 teams), retry once.
setTimeout(async () => {
  const r = await kick("boot");
  if (r && r.refreshed === 0) setTimeout(() => void kick("retry"), RETRY_DELAY);
}, FIRST_DELAY);

setTimeout(async () => {
  const r = await warmIntel("boot");
  if (r && r.refreshed === 0) setTimeout(() => void warmIntel("retry"), RETRY_DELAY);
}, GAME_INTEL_FIRST_DELAY);

async function ledgerTick(label: string) {
  try {
    const r = await clvLedgerTickFromCache();
    console.log(`[clv-ledger:${label}]`, JSON.stringify(r));
  } catch (e) {
    console.error("[clv-ledger] failed:", e);
  }
}
// CLV ledger rides the same 10-min cadence as game-intel: records new Sharp Lens
// flags, refreshes sharp fair, grades past-kickoff flags. Board-cache only — no
// API spend. First run shortly after the board cache is warm.
setTimeout(() => { void ledgerTick("boot"); }, GAME_INTEL_FIRST_DELAY + 30_000);
setInterval(() => { void ledgerTick("interval"); }, GAME_INTEL_EVERY);

setInterval(() => { void kick("interval"); }, REFRESH_EVERY);
setInterval(() => { void warmIntel("interval"); }, GAME_INTEL_EVERY);
console.log("[research-refresh] scheduler armed (research: boot + every 3h, game-view bundles + clv-ledger: boot + every 10m)");
