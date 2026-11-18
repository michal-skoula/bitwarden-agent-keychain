// Server-rendered pages for the admin UI. Layout and copy follow the phone
// mockup: Tokens, New token, Token created, Token detail, Activity, plus
// Login and Vault.

import type { LoginSummary } from '../bitwarden.ts';
import { hostOf } from '../cleanup.ts';
import { baseDomain } from '../origin.ts';
import type { ActivityRecord, TokenRecord, WipeRecord } from '../store.ts';
import { clock, clockSec, dayKey, dayLabel, expiryText, html, inText, usedText, type Html } from './html.ts';

// --- icons (stroke SVG, decorative) ------------------------------------------

const svg = (size: number, width: number, body: Html) =>
  html`<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  key: (s = 22) => svg(s, 1.8, html`<circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9"></path><path d="M17 6l3 3"></path><path d="M15 8l2 2"></path>`),
  plus: () => svg(18, 2.2, html`<path d="M12 5v14M5 12h14"></path>`),
  back: () => svg(22, 2, html`<path d="M15 5l-7 7 7 7"></path>`),
  pulse: () => svg(22, 1.8, html`<path d="M3 12h4l3-8 4 16 3-8h4"></path>`),
  lock: () => svg(22, 1.8, html`<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 018 0v3"></path>`),
  warn: () => html`<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-top: 1px; color: var(--warn)"><path d="M12 3l10 18H2z"></path><path d="M12 10v5M12 18v.5"></path></svg>`,
  search: () => svg(18, 2, html`<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path>`),
  check: () => svg(26, 2.4, html`<path d="M5 12l5 5 9-10"></path>`),
  copy: () => svg(18, 2, html`<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"></path>`),
  x: () => svg(18, 2, html`<path d="M6 6l12 12M18 6L6 18"></path>`),
};

// --- shared pieces -----------------------------------------------------------

export function page(title: string, body: Html): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${title} · Keychain</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<div class="app">${body}</div>
</body>
</html>`.value;
}

type Tab = 'tokens' | 'activity' | 'vault';

function tabs(current: Tab): Html {
  const tab = (id: Tab, href: string, label: string, icon: Html) =>
    html`<a href="${href}" ${current === id ? html`aria-current="page"` : ''}>${icon}${label}</a>`;
  return html`<nav class="tabs" aria-label="Sections">
${tab('tokens', '/', 'Tokens', ICON.key())}
${tab('activity', '/activity', 'Activity', ICON.pulse())}
${tab('vault', '/vault', 'Vault', ICON.lock())}
</nav>`;
}

function backBar(href: string, title: string): Html {
  return html`<header class="bar"><a class="icon-btn" href="${href}" aria-label="Back">${ICON.back()}</a><h1>${title}</h1></header>`;
}

// A POST button. Every admin form carries the CSRF token.
function postButton(
  action: string,
  csrf: string,
  label: string | Html,
  opts: { cls?: string; confirm?: string; fields?: Record<string, string>; ariaLabel?: string } = {},
): Html {
  return html`<form method="post" action="${action}" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
<input type="hidden" name="csrf" value="${csrf}">
${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<button type="submit" class="${opts.cls ?? 'btn'}" ${opts.ariaLabel ? html`aria-label="${opts.ariaLabel}"` : ''}>${label}</button>
</form>`;
}

function vaultPill(state: VaultState): Html {
  return state.unlocked
    ? html`<a class="pill" href="/vault"><span class="dot"></span>Vault connected</a>`
    : html`<a class="pill bad" href="/vault"><span class="dot"></span>Vault ${state.status}</a>`;
}

export function itemDomains(item: LoginSummary): string[] {
  const out = new Set<string>();
  for (const u of item.uris) {
    if (u.match === 4 || u.match === 5) continue; // regex / never: no clean domain to show
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u.uri) ? u.uri : `https://${u.uri}`);
      out.add(u.match === 1 || u.match === 2 || u.match === 3 ? url.hostname : baseDomain(url.hostname));
    } catch {
      /* unparsable URI */
    }
  }
  return [...out];
}

// --- view models ---------------------------------------------------------------

export interface VaultState {
  unlocked: boolean;
  status: string;
  lastSyncAt: number | null;
  error?: string;
}

export interface ScopedItem {
  itemId: string;
  totp: boolean;
  login: LoginSummary | null; // null: no longer in the vault
}

export interface TokenView {
  token: TokenRecord;
  items: ScopedItem[]; // empty for all-access tokens
}

const isActive = (t: TokenRecord, now: number) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);

// --- 1 · Tokens ------------------------------------------------------------------

export function tokensPage(v: { tokens: TokenView[]; blocked: ActivityRecord[]; vault: VaultState; now: number }): string {
  const active = v.tokens.filter((t) => isActive(t.token, v.now));
  const inactive = v.tokens.filter((t) => !isActive(t.token, v.now));

  const banner = v.blocked.length
    ? html`<a class="banner" href="/activity?f=problems">${ICON.warn()}<div><b>Needs you${v.blocked.length > 1 ? ` (${v.blocked.length})` : ''}</b>${blockedSentence(v.blocked[0])}</div></a>`
    : '';

  const card = ({ token: t, items }: TokenView) => {
    const domains = [...new Set(items.flatMap((i) => (i.login ? itemDomains(i.login) : [])))];
    const totps = items.filter((i) => i.totp).length;
    const shown = domains.slice(0, 4);
    return html`<a class="card" href="/tokens/${t.id}">
<div class="row"><div class="name">${t.name}</div>${
      t.scope.all
        ? html`<span class="badge all">All items</span>`
        : html`<span class="badge">${items.length} item${items.length === 1 ? '' : 's'}</span>`
    }</div>
${
  t.scope.all
    ? ''
    : html`<div class="chips">${shown.map((d) => html`<span class="chip">${d}</span>`)}${
        domains.length > shown.length ? html`<span class="chip">+${domains.length - shown.length} more</span>` : ''
      }${totps ? html`<span class="chip">+ TOTP on ${totps}</span>` : ''}</div>`
}
<div class="meta">${usedText(t.lastUsedAt, v.now)} · ${expiryText(t.expiresAt, v.now)}</div>
</a>`;
  };

  const offCard = ({ token: t }: TokenView) =>
    html`<a class="card off" href="/tokens/${t.id}"><div class="row"><div class="name">${t.name}</div><span class="meta" style="font-weight: 600">${
      t.revokedAt !== null ? 'Revoked' : 'Expired'
    }</span></div><div class="meta">${t.revokedAt !== null ? `Revoked ${dayLabel(t.revokedAt, v.now).replace('Today', 'today').replace('Yesterday', 'yesterday')}` : expiryText(t.expiresAt, v.now).replace(/^e/, 'E')}</div></a>`;

  return page(
    'Tokens',
    html`<header class="top">
<div class="row"><div class="brand">${ICON.key()}Keychain</div>${vaultPill(v.vault)}</div>
<div class="row"><h1>Tokens</h1><a class="btn primary round" href="/tokens/new">${ICON.plus()}New</a></div>
</header>
<main>
${banner}
${active.length === 0 ? html`<div class="empty">No active tokens. Create one for each routine, and a short-lived one for sessions you watch.</div>` : active.map(card)}
${inactive.map(offCard)}
</main>
${tabs('tokens')}`,
  );
}

function blockedSentence(a: ActivityRecord): string {
  return `${a.tokenName ?? 'An agent'} stopped at ${a.itemName ?? 'a login'}. ${a.detail}`;
}

// --- 2 · New token / edit items ------------------------------------------------------

export interface PickerState {
  name: string;
  expires: string; // never | 7d | 30d | 90d
  access: 'all' | 'selected';
  items: Map<string, { totp: boolean }>;
  error?: string;
}

const EXPIRY_CHOICES: [string, string][] = [
  ['never', 'Never'],
  ['7d', '7 d'],
  ['30d', '30 d'],
  ['90d', '90 d'],
];

export function pickerPage(v: {
  mode: 'create' | 'edit';
  tokenId?: number;
  tokenName?: string;
  state: PickerState;
  vault: LoginSummary[];
  vaultError?: string;
  csrf: string;
}): string {
  const s = v.state;
  const fillable = v.vault.filter((i) => i.uris.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const hiddenCount = v.vault.length - fillable.length;
  const action = v.mode === 'create' ? '/tokens' : `/tokens/${v.tokenId}/items`;

  const row = (i: LoginSummary) => {
    const picked = s.items.get(i.id);
    const domains = itemDomains(i);
    const search = [i.name, i.username ?? '', ...domains, ...i.uris.map((u) => u.uri)].join(' ').toLowerCase();
    const id = `it-${i.id}`;
    return html`<div class="item" data-item data-domains="${domains.join(' ')}" data-search="${search}">
<input type="checkbox" name="item" value="${i.id}" id="${id}" ${picked ? html`checked` : ''} aria-label="${i.name}${i.username ? `, ${i.username}` : ''}">
<label class="grow" for="${id}"><span class="title">${i.name}</span><span class="sub">${i.username ? html`${i.username} · ` : ''}<span class="mono">${domains.join(', ') || i.uris[0].uri}</span></span></label>
${
  i.hasTotp
    ? html`<label class="totp">TOTP<input type="checkbox" name="totp" value="${i.id}" ${picked?.totp ? html`checked` : ''} aria-label="Allow TOTP for ${i.name}"></label>`
    : html`<span class="totp none">no TOTP</span>`
}
</div>`;
  };

  const title = v.mode === 'create' ? 'New token' : `Items for ${v.tokenName}`;
  const back = v.mode === 'create' ? '/' : `/tokens/${v.tokenId}`;

  return page(
    title,
    html`${backBar(back, title)}
<form method="post" action="${action}" data-picker style="display: contents">
<input type="hidden" name="csrf" value="${v.csrf}">
<main class="gap" style="gap: 18px">
${s.error ? html`<div class="banner error" role="alert"><div><b>Can't save yet</b>${s.error}</div></div>` : ''}
${v.vaultError ? html`<div class="banner error" role="alert"><div><b>Vault unavailable</b>${v.vaultError}</div></div>` : ''}
${
  v.mode === 'create'
    ? html`<div class="field"><label class="label" for="name">Name</label><input id="name" name="name" type="text" required maxlength="64" autocomplete="off" spellcheck="false" placeholder="routine-invoices" value="${s.name}"></div>
<fieldset><legend>Expires</legend><div class="seg">${EXPIRY_CHOICES.map(
        ([val, label]) => html`<label><input type="radio" name="expires" value="${val}" ${s.expires === val ? html`checked` : ''}>${label}</label>`,
      )}</div></fieldset>`
    : ''
}
<fieldset>
<legend>Access</legend>
<label class="choice"><input type="radio" name="access" value="all" ${s.access === 'all' ? html`checked` : ''}><span><b>All items</b><span>For sessions you watch. Includes items you add later.</span></span></label>
<label class="choice"><input type="radio" name="access" value="selected" ${s.access === 'selected' ? html`checked` : ''}><span><b>Selected items</b><span>For routines. The agent can't see that other items exist.</span></span></label>
</fieldset>
<div class="field" data-items ${s.access === 'all' ? html`hidden` : ''}>
<label class="label" for="search">Items</label>
<div class="search">${ICON.search()}<input id="search" type="search" placeholder="Search name, username or domain" autocomplete="off"></div>
<div class="list">${fillable.map(row)}<div class="item" data-nomatch hidden><span class="sub">No items match.</span></div></div>
${fillable.length === 0 && !v.vaultError ? html`<div class="empty">The vault has no login items with a saved URI.</div>` : ''}
<div class="hint">${hiddenCount > 0 ? `${hiddenCount} item${hiddenCount === 1 ? '' : 's'} without a saved URI ${hiddenCount === 1 ? 'is' : 'are'} hidden. They can't be filled anyway.` : "Items without a saved URI are hidden. They can't be filled anyway."}</div>
</div>
</main>
<footer class="sticky-foot">
<div class="summary" data-summary aria-live="polite"></div>
<button type="submit" class="btn primary block">${v.mode === 'create' ? 'Create token' : 'Save items'}</button>
</footer>
</form>`,
  );
}

// --- 3 · Token created --------------------------------------------------------------

export function createdPage(v: { token: TokenRecord; secret: string; mcpUrl: string; rotated: boolean }): string {
  const json = `"keychain": {
  "type": "http",
  "url": "${v.mcpUrl}",
  "headers": {
    "Authorization":
      "Bearer \${KEYCHAIN_TOKEN}"
  }
}`;
  const cmd = `claude mcp add --scope local --transport http \\
  keychain ${v.mcpUrl} \\
  --header "Authorization: Bearer ${v.secret}"`;
  return page(
    'Token created',
    html`<main class="gap" style="padding-top: 48px">
<section style="gap: 10px">
<div class="success">${ICON.check()}</div>
<h1 style="font-size: 24px; letter-spacing: -0.01em">${v.token.name} ${v.rotated ? 'has a new secret' : 'is ready'}</h1>
<p class="lead">Copy the token now. The keychain only keeps a hash, so you won't see it again.${v.rotated ? ' The old secret stopped working.' : ''}</p>
</section>
<div class="card" style="gap: 8px; padding: 14px; border-radius: 12px">
<div class="caps">Token</div>
<div class="secret" id="secret">${v.secret}</div>
<button type="button" class="btn primary" data-copy="secret">${ICON.copy()}<span>Copy token</span></button>
</div>
<section>
<div class="label">Add it to the routine's project</div>
<div class="meta">Run this in the project folder. Local scope keeps it out of git.</div>
<pre id="cmd">${cmd}</pre>
<button type="button" class="btn" data-copy="cmd" style="align-self: flex-start"><span>Copy command</span></button>
</section>
<section>
<div class="label">Or put it in the secrets as KEYCHAIN_TOKEN</div>
<div class="meta">Every agent uses the same MCP entry. Only the secret differs.</div>
<pre id="cfg">${json}</pre>
<button type="button" class="btn" data-copy="cfg" style="align-self: flex-start"><span>Copy config</span></button>
</section>
</main>
<footer class="foot"><a class="btn block" href="/tokens/${v.token.id}">Done, I copied it</a></footer>`,
  );
}

// --- 4 · Token detail -------------------------------------------------------------------

export function detailPage(v: { view: TokenView; fills7d: number; wipes: WipeRecord[]; ttlMin: number; csrf: string; now: number }): string {
  const t = v.view.token;
  const active = isActive(t, v.now);
  const lastUsed = t.lastUsedAt === null ? 'Never' : dayKey(t.lastUsedAt) === dayKey(v.now) ? clock(t.lastUsedAt) : dayLabel(t.lastUsedAt, v.now);
  const expires = t.revokedAt !== null ? 'Revoked' : t.expiresAt === null ? 'Never' : t.expiresAt <= v.now ? 'Expired' : dayLabel(t.expiresAt, v.now);

  const itemRow = (i: ScopedItem) => {
    const name = i.login?.name ?? 'Deleted from vault';
    const domains = i.login ? itemDomains(i.login) : [];
    return html`<div class="item tight">
<div class="grow"><span class="title">${name}</span><span class="sub">${i.totp ? 'Password + TOTP' : 'Password'}${domains.length ? html` · <span class="mono">${domains.join(', ')}</span>` : html` · <span class="mono">${i.itemId}</span>`}</span></div>
${active ? postButton(`/tokens/${t.id}/items/remove`, v.csrf, ICON.x(), { cls: 'icon-btn', fields: { item: i.itemId }, confirm: `Remove ${name} from ${t.name}?`, ariaLabel: `Remove ${name}` }) : ''}
</div>`;
  };

  const wipeRow = (w: WipeRecord) =>
    w.wipedAt === null
      ? html`<div class="item tight">
<div class="grow"><span class="title mono" style="font-size: 13px; font-weight: 500">${hostOf(w.origin)}</span><span class="sub warn-text">Wipes in ${inText(w.wipeAt, v.now)}</span></div>
${postButton('/wipes', v.csrf, 'Wipe now', { fields: { origin: w.origin, back: `/tokens/${t.id}` } })}
</div>`
      : html`<div class="item">
<div class="grow"><span class="title mono" style="font-size: 13px; font-weight: 500; color: var(--muted)">${hostOf(w.origin)}</span><span class="sub">${WIPED_TEXT[w.reason ?? 'timer'] ?? 'Wiped'} at ${clock(w.wipedAt)}</span></div>
</div>`;

  return page(
    t.name,
    html`${backBar('/', t.name)}
<main class="gap" style="padding-top: 4px" ${v.wipes.some((w) => w.wipedAt === null) ? html`data-refresh` : ''}>
<div class="stats">
<div class="stat"><span>Last used</span><b>${lastUsed}</b></div>
<div class="stat"><span>Fills, 7 d</span><b>${v.fills7d}</b></div>
<div class="stat"><span>Expires</span><b>${expires}</b></div>
</div>

<section>
<div class="head-row"><h2>Items</h2>${active ? html`<a href="/tokens/${t.id}/items">${t.scope.all ? 'Change' : '+ Add items'}</a>` : ''}</div>
${
  t.scope.all
    ? html`<div class="card" style="gap: 4px; padding: 14px; border-radius: 12px"><div style="font-weight: 600">All items</div><div class="meta">Every login in the vault, including ones added later. TOTP included.</div></div>`
    : v.view.items.length
      ? html`<div class="list">${v.view.items.map(itemRow)}</div>`
      : html`<div class="empty">No items. This token can't fill anything.</div>`
}
</section>

<section>
<h2>Signed-in sites</h2>
<div class="meta">The keychain wipes a site's cookies and storage ${v.ttlMin} minutes after the last fill there, whether or not the agent signs out.</div>
${v.wipes.length ? html`<div class="list">${v.wipes.map(wipeRow)}</div>` : html`<div class="empty">Nothing to wipe right now.</div>`}
</section>

<section>
<div class="head-row"><h2>Token</h2><span class="mono" style="color: var(--muted)">${t.prefix}…</span></div>
${
  t.revokedAt === null
    ? html`<div class="menu">
${postButton(`/tokens/${t.id}/rotate`, v.csrf, 'Rotate (new secret, same access)', { cls: '', confirm: `Rotate ${t.name}? The current secret stops working right away.` })}
${postButton(`/tokens/${t.id}/revoke`, v.csrf, 'Revoke token', { cls: 'danger', confirm: `Revoke ${t.name}? Agents using it lose access on their next request.` })}
</div>`
    : html`<div class="meta">Revoked ${dayLabel(t.revokedAt, v.now).toLowerCase()} at ${clock(t.revokedAt)}.</div>`
}
<a href="/activity?token=${t.id}" style="font-size: 14px; font-weight: 600; min-height: 44px; display: flex; align-items: center">See activity for ${t.name}</a>
</section>
</main>`,
  );
}

const WIPED_TEXT: Record<string, string> = {
  sign_out: 'Agent signed out',
  timer: 'Wiped on timer',
  admin: 'Wiped by you',
  startup: 'Wiped on startup',
};

// --- 5 · Activity ------------------------------------------------------------------------

export function activityPage(v: {
  events: ActivityRecord[];
  filter: { problems: boolean; tokenId: number | null };
  tokens: TokenRecord[];
  csrf: string;
  now: number;
}): string {
  const chip = (href: string, label: string, current: boolean) => html`<a href="${href}" ${current ? html`aria-current="page"` : ''}>${label}</a>`;
  const filters = html`<div class="filters">
${chip('/activity', 'All', !v.filter.problems && v.filter.tokenId === null)}
${chip('/activity?f=problems', 'Problems', v.filter.problems)}
${v.tokens.map((t) => chip(`/activity?token=${t.id}`, t.name, v.filter.tokenId === t.id))}
</div>`;

  const groups: { label: string; events: ActivityRecord[] }[] = [];
  for (const e of v.events) {
    const label = dayLabel(e.at, v.now);
    if (groups.at(-1)?.label !== label) groups.push({ label, events: [] });
    groups.at(-1)!.events.push(e);
  }

  const event = (e: ActivityRecord) => {
    const { title, mark } = describeEvent(e);
    const open = e.kind === 'blocked' && e.resolvedAt === null;
    return html`<div class="event ${open ? 'problem' : ''}">
<span class="mark ${mark}" aria-hidden="true"></span>
<div class="grow">
<div class="line"><b>${title}</b><time datetime="${new Date(e.at).toISOString()}">${clockSec(e.at)}</time></div>
<div class="body">${eventBody(e)}</div>
${open ? postButton(`/activity/${e.id}/resolve`, v.csrf, 'Dismiss', { fields: { back: currentUrl(v.filter) } }) : ''}
</div>
</div>`;
  };

  return page(
    'Activity',
    html`<header class="top" style="gap: 12px"><h1>Activity</h1>${filters}</header>
<main style="gap: 14px">
${
  groups.length === 0
    ? html`<div class="empty">${v.filter.problems ? 'No problems.' : 'Nothing yet. Fills, denials and wipes show up here.'}</div>`
    : groups.map((g) => html`<div class="caps">${g.label}</div><div class="list">${g.events.map(event)}</div>`)
}
${v.events.length >= 200 ? html`<div class="hint">Showing the latest 200.</div>` : ''}
</main>
${tabs('activity')}`,
  );
}

function currentUrl(f: { problems: boolean; tokenId: number | null }) {
  if (f.problems) return '/activity?f=problems';
  if (f.tokenId !== null) return `/activity?token=${f.tokenId}`;
  return '/activity';
}

function describeEvent(e: ActivityRecord): { title: string; mark: string } {
  const what = e.itemName ?? e.itemId ?? '';
  const host = e.detail.split(': ')[0];
  switch (e.kind) {
    case 'fill_login':
    case 'fill_totp':
      return { title: `${e.kind} · ${what}`, mark: e.problem ? 'warn' : '' };
    case 'fill_failed':
      return { title: `Fill failed · ${what}`, mark: 'warn' };
    case 'denied':
      return { title: `Denied · ${what || 'unknown item'}`, mark: 'bad' };
    case 'blocked':
      return { title: `Needs you · ${what}`, mark: e.resolvedAt === null ? 'warn' : 'hollow' };
    case 'sign_out':
      return { title: `sign_out · ${host}`, mark: 'hollow' };
    case 'wipe':
      return { title: `Wiped · ${host}`, mark: 'hollow' };
  }
}

function eventBody(e: ActivityRecord): string {
  const who = e.tokenName ?? 'keychain';
  if (e.kind === 'sign_out' || e.kind === 'wipe') return `${who} · ${e.detail.split(': ').slice(1).join(': ')}`;
  if (e.kind === 'blocked') return `${who}. ${e.detail}${e.resolvedAt !== null ? ' (dismissed)' : ''}`;
  return `${who} · ${e.detail}`;
}

// --- Vault ----------------------------------------------------------------------------

export function vaultPage(v: { vault: VaultState; itemCount: number | null; noUri: number | null; ttlMin: number; csrf: string; synced?: boolean }): string {
  const kv = (k: string, val: string | Html) => html`<div class="item"><span class="k">${k}</span><span class="v">${val}</span></div>`;
  return page(
    'Vault',
    html`<header class="top"><div class="row"><h1>Vault</h1>${vaultPill(v.vault)}</div></header>
<main class="gap">
${v.vault.error ? html`<div class="banner error" role="alert"><div><b>Vault problem</b>${v.vault.error}</div></div>` : ''}
${v.synced ? html`<div class="banner" role="status" style="background: var(--ok-soft); border-color: var(--ok-line)"><div><b style="color: var(--ok)">Synced</b>The keychain now sees the latest vault.</div></div>` : ''}
<div class="list kv">
${kv('Status', v.vault.unlocked ? 'Unlocked' : v.vault.status)}
${kv('Last sync', v.vault.lastSyncAt === null ? 'Not yet' : `${dayLabel(v.vault.lastSyncAt)} ${clock(v.vault.lastSyncAt)}`)}
${kv('Login items', v.itemCount === null ? '…' : String(v.itemCount))}
${kv('Without a saved URI', v.noUri === null ? '…' : String(v.noUri))}
${kv('Wipe after last fill', `${v.ttlMin} min`)}
</div>
${postButton('/vault/sync', v.csrf, 'Sync now', { cls: 'btn primary block' })}
<div class="meta">The vault unlocks when the service starts, using the session key saved at setup. If it shows as locked, someone ran <span class="mono">bw lock</span> or <span class="mono">bw logout</span>. Rerun the setup step, then restart the service.</div>
<section style="margin-top: 12px">
<h2>Admin</h2>
${postButton('/logout', v.csrf, 'Log out of the admin', { cls: 'btn block' })}
</section>
</main>
${tabs('vault')}`,
  );
}

// --- Login -------------------------------------------------------------------------------

export function loginPage(v: { error?: string; username?: string; setup: boolean }): string {
  return page(
    'Log in',
    html`<main class="login">
<div class="brand" style="font-size: 17px">${ICON.key(26)}Keychain</div>
<h1>Log in</h1>
${
  v.setup
    ? html`<p class="lead">No admin password is set. On the server, run <span class="mono">keychain admin set-password</span> as the service user.</p>`
    : html`<form method="post" action="/login">
${v.error ? html`<div class="err" role="alert">${v.error}</div>` : ''}
<div class="field"><label class="label" for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${v.username ?? ''}"></div>
<div class="field"><label class="label" for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
<button type="submit" class="btn primary block">Log in</button>
</form>`
}
</main>`,
  );
}

export function messagePage(title: string, text: string, back = '/'): string {
  return page(title, html`${backBar(back, title)}<main><div class="empty">${text}</div></main>`);
}
