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
