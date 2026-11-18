// Admin UI over plain HTTP: login, the token screens, CSRF and cross-site refusal.
// No browser needed; the cleanup's filler is never reached.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from '../src/admin/server.ts';
import { Bitwarden } from '../src/bitwarden.ts';
import { Cleanup } from '../src/cleanup.ts';
import { BrowserFiller } from '../src/filler.ts';
import { Store } from '../src/store.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('admin UI', () => {
  let store: Store;
  let server: Server;
  let base: string;
  let cookie = '';

  before(async () => {
    const itemsFile = join(mkdtempSync(join(tmpdir(), 'bwk-admin-')), 'items.json');
    writeFileSync(
      itemsFile,
      JSON.stringify([
        { id: 'fak', name: 'Fakturoid', type: 1, login: { username: 'me@example.com', password: 'pw1', uris: [{ uri: 'https://app.fakturoid.cz' }] } },
        { id: 'bank', name: 'mBank <b>', type: 1, login: { username: '8812', password: 'pw2', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://online.mbank.cz' }] } },
        { id: 'nouri', name: 'No URI', type: 1, login: { username: 'x', password: 'pw3', uris: [] } },
      ]),
    );
    process.env.FAKE_BW_ITEMS = itemsFile;
    const bitwarden = new Bitwarden(join(here, 'fixtures', 'fake-bw.mjs'));
    await bitwarden.unlock('master');
    store = new Store(':memory:');
    await store.setAdminPassword('admin', 'correct horse battery');
    const cleanup = new Cleanup({ store, filler: new BrowserFiller('http://127.0.0.1:1'), ttlMs: 30 * 60_000 });
    server = createAdminServer({ store, bitwarden, cleanup, mcpUrl: 'https://keychain.test/mcp' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => {
    server?.close();
    store?.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', headers: { cookie, ...headers } });
  const post = (path: string, body: Record<string, string | string[]>, headers: Record<string, string> = {}) => {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) form.append(k, x);
    return fetch(base + path, { method: 'POST', redirect: 'manual', body: form, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  };
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1];

  test('sends you to the login page first', async () => {
    const r = await get('/');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/login');
  });

  test('refuses a wrong password', async () => {
    const r = await post('/login', { username: 'admin', password: 'nope' });
    assert.equal(r.status, 401);
    assert.match(await r.text(), /Wrong username or password/);
  });

  test('logs in with a long-lived, HttpOnly, SameSite=Strict cookie', async () => {
    const r = await post('/login', { username: 'admin', password: 'correct horse battery' });
    assert.equal(r.status, 303);
    const set = r.headers.get('set-cookie')!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Max-Age=2592000/);
    cookie = set.split(';')[0];
  });

  test('refuses cross-site posts even with a valid session', async () => {
    const r = await post('/tokens', { name: 'x', access: 'all' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    const r2 = await post('/tokens', { name: 'x', access: 'all' }, { origin: 'https://evil.example' });
    assert.equal(r2.status, 403);
  });

  test('accepts same-origin posts over plain HTTP, where browsers send Origin but no Sec-Fetch-Site', async () => {
    const page = await get('/vault');
    assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'no-referrer would make browsers send Origin: null');
    const r = await post('/vault/sync', { csrf: csrfOf(await page.text()) }, { origin: base });
    assert.equal(r.status, 303);
    const nul = await post('/vault/sync', { csrf: 'x' }, { origin: 'null' });
    assert.equal(nul.status, 403);
  });

  test('refuses posts without the form token', async () => {
    const r = await post('/tokens', { name: 'x', access: 'all' });
    assert.equal(r.status, 403);
  });

  test('the picker lists fillable items, escaped, and hides ones without a URI', async () => {
    const html = await (await get('/tokens/new')).text();
    assert.match(html, /Fakturoid/);
    assert.match(html, /mBank &lt;b&gt;/);
    assert.doesNotMatch(html, /mBank <b>/);
    assert.doesNotMatch(html, /No URI</);
    assert.match(html, /1 item without a saved URI is hidden/);
    assert.match(html, /fakturoid\.cz/);
  });

  test('selected access needs at least one item', async () => {
    const csrf = csrfOf(await (await get('/tokens/new')).text());
    const r = await post('/tokens', { csrf, name: 'empty', expires: 'never', access: 'selected' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Pick at least one item/);
  });

  let tokenId = 0;
  test('creates a scoped token and shows the secret exactly once', async () => {
    const csrf = csrfOf(await (await get('/tokens/new')).text());
    const r = await post('/tokens', { csrf, name: 'routine-invoices', expires: '7d', access: 'selected', item: ['fak', 'bank'], totp: ['bank', 'fak'] });
    assert.equal(r.status, 303);
    const created = r.headers.get('location')!;
    tokenId = Number(/\/tokens\/(\d+)\/created/.exec(created)![1]);

    const page = await (await get(created)).text();
    const secret = /id="secret">(kc_[A-Za-z0-9_-]{43})</.exec(page)![1];
    assert.match(page, /https:\/\/keychain\.test\/mcp/);
    assert.ok(store.authenticate(secret), 'the shown secret works');

    const again = await get(created);
    assert.equal(again.status, 303, 'second visit redirects instead of showing it again');

    const t = store.getToken(tokenId)!;
    assert.deepEqual(t.scope, {
      all: false,
      items: [
        { itemId: 'fak', totp: false }, // no key saved, so TOTP was dropped
        { itemId: 'bank', totp: true },
      ],
    });
    assert.ok(t.expiresAt! > Date.now() + 6 * 86_400_000);
  });

  test('the token list and detail show the token', async () => {
    const list = await (await get('/')).text();
    assert.match(list, /routine-invoices/);
    assert.match(list, /2 items/);
    assert.match(list, /\+ TOTP on 1/);
    assert.match(list, /expires in 7 days/);
    const detail = await (await get(`/tokens/${tokenId}`)).text();
    assert.match(detail, /Password \+ TOTP/);
    assert.match(detail, /Rotate \(new secret, same access\)/);
  });

  test('shows a Needs-you banner for blocked reports until dismissed', async () => {
    const t = store.getToken(tokenId)!;
    store.log({ token: t, kind: 'blocked', itemId: 'bank', itemName: 'mBank', detail: 'The bank wants a push approval.', problem: true });
    assert.match(await (await get('/')).text(), /Needs you.*routine-invoices stopped at mBank\. The bank wants a push approval\./s);
    const activity = await (await get('/activity?f=problems')).text();
    const id = /action="\/activity\/(\d+)\/resolve"/.exec(activity)![1];
    await post(`/activity/${id}/resolve`, { csrf: csrfOf(activity), back: '/activity' });
    assert.doesNotMatch(await (await get('/')).text(), /Needs you/);
  });

  test('removes an item, rotates and revokes', async () => {
    const detail = await (await get(`/tokens/${tokenId}`)).text();
    const csrf = csrfOf(detail);
    await post(`/tokens/${tokenId}/items/remove`, { csrf, item: 'fak' });
    assert.deepEqual(store.getToken(tokenId)!.scope, { all: false, items: [{ itemId: 'bank', totp: true }] });

    const before = store.getToken(tokenId)!.prefix;
    const rot = await post(`/tokens/${tokenId}/rotate`, { csrf });
    const page = await (await get(rot.headers.get('location')!)).text();
    assert.match(page, /has a new secret/);
    assert.notEqual(store.getToken(tokenId)!.prefix, before);

    await post(`/tokens/${tokenId}/revoke`, { csrf });
    assert.ok(store.getToken(tokenId)!.revokedAt);
    assert.match(await (await get('/')).text(), /Revoked/);
  });

  test('logout ends the session', async () => {
    const csrf = csrfOf(await (await get('/vault')).text());
    await post('/logout', { csrf });
    assert.equal((await get('/')).status, 303);
  });
});
