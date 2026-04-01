const API_BASE = process.env.ODDS_API_URL || "http://localhost:8000";

export async function fetchTrackedIntel(limit = 10) {
  const res = await fetch(`${API_BASE}/intel/tracked?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) return { count: 0, items: [], updated_at: null };
  return res.json();
}

export async function fetchGameIntel(gameId: string) {
  const res = await fetch(`${API_BASE}/intel/game/${gameId}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}
