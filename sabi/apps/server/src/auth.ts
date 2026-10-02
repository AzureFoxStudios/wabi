/**
 * Local authentication. Passwords use scrypt; sessions are opaque random
 * tokens stored only as SHA-256 hashes. Credentials are deliberately NOT part
 * of the event journal (exports and replicas never carry password hashes).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { one, run } from './db.ts';
import { toUser, type UserRecord } from './repo.ts';

const SESSION_DAYS = 30;
const N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, key] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export function setPassword(db: DatabaseSync, userId: string, password: string): void {
  if (password.length < 4) throw new Error('Password must be at least 4 characters');
  run(db, 'INSERT INTO credentials (user_id, password_hash) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash', userId, hashPassword(password));
  run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function login(db: DatabaseSync, username: string, password: string): { token: string; user: UserRecord } | undefined {
  const r = one(db, 'SELECT * FROM users WHERE username = ? AND active = 1', username.trim().toLowerCase());
  const cred = r ? one<{ password_hash: string }>(db, 'SELECT password_hash FROM credentials WHERE user_id = ?', r.id) : undefined;
  if (!r || !cred || !verifyPassword(password, cred.password_hash)) {
    // Spend comparable time on unknown users to avoid a username oracle.
    if (!cred) verifyPassword(password, 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return undefined;
  }
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  run(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha(token), r.id, now.toISOString(), expires.toISOString());
  return { token, user: toUser(r) };
}

export function userForToken(db: DatabaseSync, token: string | undefined): UserRecord | undefined {
  if (!token) return undefined;
  const s = one<{ user_id: string; expires_at: string }>(db, 'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha(token));
  if (!s || s.expires_at < new Date().toISOString()) return undefined;
  const r = one(db, 'SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  return r ? toUser(r) : undefined;
}

export function logout(db: DatabaseSync, token: string | undefined): void {
  if (token) run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha(token));
}
