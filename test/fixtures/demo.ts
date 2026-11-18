// Seeds a demo store (fake vault, sample tokens and activity) and either
// screenshots every admin page at phone size, or serves the admin UI.
// Not part of `npm test`:
//   node test/fixtures/demo.ts <out-dir>              screenshots
//   node test/fixtures/demo.ts --serve <host>:<port>  admin UI, prints a password

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createAdminServer } from '../../src/admin/server.ts';
import { Bitwarden } from '../../src/bitwarden.ts';
import { Cleanup } from '../../src/cleanup.ts';
import { BrowserFiller } from '../../src/filler.ts';
import { Store } from '../../src/store.ts';

const serve = process.argv[2] === '--serve' ? process.argv[3] : null;
const out = process.argv[2] ?? '.';
const here = fileURLToPath(new URL('.', import.meta.url));
const itemsFile = join(mkdtempSync(join(tmpdir(), 'bwk-demo-')), 'items.json');
const login = (id: string, name: string, username: string, uri: string, totp = false) => ({
  id, name, type: 1, login: { username, password: 'x', totp: totp ? 'KEY' : null, uris: [{ uri }] },
});
writeFileSync(itemsFile, JSON.stringify([
  login('fak', 'Fakturoid', 'michal@example.com', 'https://app.fakturoid.cz', true),
  login('fakw', 'Fakturoid (work)', 'work@example.com', 'https://app.fakturoid.cz'),
  login('bank', 'mBank', '88120044', 'https://online.mbank.cz', true),
  login('gh', 'GitHub', 'michal-skoula', 'https://github.com', true),
]));
process.env.FAKE_BW_ITEMS = itemsFile;

const bitwarden = new Bitwarden(join(here, 'fake-bw.mjs'));
await bitwarden.unlock('master');
await bitwarden.sync();
const store = new Store(':memory:');
const adminPassword = serve ? randomBytes(9).toString('base64url') : 'demo-password-123';
await store.setAdminPassword('admin', adminPassword);
const H = 3600_000;
const now = Date.now();
const inv = store.createToken('routine-invoices', { all: false, items: [{ itemId: 'fak', totp: false }, { itemId: 'bank', totp: true }] }, null).token;
const sup = store.createToken('supervised', { all: true }, now + 6 * 24 * H).token;
const up = store.createToken('uptime-check', { all: false, items: [{ itemId: 'gh', totp: false }] }, now + 6 * 24 * H).token;
const old = store.createToken('old-test', { all: true }, null).token;
store.revokeToken(old.id);
store.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now - 2 * H, inv.id);
store.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now - 2 * 60_000, sup.id);
store.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now - 26 * H, up.id);
store.log({ token: inv, kind: 'fill_login', itemId: 'fak', itemName: 'Fakturoid', detail: 'page navigated' });
store.log({ token: inv, kind: 'denied', itemId: 'gh', itemName: 'GitHub', detail: 'Asked for an item outside its scope.', problem: true });
store.log({ token: inv, kind: 'fill_login', itemId: 'bank', itemName: 'mBank', detail: 'page navigated' });
store.log({ token: inv, kind: 'blocked', itemId: 'bank', itemName: 'mBank', detail: 'The bank wants a push approval on your phone.', problem: true });
store.log({ token: inv, kind: 'sign_out', itemId: 'fak', detail: 'app.fakturoid.cz: cookies and storage wiped' });
store.scheduleWipe('https://online.mbank.cz', inv.id, 'bank', now + 18 * 60_000);
store.scheduleWipe('https://app.fakturoid.cz', inv.id, 'fak', now);
store.markWiped('https://app.fakturoid.cz', 'sign_out');

const cleanup = new Cleanup({ store, filler: new BrowserFiller('http://127.0.0.1:1'), ttlMs: 30 * 60_000 });
const server = createAdminServer({ store, bitwarden, cleanup, mcpUrl: 'https://keychain.example/mcp', log: (l) => console.error(l) });
if (serve) {
  const [host, port] = serve.split(':');
  server.listen(Number(port), host, () => console.log(`Demo admin UI on http://${serve}/  username: admin  password: ${adminPassword}`));
  await new Promise(() => {});
}
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
for (const scheme of ['light', 'dark'] as const) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(base + '/login');
  if (scheme === 'light') await page.screenshot({ path: join(out, 'login.png') });
  await page.fill('#u', 'admin');
  await page.fill('#p', 'demo-password-123');
  await page.click('button[type=submit]');
  await page.waitForURL(base + '/');
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
  await shot('1-tokens');
  await page.goto(base + '/tokens/new');
  await page.fill('#name', 'routine-invoices');
  await page.check('input[name=item][value=fak]');
  await page.check('input[name=item][value=bank]');
  await page.check('input[name=totp][value=bank]');
  await shot('2-new');
  await page.click('button:has-text("Create token")');
  await page.waitForURL(/created/);
  await shot('3-created');
  await page.goto(`${base}/tokens/${inv.id}`);
  await shot('4-detail');
  await page.goto(base + '/activity');
  await shot('5-activity');
  await page.goto(base + '/vault');
  await shot('6-vault');
  await ctx.close();
}
await browser.close();
server.close();
console.log('done');
