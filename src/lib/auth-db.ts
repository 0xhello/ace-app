import { spawnSync } from "child_process";

const appRoot = process.cwd().includes("/.next/standalone") ? "/app" : process.cwd();
export const authDbPath = `${appRoot}/ml/nba_spread/data/ace_auth.db`;

function py(script: string): unknown {
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8", timeout: 5_000 });
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

export function ensureAuthSchema(): void {
  py(`
import sqlite3
conn = sqlite3.connect(${JSON.stringify(authDbPath)})
conn.executescript("""
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  label TEXT,
  used_by_email TEXT,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_bets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  matchup TEXT NOT NULL,
  market TEXT NOT NULL,
  label TEXT NOT NULL,
  odds INTEGER NOT NULL,
  book TEXT NOT NULL,
  stake REAL NOT NULL,
  confidence_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  placed_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE TABLE IF NOT EXISTS user_alerts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  matchup TEXT NOT NULL,
  team TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  condition TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  book TEXT NOT NULL DEFAULT 'any',
  status TEXT NOT NULL DEFAULT 'active',
  triggered_at TEXT,
  triggered_odds INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_watchlist (
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, game_id)
);
""")
conn.commit()
conn.close()
`);
}

export function getUserByEmail(email: string): {
  id: number;
  email: string;
  password_hash: string;
  role: string;
} | null {
  return py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.row_factory = sqlite3.Row
    r = conn.execute(
        "SELECT id, email, password_hash, role FROM users WHERE email = ?",
        (${JSON.stringify(email)},)
    ).fetchone()
    conn.close()
    print(json.dumps(dict(r) if r else None))
except Exception as e:
    print(json.dumps(None))
`) as { id: number; email: string; password_hash: string; role: string } | null;
}

export function getUserCount(): number | null {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    conn.close()
    print(json.dumps(n))
except:
    print(json.dumps(None))
`);
  return typeof r === "number" ? r : null;
}

export function createUser(email: string, passwordHash: string, role: string): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
        (${JSON.stringify(email)}, ${JSON.stringify(passwordHash)}, ${JSON.stringify(role)})
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function checkInviteCode(code: string): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    r = conn.execute(
        "SELECT id FROM invite_codes WHERE code = ? AND used_by_email IS NULL",
        (${JSON.stringify(code)},)
    ).fetchone()
    conn.close()
    print(json.dumps(r is not None))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function redeemInviteCode(code: string, email: string): void {
  py(`
import sqlite3
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "UPDATE invite_codes SET used_by_email = ?, used_at = datetime('now') WHERE code = ?",
        (${JSON.stringify(email)}, ${JSON.stringify(code)})
    )
    conn.commit()
    conn.close()
except:
    pass
`);
}

export function listInviteCodes(): {
  id: number;
  code: string;
  label: string | null;
  used_by_email: string | null;
  used_at: string | null;
  created_at: string;
}[] {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, code, label, used_by_email, used_at, created_at FROM invite_codes ORDER BY id DESC"
    ).fetchall()
    conn.close()
    print(json.dumps([dict(r) for r in rows]))
except:
    print(json.dumps([]))
`);
  return (r as { id: number; code: string; label: string | null; used_by_email: string | null; used_at: string | null; created_at: string }[]) ?? [];
}

export function createInviteCode(code: string, label?: string): boolean {
  const labelVal = label ?? null;
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "INSERT INTO invite_codes (code, label) VALUES (?, ?)",
        (${JSON.stringify(code)}, ${JSON.stringify(labelVal)})
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

// ── User Bets ─────────────────────────────────────────────────────────────────

export function getUserBets(userId: number): any[] {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, game_id, matchup, market, label, odds, book, stake, confidence_tier, status, placed_at, settled_at FROM user_bets WHERE user_id = ? ORDER BY placed_at DESC",
        (${userId},)
    ).fetchall()
    conn.close()
    print(json.dumps([dict(r) for r in rows]))
except:
    print(json.dumps([]))
`);
  return (r as any[]) ?? [];
}

export function createUserBets(userId: number, bets: any[]): boolean {
  const betsJson = JSON.stringify(bets);
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    bets = json.loads(${JSON.stringify(betsJson)})
    for b in bets:
        conn.execute(
            "INSERT OR IGNORE INTO user_bets (id, user_id, game_id, matchup, market, label, odds, book, stake, confidence_tier, placed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (b['id'], ${userId}, b['game_id'], b['matchup'], b['market'], b['label'], b['odds'], b['book'], b['stake'], b['confidence_tier'], b['placed_at'])
        )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function updateUserBetStatus(betId: string, userId: number, status: string): boolean {
  const settledAt = status !== "pending" ? new Date().toISOString() : null;
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "UPDATE user_bets SET status = ?, settled_at = ? WHERE id = ? AND user_id = ?",
        (${JSON.stringify(status)}, ${JSON.stringify(settledAt)}, ${JSON.stringify(betId)}, ${userId})
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

// ── User Alerts ───────────────────────────────────────────────────────────────

export function getUserAlerts(userId: number): any[] {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, game_id, matchup, team, market, side, condition, threshold, book, status, triggered_at, triggered_odds, created_at FROM user_alerts WHERE user_id = ? ORDER BY created_at DESC",
        (${userId},)
    ).fetchall()
    conn.close()
    print(json.dumps([dict(r) for r in rows]))
except:
    print(json.dumps([]))
`);
  return (r as any[]) ?? [];
}

export function createUserAlert(userId: number, alert: any): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    a = json.loads(${JSON.stringify(JSON.stringify(alert))})
    conn.execute(
        "INSERT INTO user_alerts (id, user_id, game_id, matchup, team, market, side, condition, threshold, book, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (a['id'], ${userId}, a['game_id'], a['matchup'], a['team'], a['market'], a['side'], a['condition'], a['threshold'], a.get('book','any'), a.get('status','active'), a.get('created_at',''))
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function updateUserAlert(alertId: string, userId: number, updates: Record<string, any>): boolean {
  const updatesJson = JSON.stringify(updates);
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    u = json.loads(${JSON.stringify(updatesJson)})
    sets = ", ".join(f"{k} = ?" for k in u.keys())
    vals = list(u.values()) + [${JSON.stringify(alertId)}, ${userId}]
    conn.execute(f"UPDATE user_alerts SET {sets} WHERE id = ? AND user_id = ?", vals)
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function deleteUserAlert(alertId: string, userId: number): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute("DELETE FROM user_alerts WHERE id = ? AND user_id = ?", (${JSON.stringify(alertId)}, ${userId}))
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export function getUserWatchlist(userId: number): string[] {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    rows = conn.execute(
        "SELECT game_id FROM user_watchlist WHERE user_id = ?",
        (${userId},)
    ).fetchall()
    conn.close()
    print(json.dumps([row[0] for row in rows]))
except:
    print(json.dumps([]))
`);
  return (r as string[]) ?? [];
}

export function addToWatchlist(userId: number, gameId: string): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "INSERT OR IGNORE INTO user_watchlist (user_id, game_id) VALUES (?, ?)",
        (${userId}, ${JSON.stringify(gameId)})
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}

export function removeFromWatchlist(userId: number, gameId: string): boolean {
  const r = py(`
import sqlite3, json
try:
    conn = sqlite3.connect(${JSON.stringify(authDbPath)})
    conn.execute(
        "DELETE FROM user_watchlist WHERE user_id = ? AND game_id = ?",
        (${userId}, ${JSON.stringify(gameId)})
    )
    conn.commit()
    conn.close()
    print(json.dumps(True))
except:
    print(json.dumps(False))
`);
  return r === true;
}
