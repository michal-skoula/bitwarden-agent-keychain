// The keychain's own state, in one SQLite file: agent tokens and their scopes,
// the activity log, pending browser wipes, and the admin login.
//
// Tokens are stored as SHA-256 hashes. The plaintext is returned once, from
// createToken/rotateToken, and never written anywhere.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Scope = { all: true } | { all: false; items: ScopeItem[] };
export interface ScopeItem {
  itemId: string;
  totp: boolean;
}

export interface TokenRecord {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  scope: Scope;
}

export type ActivityKind = 'fill_login' | 'fill_totp' | 'fill_failed' | 'denied' | 'sign_out' | 'wipe' | 'blocked';

export interface ActivityRecord {
  id: number;
  at: number;
  tokenId: number | null;
  tokenName: string | null;
  kind: ActivityKind;
  itemId: string | null;
  itemName: string | null;
  detail: string;
  problem: boolean;
  resolvedAt: number | null;
}

export interface WipeRecord {
  origin: string;
  tokenId: number | null;
  itemId: string | null;
  lastFillAt: number;
  wipeAt: number;
  wipedAt: number | null;
  reason: string | null;
}

const TOKEN_PREFIX = 'kc_';
const SESSION_MS = 30 * 24 * 3600_000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        scope_all INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS token_items (
        token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        totp INTEGER NOT NULL,
        PRIMARY KEY (token_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        token_id INTEGER,
        token_name TEXT,
        kind TEXT NOT NULL,
        item_id TEXT,
        item_name TEXT,
        detail TEXT NOT NULL,
        problem INTEGER NOT NULL DEFAULT 0,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
      CREATE TABLE IF NOT EXISTS wipes (
        origin TEXT PRIMARY KEY,
        token_id INTEGER,
        item_id TEXT,
        last_fill_at INTEGER NOT NULL,
        wipe_at INTEGER NOT NULL,
        wiped_at INTEGER,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS admin (
        username TEXT PRIMARY KEY,
        pw_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  // --- tokens --------------------------------------------------------------

  createToken(name: string, scope: Scope, expiresAt: number | null): { token: TokenRecord; secret: string } {
    const secret = newSecret();
    const tx = this.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO tokens (name, prefix, hash, scope_all, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, secret.slice(0, 6), sha256(secret), scope.all ? 1 : 0, this.now(), expiresAt);
      const id = Number(r.lastInsertRowid);
      if (!scope.all) this.writeItems(id, scope.items);
      return id;
    });
    return { token: this.getToken(tx)!, secret };
  }

  rotateToken(id: number): string {
    const secret = newSecret();
    const r = this.db.prepare('UPDATE tokens SET prefix = ?, hash = ? WHERE id = ? AND revoked_at IS NULL').run(secret.slice(0, 6), sha256(secret), id);
    if (r.changes === 0) throw new Error(`No active token with id ${id}`);
    return secret;
  }

  revokeToken(id: number) {
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.now(), id);
  }

  setScope(id: number, scope: Scope) {
    this.transaction(() => {
      this.db.prepare('UPDATE tokens SET scope_all = ? WHERE id = ?').run(scope.all ? 1 : 0, id);
      this.db.prepare('DELETE FROM token_items WHERE token_id = ?').run(id);
      if (!scope.all) this.writeItems(id, scope.items);
    });
  }

  removeItem(id: number, itemId: string) {
    this.db.prepare('DELETE FROM token_items WHERE token_id = ? AND item_id = ?').run(id, itemId);
  }

  private writeItems(id: number, items: ScopeItem[]) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO token_items (token_id, item_id, totp) VALUES (?, ?, ?)');
    for (const it of items) ins.run(id, it.itemId, it.totp ? 1 : 0);
  }

  getToken(id: number): TokenRecord | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toToken(row) : null;
  }

  listTokens(): TokenRecord[] {
    const rows = this.db.prepare('SELECT * FROM tokens ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as Row[];
    return rows.map((r) => this.toToken(r));
  }

  // Returns the token for a bearer secret if it is active, and records the use.
  authenticate(secret: string): TokenRecord | null {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const row = this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(sha256(secret)) as Row | undefined;
    if (!row) return null;
    const t = this.toToken(row);
    const now = this.now();
    if (t.revokedAt !== null || (t.expiresAt !== null && t.expiresAt <= now)) return null;
    // Last-used is display only, so a minute of precision is plenty.
    if (t.lastUsedAt === null || now - t.lastUsedAt > 60_000) {
      this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, t.id);
      t.lastUsedAt = now;
    }
    return t;
  }

  private toToken(row: Row): TokenRecord {
    const id = Number(row.id);
    const scope: Scope = row.scope_all
      ? { all: true }
      : {
          all: false,
          items: (this.db.prepare('SELECT item_id, totp FROM token_items WHERE token_id = ? ORDER BY rowid').all(id) as Row[]).map((r) => ({
            itemId: String(r.item_id),
            totp: Boolean(r.totp),
          })),
        };
    return {
      id,
      name: String(row.name),
      prefix: String(row.prefix),
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      scope,
    };
  }

  // --- activity ------------------------------------------------------------

  log(entry: {
    token?: { id: number; name: string } | null;
    kind: ActivityKind;
    itemId?: string | null;
    itemName?: string | null;
    detail: string;
    problem?: boolean;
  }) {
    this.db
      .prepare('INSERT INTO activity (at, token_id, token_name, kind, item_id, item_name, detail, problem) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        this.now(),
        entry.token?.id ?? null,
        entry.token?.name ?? null,
        entry.kind,
        entry.itemId ?? null,
        entry.itemName ?? null,
        entry.detail,
        entry.problem ? 1 : 0,
      );
  }

  activity(filter: { tokenId?: number; problemsOnly?: boolean; limit?: number } = {}): ActivityRecord[] {
    const where: string[] = [];
    const args: (number | string)[] = [];
    if (filter.tokenId !== undefined) {
      where.push('token_id = ?');
      args.push(filter.tokenId);
    }
    if (filter.problemsOnly) where.push('problem = 1');
    const sql = `SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ?`;
    args.push(filter.limit ?? 200);
    return (this.db.prepare(sql).all(...args) as Row[]).map(toActivity);
  }

  // Blocked reports nobody has dismissed yet: the "Needs you" banner.
  openBlocked(): ActivityRecord[] {
    return (this.db.prepare("SELECT * FROM activity WHERE kind = 'blocked' AND resolved_at IS NULL ORDER BY at DESC").all() as Row[]).map(toActivity);
  }

  resolve(activityId: number) {
    this.db.prepare('UPDATE activity SET resolved_at = ? WHERE id = ?').run(this.now(), activityId);
  }

  fillCount(tokenId: number, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM activity WHERE token_id = ? AND kind IN ('fill_login', 'fill_totp') AND at >= ?")
      .get(tokenId, sinceMs) as Row;
    return Number(row.n);
  }

  // --- wipes ---------------------------------------------------------------

  scheduleWipe(origin: string, tokenId: number | null, itemId: string | null, wipeAt: number) {
    this.db
      .prepare(
        `INSERT INTO wipes (origin, token_id, item_id, last_fill_at, wipe_at, wiped_at, reason) VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(origin) DO UPDATE SET token_id = excluded.token_id, item_id = excluded.item_id,
           last_fill_at = excluded.last_fill_at, wipe_at = excluded.wipe_at, wiped_at = NULL, reason = NULL`,
      )
      .run(origin, tokenId, itemId, this.now(), wipeAt);
  }

  pendingWipes(): WipeRecord[] {
    return (this.db.prepare('SELECT * FROM wipes WHERE wiped_at IS NULL ORDER BY wipe_at').all() as Row[]).map(toWipe);
  }

  // Pending wipes, plus finished ones from the last day so the UI can say "signed out at".
  wipesForToken(tokenId: number): WipeRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM wipes WHERE token_id = ? AND (wiped_at IS NULL OR wiped_at > ?) ORDER BY wiped_at IS NOT NULL, wipe_at')
        .all(tokenId, this.now() - 24 * 3600_000) as Row[]
    ).map(toWipe);
  }

  getWipe(origin: string): WipeRecord | null {
    const row = this.db.prepare('SELECT * FROM wipes WHERE origin = ?').get(origin) as Row | undefined;
    return row ? toWipe(row) : null;
  }

  markWiped(origin: string, reason: string) {
    this.db.prepare('UPDATE wipes SET wiped_at = ?, reason = ? WHERE origin = ?').run(this.now(), reason, origin);
  }

  // --- admin login ---------------------------------------------------------

  async setAdminPassword(username: string, password: string) {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const hash = `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
    this.transaction(() => {
      // One admin. Setting a password replaces whoever was there and logs out every session.
      this.db.exec('DELETE FROM admin; DELETE FROM sessions;');
      this.db.prepare('INSERT INTO admin (username, pw_hash) VALUES (?, ?)').run(username, hash);
    });
  }

  hasAdmin(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM admin').get());
  }

  async checkAdmin(username: string, password: string): Promise<boolean> {
    const row = this.db.prepare('SELECT pw_hash FROM admin WHERE username = ?').get(username) as Row | undefined;
    // Hash anyway on an unknown user, so timing doesn't reveal the username.
    const [, saltB64, keyB64] = (row ? String(row.pw_hash) : `scrypt$${'A'.repeat(24)}$${'A'.repeat(44)}`).split('$');
    const want = Buffer.from(keyB64, 'base64');
    const got = await scryptAsync(password, Buffer.from(saltB64, 'base64'), want.length, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return Boolean(row) && timingSafeEqual(got, want);
  }

  createSession(username: string): string {
    const id = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (hash, username, expires_at) VALUES (?, ?, ?)').run(sha256(id), username, this.now() + SESSION_MS);
    return id;
  }

  // Valid session: renews it for another 30 days and returns the username.
  touchSession(id: string): string | null {
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    const row = this.db.prepare('SELECT username FROM sessions WHERE hash = ?').get(sha256(id)) as Row | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE hash = ?').run(now + SESSION_MS, sha256(id));
    return String(row.username);
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha256(id));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

export const SESSION_MAX_AGE_S = SESSION_MS / 1000;

function newSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

function toActivity(r: Row): ActivityRecord {
  return {
    id: Number(r.id),
    at: Number(r.at),
    tokenId: r.token_id === null ? null : Number(r.token_id),
    tokenName: r.token_name === null ? null : String(r.token_name),
    kind: String(r.kind) as ActivityKind,
    itemId: r.item_id === null ? null : String(r.item_id),
    itemName: r.item_name === null ? null : String(r.item_name),
    detail: String(r.detail),
    problem: Boolean(r.problem),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
  };
}

function toWipe(r: Row): WipeRecord {
  return {
    origin: String(r.origin),
    tokenId: r.token_id === null ? null : Number(r.token_id),
    itemId: r.item_id === null ? null : String(r.item_id),
    lastFillAt: Number(r.last_fill_at),
    wipeAt: Number(r.wipe_at),
    wipedAt: r.wiped_at === null ? null : Number(r.wiped_at),
    reason: r.reason === null ? null : String(r.reason),
  };
}

// "7d", "12h", "30m" -> milliseconds. "never" -> null.
export function parseDuration(s: string): number | null {
  if (s === 'never') return null;
  const m = /^(\d+)\s*([mhdw])$/.exec(s.trim());
  if (!m) throw new Error(`Bad duration "${s}". Use e.g. 30m, 12h, 7d, 2w or never.`);
  return Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as 'm' | 'h' | 'd' | 'w'];
}
