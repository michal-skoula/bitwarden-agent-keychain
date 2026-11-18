// End to end: real Chromium, real Playwright MCP, real MCP client, fake `bw`.
//
// Needs a Chromium for playwright-core: `npx playwright-core install chromium-headless-shell`.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bitwarden } from '../src/bitwarden.ts';
import { BrowserFiller } from '../src/filler.ts';
import { createKeychainHttpServer } from '../src/server.ts';
import { Cleanup } from '../src/cleanup.ts';
import { Store } from '../src/store.ts';
import { PASSWORD, startSite, USER } from './fixtures/site.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('keychain', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let chrome: Browser;
  let driver: Browser; // stands in for Playwright MCP's own connection
  let page: Page;
  let keychainHttp: ReturnType<typeof createKeychainHttpServer>;
  let agent: Client; // full-access token
  let routine: Client; // scoped to "site", no TOTP
  let playwrightMcp: Client;
  let store: Store;
  let cleanup: Cleanup;
  let mcpUrl: URL;
  let fullSecret: string;
  let routineSecret: string;
  const transcript: string[] = []; // everything an agent would see

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    transcript.push(text(r));
    return r;
  }

  before(async () => {
    site = await startSite();
    const base = `http://127.0.0.1:${site.port}`;

    const itemsFile = join(mkdtempSync(join(tmpdir(), 'bwk-')), 'items.json');
    writeFileSync(
      itemsFile,
      JSON.stringify([
        { id: 'site', name: 'Test site', type: 1, login: { username: USER, password: PASSWORD, totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: `${base}/`, match: null }] } },
        { id: 'other', name: 'Other site', type: 1, login: { username: 'x', password: 'other-secret-pw', uris: [{ uri: 'https://example.org' }] } },
        { id: 'note', name: 'A secure note', type: 2 },
      ]),
    );
    process.env.FAKE_BW_ITEMS = itemsFile;

    const cdpPort = await freePort();
    chrome = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
    const cdp = `http://127.0.0.1:${cdpPort}`;
    driver = await chromium.connectOverCDP(cdp);
    page = await driver.contexts()[0].newPage();

    const bitwarden = new Bitwarden(join(here, 'fixtures', 'fake-bw.mjs'));
    await bitwarden.unlock('master');
    store = new Store(':memory:');
    const filler = new BrowserFiller(cdp, 1500);
    cleanup = new Cleanup({ store, filler, ttlMs: 30 * 60_000 });
    fullSecret = store.createToken('supervised', { all: true }, null).secret;
    routineSecret = store.createToken('routine', { all: false, items: [{ itemId: 'site', totp: false }] }, null).secret;

    // DNS rebinding protection needs the exact Host header, which includes the random port.
    const kPort = await freePort();
    keychainHttp = createKeychainHttpServer({ bitwarden, filler, store, cleanup }, [`127.0.0.1:${kPort}`]);
    await new Promise<void>((r) => keychainHttp.listen(kPort, '127.0.0.1', () => r()));
    mcpUrl = new URL(`http://127.0.0.1:${kPort}/mcp`);

    const connect = async (secret: string) => {
      const c = new Client({ name: 'test-agent', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
      return c;
    };
    agent = await connect(fullSecret);
    routine = await connect(routineSecret);

    playwrightMcp = new Client({ name: 'test-agent', version: '1' });
    await playwrightMcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js'), '--cdp-endpoint', cdp],
        stderr: 'ignore',
      }),
    );
  });

  after(async () => {
    await agent?.close();
    await routine?.close();
    await playwrightMcp?.close();
    keychainHttp?.close();
    await chrome?.close();
    site?.server.close();
  });

  const url = (path: string) => `http://127.0.0.1:${site.port}${path}`;

  test('rejects requests without the token', async () => {
    const { port } = keychainHttp.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer kc_nope' } });
    assert.equal(wrong.status, 401);
  });

  test('list_logins returns logins without secrets', async () => {
    const r = await call(agent, 'list_logins');
    const rows = JSON.parse(text(r));
    assert.deepEqual(rows.map((x: { id: string }) => x.id), ['site', 'other']);
    assert.equal(rows[0].username, USER);
    assert.equal(rows[0].has_totp, true);
  });

  test('fills and submits a plain form with auto-detected fields', async () => {
    await page.goto(url('/login'));
    const r = await call(agent, 'fill_login', { item_id: 'site' });
    assert.ok(!r.isError, text(r));
    await page.waitForURL(url('/home'));
    assert.match(text(r), /Filled: username, password/);
  });

  test('handles username and password on separate pages', async () => {
    await page.goto(url('/two-step'));
    const first = await call(agent, 'fill_login', { item_id: 'site' });
    assert.match(text(first), /Only the username was filled/);
    await page.waitForURL(url('/two-step/password'));
    const second = await call(agent, 'fill_login', { item_id: 'site' });
    assert.ok(!second.isError, text(second));
    await page.waitForURL(url('/home'));
  });

  test('fills a TOTP code', async () => {
    await page.goto(url('/totp'));
    const r = await call(agent, 'fill_totp', { item_id: 'site' });
    assert.ok(!r.isError, text(r));
    await page.waitForURL(url('/home'));
  });

  test('uses agent-supplied selectors when detection cannot work', async () => {
    await page.goto(url('/odd'));
    const r = await call(agent, 'fill_login', {
      item_id: 'site',
      username_selector: 'role=textbox[name="Member number"]',
      password_selector: 'input[name=s]',
    });
    assert.ok(!r.isError, text(r));
    await page.waitForURL(url('/home'));
  });

  test('clears the password when the form stays on screen, so snapshots cannot read it', async () => {
    await page.goto(url('/spa-fail'));
    const r = await call(agent, 'fill_login', { item_id: 'site' });
    assert.match(text(r), /secret field was cleared/);
    assert.equal(await page.locator('input[name=p]').inputValue(), '');
    const snap = await call(playwrightMcp, 'browser_snapshot');
    assert.match(text(snap), /Wrong password/);
  });

  test('refuses to fill on a page whose origin does not match the item', async () => {
    // Same form, served from "localhost" instead of the saved 127.0.0.1.
    await page.goto(`http://localhost:${site.port}/login`);
    const r = await call(agent, 'fill_login', { item_id: 'site' });
    assert.equal(r.isError, true);
    assert.match(text(r), /No open tab matches/);
    assert.equal(await page.locator('input[name=pw]').inputValue(), '');
  });

  test('refuses items whose saved site is not open', async () => {
    await page.goto(url('/login'));
    const r = await call(agent, 'fill_login', { item_id: 'other' });
    assert.equal(r.isError, true);
  });

  test('a scoped token only sees and fills its own items', async () => {
    const rows = JSON.parse(text(await call(routine, 'list_logins')));
    assert.deepEqual(rows.map((x: { id: string }) => x.id), ['site']);
    assert.equal(rows[0].has_totp, false, 'TOTP not granted on this token');

    await page.goto(url('/login'));
    const ok = await call(routine, 'fill_login', { item_id: 'site' });
    assert.ok(!ok.isError, text(ok));
    await page.waitForURL(url('/home'));
  });

  test('out-of-scope items look exactly like unknown ones, and get logged', async () => {
    const denied = await call(routine, 'fill_login', { item_id: 'other' });
    const unknown = await call(routine, 'fill_login', { item_id: 'nope' });
    assert.equal(denied.isError, true);
    assert.equal(text(denied), 'No login item with id "other".');
    assert.equal(text(unknown), 'No login item with id "nope".');
    const log = store.activity({ tokenId: store.listTokens().find((t) => t.name === 'routine')!.id });
    assert.ok(log.some((e) => e.kind === 'denied' && e.itemId === 'other' && e.itemName === 'Other site'));
  });

  test('fill_totp needs TOTP granted on the token', async () => {
    await page.goto(url('/totp'));
    const r = await call(routine, 'fill_totp', { item_id: 'site' });
    assert.equal(r.isError, true);
    assert.match(text(r), /no authenticator code available/);
    assert.equal(await page.locator('input[name=otc]').inputValue(), '');
  });

  test('report_blocked writes a Needs-you entry', async () => {
    const r = await call(routine, 'report_blocked', { item_id: 'site', reason: 'The site wants a push approval.' });
    assert.ok(!r.isError);
    const open = store.openBlocked();
    assert.equal(open.length, 1);
    assert.equal(open[0].tokenName, 'routine');
    assert.equal(open[0].detail, 'The site wants a push approval.');
    store.resolve(open[0].id);
  });

  test('sign_out wipes cookies and localStorage of the filled site', async () => {
    await page.goto(url('/login'));
    assert.ok(!(await call(agent, 'fill_login', { item_id: 'site' })).isError);
    await page.waitForURL(url('/home'));
    await page.evaluate(() => {
      localStorage.setItem('auth', 'session-token');
      document.cookie = 'sid=abc; path=/';
    });
    const origin = new URL(url('/')).origin;
    assert.ok(store.pendingWipes().some((w) => w.origin === origin));

    const r = await call(agent, 'sign_out', { item_id: 'site' });
    assert.match(text(r), /Signed out. Wiped cookies and storage for 127\.0\.0\.1/);
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.getItem('auth')), null);
    assert.equal((await page.context().cookies(url('/'))).length, 0);
    assert.ok(!store.pendingWipes().some((w) => w.origin === origin));
    assert.match(text(await call(agent, 'sign_out', { item_id: 'site' })), /Nothing to wipe/);
  });

  test('the timer wipes sites once their time is up', async () => {
    await page.goto(url('/login'));
    await call(routine, 'fill_login', { item_id: 'site' });
    await page.waitForURL(url('/home'));
    await page.evaluate(() => localStorage.setItem('auth', 'x'));
    const origin = new URL(url('/')).origin;
    await cleanup.runDue();
    assert.ok(store.getWipe(origin)!.wipedAt === null, 'not due yet');
    store.db.prepare('UPDATE wipes SET wipe_at = 0').run();
    await cleanup.runDue();
    assert.equal(store.getWipe(origin)!.reason, 'timer');
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.getItem('auth')), null);
  });

  test('revoking a token cuts it off on the next request', async () => {
    const { token, secret } = store.createToken('temp', { all: true }, null);
    const res = (s: string) =>
      fetch(mcpUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${s}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    assert.equal((await res(secret)).status, 200);
    store.revokeToken(token.id);
    assert.equal((await res(secret)).status, 401);
  });

  test('nothing the agent saw contains a secret', async () => {
    await call(playwrightMcp, 'browser_snapshot');
    const all = transcript.join('\n');
    for (const secret of [PASSWORD, 'other-secret-pw', '482913']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  });
});
