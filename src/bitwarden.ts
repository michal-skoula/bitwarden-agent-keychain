// Thin wrapper around the Bitwarden CLI (`bw`).
//
// The session key lives only in this process's memory and is passed to each
// `bw` child process through its environment. Secrets returned by `bw` never
// leave this module except as arguments to the browser filler.

import { execFile } from 'node:child_process';

export interface LoginSummary {
  id: string;
  name: string;
  username: string | null;
  uris: LoginUri[];
  hasTotp: boolean;
}

export interface LoginUri {
  uri: string;
  // Bitwarden match type: null = account default (base domain), 0 domain,
  // 1 host, 2 starts with, 3 exact, 4 regex, 5 never.
  match: number | null;
}

export interface LoginSecret extends LoginSummary {
  password: string | null;
}

interface BwItem {
  id: string;
  name: string;
  type: number;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null; match?: number | null }[] | null;
  } | null;
}

const ITEM_TYPE_LOGIN = 1;

export class BitwardenError extends Error {}

export class Bitwarden {
  private session: string | null;
  private readonly bin: string;
  private cache: { at: number; items: Promise<LoginSummary[]> } | null = null;
  lastSyncAt: number | null = null;

  constructor(bin: string, session: string | null = null) {
    this.bin = bin;
    this.session = session;
  }

  // Runs `bw` and returns stdout. Errors include stderr but never stdout,
  // because stdout can contain secrets.
  private run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      BW_NOINTERACTION: 'true',
    };
    if (this.session) env.BW_SESSION = this.session;
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n')[0];
          reject(new BitwardenError(`bw ${args[0]} failed: ${msg}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  get sessionKey(): string | null {
    return this.session;
  }

  async status(): Promise<'unauthenticated' | 'locked' | 'unlocked'> {
    const out = await this.run(['status']);
    return JSON.parse(out).status;
  }

  async unlock(masterPassword: string): Promise<void> {
    const session = await this.run(['unlock', '--passwordenv', 'BW_KEYCHAIN_MASTER', '--raw'], {
      BW_KEYCHAIN_MASTER: masterPassword,
    });
    this.session = session.trim();
  }

  async sync(): Promise<void> {
    await this.run(['sync']);
    this.lastSyncAt = Date.now();
    this.cache = null;
  }

  // All login items, cached for display (names, domains). Fills always read fresh.
  cachedLogins(maxAgeMs = 60_000): Promise<LoginSummary[]> {
    if (!this.cache || Date.now() - this.cache.at > maxAgeMs) {
      const items = this.listLogins();
      items.catch(() => {
        if (this.cache?.items === items) this.cache = null;
      });
      this.cache = { at: Date.now(), items };
    }
    return this.cache.items;
  }

  async listLogins(search?: string): Promise<LoginSummary[]> {
    const args = ['list', 'items'];
    if (search) args.push('--search', search);
    const items: BwItem[] = JSON.parse(await this.run(args));
    return items.filter((i) => i.type === ITEM_TYPE_LOGIN).map(summarize);
  }

  async getLogin(id: string): Promise<LoginSecret> {
    const item: BwItem = JSON.parse(await this.run(['get', 'item', id]));
    if (item.type !== ITEM_TYPE_LOGIN) throw new BitwardenError(`Item ${id} is not a login item`);
    return { ...summarize(item), password: item.login?.password ?? null };
  }

  async getTotp(id: string): Promise<string> {
    return (await this.run(['get', 'totp', id])).trim();
  }
}

function summarize(item: BwItem): LoginSummary {
  return {
    id: item.id,
    name: item.name,
    username: item.login?.username ?? null,
    uris: (item.login?.uris ?? [])
      .filter((u): u is { uri: string; match?: number | null } => typeof u.uri === 'string' && u.uri.length > 0)
      .map((u) => ({ uri: u.uri, match: u.match ?? null })),
    hasTotp: Boolean(item.login?.totp),
  };
}
