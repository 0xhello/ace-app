export interface BetRecord {
  id: string;
  gameId: string;
  matchup: string;
  market: string;
  label: string;
  odds: number;
  book: string;
  stake: number;
  confidenceTier: "high" | "medium" | "low";
  status: "pending" | "won" | "lost" | "void";
  placedAt: string;
  settledAt?: string;
}

const STORAGE_KEY = "ace_bet_history";

export function loadBets(): BetRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveBets(newBets: BetRecord[]): void {
  const existing = loadBets();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...newBets, ...existing]));
}

export function updateBetStatus(id: string, status: BetRecord["status"]): void {
  const bets = loadBets();
  const updated = bets.map((b) =>
    b.id === id ? { ...b, status, settledAt: new Date().toISOString() } : b
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function clearBets(): void {
  localStorage.removeItem(STORAGE_KEY);
}

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

const SEED_BETS: BetRecord[] = [
  {
    id: "seed-1",
    gameId: "seed-g1",
    matchup: "Boston Celtics @ Miami Heat",
    market: "Moneyline",
    label: "Boston Celtics ML",
    odds: -145,
    book: "fanduel",
    stake: 50,
    confidenceTier: "high",
    status: "won",
    placedAt: new Date(now - 5 * day).toISOString(),
    settledAt: new Date(now - 4 * day).toISOString(),
  },
  {
    id: "seed-2",
    gameId: "seed-g2",
    matchup: "LA Lakers @ Golden State Warriors",
    market: "Spread",
    label: "Golden State -3.5",
    odds: -110,
    book: "draftkings",
    stake: 25,
    confidenceTier: "medium",
    status: "lost",
    placedAt: new Date(now - 4 * day).toISOString(),
    settledAt: new Date(now - 3 * day).toISOString(),
  },
  {
    id: "seed-3",
    gameId: "seed-g3",
    matchup: "NY Knicks @ Philadelphia 76ers",
    market: "Total",
    label: "O 224.5",
    odds: -108,
    book: "betmgm",
    stake: 30,
    confidenceTier: "high",
    status: "won",
    placedAt: new Date(now - 3 * day).toISOString(),
    settledAt: new Date(now - 2 * day).toISOString(),
  },
  {
    id: "seed-4",
    gameId: "seed-g4",
    matchup: "Denver Nuggets @ Phoenix Suns",
    market: "Moneyline",
    label: "Denver Nuggets ML",
    odds: 120,
    book: "fanduel",
    stake: 40,
    confidenceTier: "medium",
    status: "won",
    placedAt: new Date(now - 2 * day).toISOString(),
    settledAt: new Date(now - 1 * day).toISOString(),
  },
  {
    id: "seed-5",
    gameId: "seed-g5",
    matchup: "Milwaukee Bucks @ Chicago Bulls",
    market: "Spread",
    label: "Milwaukee -6.5",
    odds: -112,
    book: "caesars",
    stake: 50,
    confidenceTier: "high",
    status: "pending",
    placedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "seed-6",
    gameId: "seed-g6",
    matchup: "Cleveland Cavaliers @ Indiana Pacers",
    market: "Moneyline",
    label: "Indiana Pacers ML",
    odds: 175,
    book: "draftkings",
    stake: 20,
    confidenceTier: "low",
    status: "pending",
    placedAt: new Date(now - 60 * 60 * 1000).toISOString(),
  },
];

export function ensureSeedData(): void {
  if (typeof window === "undefined") return;
  if (loadBets().length === 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_BETS));
  }
}

export function computeStats(bets: BetRecord[]) {
  const settled = bets.filter((b) => b.status === "won" || b.status === "lost");
  const wins = settled.filter((b) => b.status === "won");
  const totalStaked = settled.reduce((a, b) => a + b.stake, 0);
  const totalReturned = wins.reduce((a, b) => {
    const dec = b.odds > 0 ? b.odds / 100 + 1 : 100 / Math.abs(b.odds) + 1;
    return a + b.stake * dec;
  }, 0);
  const profit = totalReturned - totalStaked;
  const roi = totalStaked > 0 ? (profit / totalStaked) * 100 : 0;
  const winRate = settled.length > 0 ? (wins.length / settled.length) * 100 : 0;

  const byTier = (tier: BetRecord["confidenceTier"]) => {
    const s = settled.filter((b) => b.confidenceTier === tier);
    const w = s.filter((b) => b.status === "won");
    return s.length > 0 ? Math.round((w.length / s.length) * 100) : null;
  };

  return {
    record: `${wins.length}-${settled.length - wins.length}`,
    pending: bets.filter((b) => b.status === "pending").length,
    profit,
    roi,
    winRate,
    highHit: byTier("high"),
    medHit: byTier("medium"),
    lowHit: byTier("low"),
  };
}
