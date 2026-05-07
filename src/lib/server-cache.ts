/**
 * Persistent cache backed by Upstash Redis.
 * Falls back to an in-memory Map when UPSTASH_REDIS_REST_URL is not set
 * (local dev without Redis configured).
 *
 * Redis survives process restarts and Railway deploys — the in-memory
 * Map does not, which is why credits were burning on every cold start.
 */

import { Redis } from "@upstash/redis";

// ── TTL config ─────────────────────────────────────────────────────────────────
// IMPORTANT: TTL must be longer than the client poll interval (30s live, 5min idle)
// otherwise every poll fires a real API call.
const TTL_LIVE    = 5 * 60_000;   // 5 minutes  (was 2min — 30 calls/hr × 18 credits = 540/hr)
const TTL_SOON    = 10 * 60_000;  // 10 minutes (game starts within 2h)
const TTL_DEFAULT = 20 * 60_000;  // 20 minutes (nothing imminent)

export type OddsSnapshot = Record<string, Record<string, number | null>>;

interface CacheEntry {
  data: any;
  fetchedAt: number;
}

// ── Backend selection ──────────────────────────────────────────────────────────

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// In-memory fallback (local dev / no Redis env vars)
const memStore = new Map<string, CacheEntry>();
let memOddsSnapshot: OddsSnapshot = {};

// ── TTL helpers ────────────────────────────────────────────────────────────────

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

// ── Core cache API (async) ─────────────────────────────────────────────────────

export async function get(key: string): Promise<CacheEntry | null> {
  if (redis) {
    try {
      return await redis.get<CacheEntry>(key);
    } catch (e) {
      console.error("[cache] Redis get error, falling back:", e);
    }
  }
  return memStore.get(key) ?? null;
}

export async function set(key: string, data: any, games?: any[]): Promise<void> {
  const ttlMs = ttlFor(games ?? []);
  const entry: CacheEntry = { data, fetchedAt: Date.now() };
  if (redis) {
    try {
      // px = TTL in milliseconds
      await redis.set(key, entry, { px: ttlMs });
      return;
    } catch (e) {
      console.error("[cache] Redis set error, falling back:", e);
    }
  }
  memStore.set(key, entry);
}

export function isStale(entry: CacheEntry | null, games?: any[]): boolean {
  if (!entry) return true;
  const ttl = games ? ttlFor(games) : TTL_DEFAULT;
  return Date.now() - entry.fetchedAt > ttl;
}

export function age(entry: CacheEntry | null): number {
  return entry ? Date.now() - entry.fetchedAt : Infinity;
}

// ── Active sports tracking (skip dead sports on every fetch) ──────────────────
// After each fetchAllGames(), record which sports returned ≥1 game.
// Next fetch only calls those sports; a full refresh every hour catches new ones.

const ACTIVE_SPORTS_KEY = "__active_sports__";

interface ActiveSportsEntry { sports: string[]; setAt: number }
let memActiveSports: ActiveSportsEntry | null = null;

export async function getActiveSports(): Promise<ActiveSportsEntry | null> {
  if (redis) {
    try { return await redis.get<ActiveSportsEntry>(ACTIVE_SPORTS_KEY); } catch { return null; }
  }
  return memActiveSports;
}

export async function setActiveSports(sports: string[]): Promise<void> {
  const entry: ActiveSportsEntry = { sports, setAt: Date.now() };
  if (redis) {
    try { await redis.set(ACTIVE_SPORTS_KEY, entry, { ex: 7200 }); return; } catch {}
  }
  memActiveSports = entry;
}

// ── Odds snapshot (for line movement detection) ────────────────────────────────

const SNAPSHOT_KEY = "__odds_snapshot__";

export async function getPrevOddsSnapshot(): Promise<OddsSnapshot> {
  if (redis) {
    try {
      return (await redis.get<OddsSnapshot>(SNAPSHOT_KEY)) ?? {};
    } catch {
      return {};
    }
  }
  return memOddsSnapshot;
}

export async function setPrevOddsSnapshot(snap: OddsSnapshot): Promise<void> {
  if (redis) {
    try {
      await redis.set(SNAPSHOT_KEY, snap, { ex: 3600 }); // 1-hour TTL
      return;
    } catch (e) {
      console.error("[cache] Redis snapshot set error:", e);
    }
  }
  memOddsSnapshot = snap;
}
