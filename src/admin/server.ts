// Admin UI listener. Separate from /mcp: its own port, its own auth (a
// password and a session cookie). Agent tokens are never accepted here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Bitwarden, LoginSummary } from '../bitwarden.ts';
import type { Cleanup } from '../cleanup.ts';
import { parseDuration, SESSION_MAX_AGE_S, sha256, type Scope, type Store, type TokenRecord } from '../store.ts';
import { CSS, JS } from './assets.ts';
import {
  activityPage,
  createdPage,
  detailPage,
  loginPage,
  messagePage,
  pickerPage,
  tokensPage,
  vaultPage,
  type PickerState,
  type TokenView,
  type VaultState,
} from './views.ts';

export interface AdminDeps {
  store: Store;
  bitwarden: Bitwarden;
  cleanup: Cleanup;
  mcpUrl: string;
  log?: (line: string) => void;
  now?: () => number;
}

const COOKIE = 'kc_admin';
const FLASH_MS = 10 * 60_000;

export function createAdminServer(deps: AdminDeps): Server {
  const { store, bitwarden, cleanup } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  // A new or rotated secret, shown once on the next page load, then dropped.
  const flashes = new Map<string, { tokenId: number; secret: string; rotated: boolean; at: number }>();
  let failedLogins = 0;
  let vaultState: { at: number; state: Promise<VaultState> } | null = null;

  function vault(): Promise<VaultState> {
    if (!vaultState || now() - vaultState.at > 30_000) {
      const state = bitwarden
        .status()
        .then((status) => ({ unlocked: status === 'unlocked', status, lastSyncAt: bitwarden.lastSyncAt }))
        .catch((e: Error) => ({ unlocked: false, status: 'unreachable', lastSyncAt: bitwarden.lastSyncAt, error: e.message.split('\n')[0] }));
      vaultState = { at: now(), state };
    }
    return vaultState.state;
  }

  async function logins(): Promise<{ items: LoginSummary[]; error?: string }> {
    try {
      return { items: await bitwarden.cachedLogins() };
    } catch (e) {
      return { items: [], error: (e as Error).message.split('\n')[0] };
    }
  }

  function view(t: TokenRecord, items: LoginSummary[]): TokenView {
    const byId = new Map(items.map((i) => [i.id, i]));
    return { token: t, items: t.scope.all ? [] : t.scope.items.map((s) => ({ ...s, login: byId.get(s.itemId) ?? null })) };
  }

  return createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      log(`admin request failed: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendHtml(res, 500, messagePage('Error', 'Something went wrong. The service log has the details.'));
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://admin');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/assets/app.css') return sendAsset(res, 'text/css', CSS);
    if (method === 'GET' && path === '/assets/app.js') return sendAsset(res, 'text/javascript', JS);

    // Cross-site POSTs never get through, logged in or not.
    if (method === 'POST' && !sameOrigin(req)) {
      log(`admin: refused cross-site POST ${path} (origin ${req.headers.origin ?? '-'}, sec-fetch-site ${req.headers['sec-fetch-site'] ?? '-'})`);
      return sendText(res, 403, 'cross-site request refused');
    }

    if (path === '/login') {
      if (method === 'GET') return sendHtml(res, 200, loginPage({ setup: !store.hasAdmin() }));
      if (method === 'POST') return login(req, res);
    }

    const sessionId = cookie(req, COOKIE);
    const user = sessionId ? store.touchSession(sessionId) : null;
    if (!sessionId || !user) {
      if (method === 'GET') return redirect(res, '/login');
      return sendText(res, 401, 'log in first');
    }
    // Renewed on use: refresh the cookie's lifetime too.
    setSessionCookie(req, res, sessionId);
    const csrf = sha256(`csrf:${sessionId}`);

    let form: URLSearchParams | null = null;
    if (method === 'POST') {
      form = await readForm(req);
      if (form.get('csrf') !== csrf) {
        log(`admin: bad form token on POST ${path}`);
        return sendText(res, 403, 'bad form token, reload the page');
      }
    }

    const m = (re: RegExp) => re.exec(path);
    let match: RegExpExecArray | null;
    const t = now();

    if (method === 'GET' && path === '/') {
      const { items } = await logins();
      return sendHtml(res, 200, tokensPage({ tokens: store.listTokens().map((x) => view(x, items)), blocked: store.openBlocked(), vault: await vault(), now: t }));
    }

    if (method === 'GET' && path === '/tokens/new') {
      const { items, error } = await logins();
      const state: PickerState = { name: '', expires: 'never', access: 'selected', items: new Map() };
      return sendHtml(res, 200, pickerPage({ mode: 'create', state, vault: items, vaultError: error, csrf }));
    }

    if (method === 'POST' && path === '/tokens') {
      const { items, error } = await logins();
      const state = pickerState(form!);
      const problem = validate(state, true, items);
      if (problem) return sendHtml(res, 400, pickerPage({ mode: 'create', state: { ...state, error: problem }, vault: items, vaultError: error, csrf }));
      const ttl = parseDuration(state.expires);
      const { token, secret } = store.createToken(state.name, toScope(state), ttl === null ? null : t + ttl);
      log(`admin: created token ${token.name} (${token.scope.all ? 'all items' : `${state.items.size} items`})`);
      flashes.set(sessionId, { tokenId: token.id, secret, rotated: false, at: t });
      return redirect(res, `/tokens/${token.id}/created`);
    }

    if (method === 'GET' && (match = m(/^\/tokens\/(\d+)\/created$/))) {
      const flash = flashes.get(sessionId);
      flashes.delete(sessionId);
      const token = store.getToken(Number(match[1]));
      if (!token || !flash || flash.tokenId !== token.id || t - flash.at > FLASH_MS) return redirect(res, token ? `/tokens/${token.id}` : '/');
      res.setHeader('cache-control', 'no-store');
      return sendHtml(res, 200, createdPage({ token, secret: flash.secret, mcpUrl: deps.mcpUrl, rotated: flash.rotated }));
    }

    if ((match = m(/^\/tokens\/(\d+)(\/.*)?$/))) {
      const token = store.getToken(Number(match[1]));
      if (!token) return sendHtml(res, 404, messagePage('Not found', 'No such token.'));
      const sub = match[2] ?? '';
      const active = token.revokedAt === null && (token.expiresAt === null || token.expiresAt > t);

      if (method === 'GET' && sub === '') {
        const { items } = await logins();
        return sendHtml(
          res,
          200,
          detailPage({
            view: view(token, items),
            fills7d: store.fillCount(token.id, t - 7 * 86_400_000),
            wipes: store.wipesForToken(token.id),
            ttlMin: Math.round(cleanup.ttlMs / 60_000),
            csrf,
            now: t,
          }),
        );
      }

      if (sub === '/items' && active) {
        const { items, error } = await logins();
        if (method === 'GET') {
          const state: PickerState = {
            name: token.name,
            expires: 'never',
            access: token.scope.all ? 'all' : 'selected',
            items: new Map(token.scope.all ? [] : token.scope.items.map((i) => [i.itemId, { totp: i.totp }])),
          };
          return sendHtml(res, 200, pickerPage({ mode: 'edit', tokenId: token.id, tokenName: token.name, state, vault: items, vaultError: error, csrf }));
        }
        if (method === 'POST') {
          const state = { ...pickerState(form!), name: token.name };
          const problem = validate(state, false, items);
          if (problem)
            return sendHtml(res, 400, pickerPage({ mode: 'edit', tokenId: token.id, tokenName: token.name, state: { ...state, error: problem }, vault: items, vaultError: error, csrf }));
          store.setScope(token.id, toScope(state));
          log(`admin: changed items of ${token.name}`);
          return redirect(res, `/tokens/${token.id}`);
        }
      }

      if (method === 'POST' && sub === '/items/remove' && active) {
        store.removeItem(token.id, form!.get('item') ?? '');
        log(`admin: removed item ${form!.get('item')} from ${token.name}`);
        return redirect(res, `/tokens/${token.id}`);
      }

      if (method === 'POST' && sub === '/rotate' && token.revokedAt === null) {
        const secret = store.rotateToken(token.id);
        log(`admin: rotated ${token.name}`);
        flashes.set(sessionId, { tokenId: token.id, secret, rotated: true, at: t });
        return redirect(res, `/tokens/${token.id}/created`);
      }

      if (method === 'POST' && sub === '/revoke') {
        store.revokeToken(token.id);
        log(`admin: revoked ${token.name}`);
        return redirect(res, `/tokens/${token.id}`);
      }
    }

    if (method === 'POST' && path === '/wipes') {
      const origin = form!.get('origin') ?? '';
      if (store.getWipe(origin)) await cleanup.wipe(origin, 'admin');
      return redirect(res, safeBack(form!.get('back')));
    }

    if (method === 'GET' && path === '/activity') {
      const problems = url.searchParams.get('f') === 'problems';
      const tokenParam = url.searchParams.get('token');
      const tokenId = tokenParam && /^\d+$/.test(tokenParam) ? Number(tokenParam) : null;
      const events = store.activity({ problemsOnly: problems, tokenId: tokenId ?? undefined });
      const tokens = store.listTokens().filter((x) => x.revokedAt === null || x.id === tokenId);
      return sendHtml(res, 200, activityPage({ events, filter: { problems, tokenId }, tokens, csrf, now: t }));
    }

    if (method === 'POST' && (match = m(/^\/activity\/(\d+)\/resolve$/))) {
      store.resolve(Number(match[1]));
      return redirect(res, safeBack(form!.get('back')));
    }

    if (method === 'GET' && path === '/vault') {
      const { items } = await logins();
      const v = await vault();
      return sendHtml(
        res,
        200,
        vaultPage({
          vault: v,
          itemCount: v.unlocked ? items.length : null,
          noUri: v.unlocked ? items.filter((i) => i.uris.length === 0).length : null,
          ttlMin: Math.round(cleanup.ttlMs / 60_000),
          csrf,
          synced: url.searchParams.has('synced'),
        }),
      );
    }

    if (method === 'POST' && path === '/vault/sync') {
      try {
        await bitwarden.sync();
      } catch (e) {
        vaultState = { at: now(), state: Promise.resolve({ unlocked: false, status: 'sync failed', lastSyncAt: bitwarden.lastSyncAt, error: (e as Error).message }) };
        return redirect(res, '/vault');
      }
      vaultState = null;
      log('admin: vault synced');
      return redirect(res, '/vault?synced');
    }

    if (method === 'POST' && path === '/logout') {
      store.deleteSession(sessionId);
      flashes.delete(sessionId);
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return redirect(res, '/login');
    }

    return sendHtml(res, 404, messagePage('Not found', 'Nothing here.'));
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    const username = (form.get('username') ?? '').trim();
    const password = form.get('password') ?? '';
    // Each failure since the last success doubles the wait, up to 10 s.
    if (failedLogins > 0) await new Promise((r) => setTimeout(r, Math.min(10_000, 250 * 2 ** (failedLogins - 1))));
    if (!store.hasAdmin()) return sendHtml(res, 200, loginPage({ setup: true }));
    if (!(await store.checkAdmin(username, password))) {
      failedLogins++;
      log(`admin: failed login for ${JSON.stringify(username)} (${failedLogins} in a row)`);
      return sendHtml(res, 401, loginPage({ setup: false, username, error: 'Wrong username or password.' }));
    }
    failedLogins = 0;
    const id = store.createSession(username);
    setSessionCookie(req, res, id);
    log(`admin: ${username} logged in`);
    return redirect(res, '/');
  }
}

// --- form handling -----------------------------------------------------------------

function pickerState(form: URLSearchParams): PickerState {
  const totp = new Set(form.getAll('totp'));
  return {
    name: (form.get('name') ?? '').trim(),
    expires: form.get('expires') ?? 'never',
    access: form.get('access') === 'all' ? 'all' : 'selected',
    items: new Map(form.getAll('item').map((id) => [id, { totp: totp.has(id) }])),
  };
}

function validate(s: PickerState, needName: boolean, vault: LoginSummary[]): string | null {
  if (needName && !s.name) return 'Give the token a name.';
  if (s.name.length > 64) return 'Keep the name under 64 characters.';
  if (!['never', '7d', '30d', '90d'].includes(s.expires)) return 'Pick an expiry.';
  if (s.access === 'selected') {
    if (s.items.size === 0) return 'Pick at least one item, or choose All items.';
    // Only items the picker offered. With the vault unreachable, keep what was posted.
    if (vault.length) {
      const known = new Map(vault.map((i) => [i.id, i]));
      for (const [id, v] of s.items) {
        const item = known.get(id);
        if (!item) return 'One of the picked items is no longer in the vault. Reload and try again.';
        if (v.totp && !item.hasTotp) v.totp = false;
      }
    }
  }
  return null;
}

function toScope(s: PickerState): Scope {
  if (s.access === 'all') return { all: true };
  return { all: false, items: [...s.items].map(([itemId, v]) => ({ itemId, totp: v.totp })) };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256 * 1024) throw new Error('form too large');
  }
  return new URLSearchParams(body);
}

// --- http helpers --------------------------------------------------------------------

// Modern browsers say where a request came from. Anything not same-origin is refused.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, e.g. curl
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, id: string) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure}`);
}

function safeBack(back: string | null): string {
  return back && /^\/(?!\/)/.test(back) ? back : '/';
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // Not no-referrer: with that, browsers send "Origin: null" on our own form
  // posts, and over plain HTTP there's no Sec-Fetch-Site to fall back on.
  'referrer-policy': 'same-origin',
};

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(body);
}

function sendAsset(res: ServerResponse, type: string, body: string) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8`, 'cache-control': 'max-age=300' }).end(body);
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(303, { ...SECURITY_HEADERS, location: to }).end();
}
