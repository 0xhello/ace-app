#!/usr/bin/env node
import bcrypt from 'bcryptjs';
import { DEFAULT_BASE_URL, DEFAULT_EMAIL, env, isLocalBaseUrl, requireEnv, runPython } from './lib.mjs';

const baseURL = env('ACE_BASE_URL', DEFAULT_BASE_URL);
if (!isLocalBaseUrl(baseURL)) {
  throw new Error(`Refusing to mutate auth DB for non-local ACE_BASE_URL=${baseURL}. Use a real test account for staging/prod.`);
}

const email = env('ACE_VISUAL_EMAIL', DEFAULT_EMAIL);
const password = requireEnv('ACE_VISUAL_PASSWORD');
const role = env('ACE_VISUAL_ROLE', 'user');
const dbPath = env('ACE_AUTH_DB_PATH', 'ml/nba_spread/data/ace_auth.db');
const hash = bcrypt.hashSync(password, 12);

runPython(`
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.executescript("""
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);
""")
conn.execute("""
INSERT INTO users (email, password_hash, role)
VALUES (?, ?, ?)
ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role
""", (${JSON.stringify(email)}, ${JSON.stringify(hash)}, ${JSON.stringify(role)}))
conn.commit()
conn.close()
print('ok')
`);

console.log(JSON.stringify({ ok: true, email, role, dbPath }, null, 2));
