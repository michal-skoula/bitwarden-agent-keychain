// Wipes the browser's copy of login sessions the keychain created.
//
// Every successful fill records two origins: the frame that got the secret
// and the page URL after submit (SSO logins often land on another host). Each
// gets a wipe time of last fill + TTL. Wipes also run on sign_out, on "Wipe
// now" in the admin UI, and for everything still pending at startup.

import type { BrowserFiller } from './filler.ts';
import type { Store, TokenRecord } from './store.ts';

export type WipeReason = 'timer' | 'sign_out' | 'admin' | 'startup';

export class Cleanup {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly store: Store;
  private readonly filler: BrowserFiller;
  readonly ttlMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: { store: Store; filler: BrowserFiller; ttlMs: number; log?: (line: string) => void; now?: () => number }) {
    this.store = opts.store;
    this.filler = opts.filler;
    this.ttlMs = opts.ttlMs;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  recordFill(token: TokenRecord, itemId: string, urls: string[]) {
    for (const origin of new Set(urls.map(originOf).filter((o): o is string => o !== null))) {
      this.store.scheduleWipe(origin, token.id, itemId, this.now() + this.ttlMs);
    }
  }

  // Wipes one origin. Returns false (and leaves it pending) if the browser can't be reached.
  async wipe(origin: string, reason: WipeReason, token?: TokenRecord | null): Promise<boolean> {
    const pending = this.store.getWipe(origin);
    try {
      await this.filler.wipeOrigin(origin);
    } catch (e) {
      this.log(`wipe ${origin} failed, will retry: ${(e as Error).message.split('\n')[0]}`);
      return false;
    }
    this.store.markWiped(origin, reason);
    const tokenRef = token ?? (pending?.tokenId != null ? this.store.getToken(pending.tokenId) : null);
    this.store.log({
      token: tokenRef,
      kind: reason === 'sign_out' ? 'sign_out' : 'wipe',
      itemId: pending?.itemId ?? null,
      detail: `${hostOf(origin)}: cookies and storage wiped${reason === 'sign_out' ? '' : ` (${REASON_TEXT[reason]})`}`,
    });
    this.log(`wiped ${origin} (${reason})`);
    return true;
  }

  // The agent's sign_out: wipes every pending origin recorded for this item.
  async signOut(token: TokenRecord, itemId: string): Promise<string[]> {
    const origins = this.store.pendingWipes().filter((w) => w.itemId === itemId).map((w) => w.origin);
    const done: string[] = [];
    for (const o of origins) if (await this.wipe(o, 'sign_out', token)) done.push(o);
    return done;
  }

  async runDue(reason: WipeReason = 'timer') {
    // One pass at a time; a slow browser shouldn't stack up overlapping passes.
    if (this.running) return this.running;
    this.running = (async () => {
      const now = this.now();
      for (const w of this.store.pendingWipes()) {
        if (reason === 'startup' || w.wipeAt <= now) await this.wipe(w.origin, reason);
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs = 30_000) {
    void this.runDue('startup');
    this.timer = setInterval(() => void this.runDue('timer'), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const REASON_TEXT: Record<Exclude<WipeReason, 'sign_out'>, string> = {
  timer: 'timer',
  admin: 'wiped from admin',
  startup: 'on startup',
};

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
