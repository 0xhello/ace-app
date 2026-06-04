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

const REFRESH_EVERY = 3 * 60 * 60 * 1000; // 3 hours
const FIRST_DELAY = 120_000;              // let the board cache populate first
const RETRY_DELAY = 15 * 60 * 1000;       // if the board wasn't ready yet

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

// Initial run after boot; if the board wasn't cached yet (0 teams), retry once.
setTimeout(async () => {
  const r = await kick("boot");
  if (r && r.refreshed === 0) setTimeout(() => void kick("retry"), RETRY_DELAY);
}, FIRST_DELAY);

setInterval(() => { void kick("interval"); }, REFRESH_EVERY);
console.log("[research-refresh] scheduler armed (boot + every 3h)");
