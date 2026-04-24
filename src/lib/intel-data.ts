// Intel data stubs — the Python backend is no longer used.
// Real signals come from live-signals.ts (ESPN + odds data).
// These return null/empty so existing callers (tracked game page) degrade gracefully.

export async function fetchTrackedIntel(_limit = 10): Promise<any> {
  return { count: 0, items: [], updated_at: null };
}

export async function fetchGameIntel(_gameId: string): Promise<any> {
  return null;
}

export async function fetchBoardIntel(_limit = 50): Promise<any> {
  return { count: 0, items: [], updated_at: null };
}

export async function fetchLiveBoardIntel(_limit = 20): Promise<any> {
  return { count: 0, items: [], updated_at: null };
}

export async function fetchTopPicks(_limit = 4): Promise<any> {
  return { count: 0, items: [], updated_at: null };
}
