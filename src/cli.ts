#!/usr/bin/env node
// Admin CLI. Runs as the service user, on the same SQLite store as the service.
//
//   keychain token create <name> (--all | --item <id>[:totp] ...) [--expires 7d]
//   keychain token list
//   keychain token revoke <id|name>
//   keychain token rotate <id|name>
//   keychain admin set-password [username]
//   keychain setup-session [--out <file>]

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Bitwarden } from './bitwarden.ts';
import { config } from './config.ts';
import { parseDuration, Store, type ScopeItem, type TokenRecord } from './store.ts';

const USAGE = `Usage:
  keychain token create <name> (--all | --item <id>[:totp] ...) [--expires 30m|12h|7d|never]
  keychain token list
  keychain token revoke <id|name>
  keychain token rotate <id|name>
  keychain admin set-password [username]     (default username: admin)
  keychain setup-session [--out <file>]      (default: <state dir>/bw-session)`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      let muted = false;
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (!muted) process.stderr.write(s);
      };
      rl.question(question, (a) => {
        rl.close();
        process.stderr.write('\n');
        resolve(a);
      });
      muted = true;
    } else {
      rl.question(process.stdin.isTTY ? question : '', (a) => {
        rl.close();
        resolve(a);
      });
    }
  });
}

function findToken(store: Store, ref: string | undefined): TokenRecord {
  if (!ref) fail(USAGE);
  const all = store.listTokens();
  const byId = /^\d+$/.test(ref) ? all.find((t) => t.id === Number(ref)) : undefined;
  const byName = all.filter((t) => t.name === ref && t.revokedAt === null);
  if (byId) return byId;
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) fail(`Several active tokens are called "${ref}". Use the id from "keychain token list".`);
  fail(`No token "${ref}".`);
}

function fmtTime(ms: number | null) {
  return ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const [group, cmd, ...rest] = process.argv.slice(2);

if (group === 'token') {
  const store = new Store(config.dbFile);
  if (cmd === 'create') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { all: { type: 'boolean' }, item: { type: 'string', multiple: true }, expires: { type: 'string', default: 'never' } },
    });
    const name = positionals[0];
    if (!name || (!values.all && !values.item?.length) || (values.all && values.item?.length)) fail(USAGE);
    const items: ScopeItem[] = (values.item ?? []).map((s) => {
      const [itemId, flag] = s.split(':');
      if (!itemId || (flag !== undefined && flag !== 'totp')) fail(`Bad --item "${s}". Use <id> or <id>:totp.`);
      return { itemId, totp: flag === 'totp' };
    });
    let ttl: number | null;
    try {
      ttl = parseDuration(values.expires!);
    } catch (e) {
      fail((e as Error).message);
    }
    const { token, secret } = store.createToken(name, values.all ? { all: true } : { all: false, items }, ttl === null ? null : Date.now() + ttl);
    process.stderr.write(`Created token ${token.id} "${token.name}". This is the only time the secret is shown:\n`);
    process.stdout.write(`${secret}\n`);
  } else if (cmd === 'list') {
    const rows = store.listTokens().map((t) => [
      String(t.id),
      t.name,
      t.prefix + '…',
      t.scope.all ? 'all items' : t.scope.items.map((i) => (i.totp ? `${i.itemId}:totp` : i.itemId)).join(','),
      t.revokedAt !== null ? 'revoked' : t.expiresAt !== null && t.expiresAt <= Date.now() ? 'expired' : `expires ${fmtTime(t.expiresAt)}`,
      `used ${fmtTime(t.lastUsedAt)}`,
    ]);
    if (rows.length === 0) process.stderr.write('No tokens.\n');
    for (const r of rows) process.stdout.write(r.join('\t') + '\n');
  } else if (cmd === 'revoke') {
    const t = findToken(store, rest[0]);
    store.revokeToken(t.id);
    process.stderr.write(`Revoked token ${t.id} "${t.name}".\n`);
  } else if (cmd === 'rotate') {
    const t = findToken(store, rest[0]);
    if (t.revokedAt !== null) fail('That token is revoked.');
    const secret = store.rotateToken(t.id);
    process.stderr.write(`New secret for token ${t.id} "${t.name}". The old one no longer works:\n`);
    process.stdout.write(`${secret}\n`);
  } else {
    fail(USAGE);
  }
  store.close();
} else if (group === 'admin' && cmd === 'set-password') {
  const username = rest[0] ?? 'admin';
  const pw = await ask(`New admin password for "${username}": `, true);
  if (pw.length < 12) fail('Use at least 12 characters.');
  if (process.stdin.isTTY && (await ask('Again: ', true)) !== pw) fail('The passwords differ.');
  const store = new Store(config.dbFile);
  await store.setAdminPassword(username, pw);
  store.close();
  process.stderr.write(`Admin password set for "${username}". Existing admin sessions were logged out.\n`);
} else if (group === 'setup-session') {
  const { values } = parseArgs({ args: [cmd, ...rest].filter(Boolean), options: { out: { type: 'string' } } });
  const out = values.out ?? join(config.stateDir, 'bw-session');
  const bw = new Bitwarden(config.bwBin);
  const status = await bw.status();
  if (status === 'unauthenticated') fail(`Not logged in to Bitwarden. Run "${config.bwBin} login" as this user first.`);
  await bw.unlock(await ask('Bitwarden master password: ', true)).catch((e: Error) => fail(e.message));
  const key = bw.sessionKey!;
  writeFileSync(out, key + '\n', { mode: 0o600 });
  chmodSync(out, 0o600);
  process.stderr.write(`Saved the session key to ${out}. The master password was not stored.\nRestart the service to pick it up.\n`);
} else {
  fail(USAGE);
}
