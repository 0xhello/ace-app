/**
 * Module-level server cache.
 * Lives in the Node.js process — survives across requests but resets on cold start.
 * For multi-instance prod you'd replace this with Redis/Upstash, but this
 * eliminates the vast majority of API calls for a single-server setup.
 */

interface CacheEntry {
  data: any;
  fetchedAt: number;
}

const store = new Map<string, CacheEntry>();

// Snapshot of odds from the previous fetch — used to compute line movement
// key: gameId, value: { ml_away, ml_home, sp_away, sp_home, ov, un }
export type OddsSnapshot = Record<string, Record<string, number | null>>;
let prevOddsSnapshot: OddsSnapshot = {};

export function getPrevOddsSnapshot(): OddsSnapshot {
  return prevOddsSnapshot;
}

export function setPrevOddsSnapshot(snap: OddsSnapshot): void {
  prevOddsSnapshot = snap;
}

// TTL in ms — shorter when live games are in play
const TTL_LIVE     = 30_000;        // 30 seconds
const TTL_SOON     = 3 * 60_000;    // 3 minutes  (game starts within 2h)
const TTL_DEFAULT  = 8 * 60_000;    // 8 minutes  (nothing imminent)

export function hasLiveGames(games: any[]): boolean {
  return games.some((g: any) => g.status === "live");
}

export function hasSoonGames(games: any[]): boolean {
  const in2h = Date.now() + 2 * 60 * 60 * 1000;
  return games.some((g: any) => new Date(g.commence_time).getTime() < in2h);
}

function ttlFor(games: any[]): number {
  if (hasLiveGames(games)) return TTL_LIVE;
  if (hasSoonGames(games)) return TTL_SOON;
  return TTL_DEFAULT;
}

export function get(key: string): CacheEntry | null {
  return store.get(key) ?? null;
}

export function set(key: string, data: any): void {
  store.set(key, { data, fetchedAt: Date.now() });
}

export function isStale(key: string, games?: any[]): boolean {
  const entry = store.get(key);
  if (!entry) return true;
  const ttl = games ? ttlFor(games) : TTL_DEFAULT;
  return Date.now() - entry.fetchedAt > ttl;
}

export function age(key: string): number {
  const entry = store.get(key);
  return entry ? Date.now() - entry.fetchedAt : Infinity;
}
