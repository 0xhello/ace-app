const API_BASE = process.env.ODDS_API_URL || "http://localhost:8000";

async function safeFetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return res.json();
  } catch {
    return fallback;
  }
}

export async function fetchTrackedIntel(limit = 10): Promise<any> {
  return safeFetchJson<any>(`/intel/tracked?limit=${limit}`, { count: 0, items: [], updated_at: null });
}

export async function fetchGameIntel(gameId: string): Promise<any> {
  return safeFetchJson<any>(`/intel/game/${gameId}`, null);
}

export async function fetchBoardIntel(limit = 50): Promise<any> {
  return safeFetchJson<any>(`/intel/board?limit=${limit}`, { count: 0, items: [], updated_at: null });
}

export async function fetchLiveBoardIntel(limit = 20): Promise<any> {
  return safeFetchJson<any>(`/intel/live-board?limit=${limit}`, { count: 0, items: [], updated_at: null });
}

export async function fetchTopPicks(limit = 4): Promise<any> {
  return safeFetchJson<any>(`/intel/picks?limit=${limit}`, { count: 0, items: [], updated_at: null });
}
