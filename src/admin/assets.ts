// Stylesheet and the little bit of JS for the admin UI. Served from the admin
// listener itself, so the pages load nothing from elsewhere.

export const CSS = String.raw`
:root {
  --bg: #F4F4F1; --surface: #FFFFFF; --ink: #18181B; --ink-2: #3F3F46; --muted: #5C5C63;
  --line: #E2E2DC; --line-2: #EDEDE8; --field: #CFCFC8; --chip: #F0F0EC; --seg: #E8E8E3;
  --accent: #1F4FD1; --accent-hover: #163A9C; --accent-soft: #E8EEFC;
  --ok: #17703A; --ok-soft: #EAF6EE; --ok-line: #C9E3D2;
  --warn: #9A4A06; --warn-ink: #7A3A05; --warn-soft: #FDF1E4; --warn-line: #F2D3AE;
  --bad: #B42318; --bad-soft: #FDECEA; --bad-line: #F4C7C3;
  --code-bg: #1C1C1F; --code-ink: #E8E8E3;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111113; --surface: #1B1B1E; --ink: #F2F2EF; --ink-2: #CFCFCA; --muted: #A1A1A8;
    --line: #2C2C31; --line-2: #26262A; --field: #3A3A40; --chip: #26262A; --seg: #26262A;
    --accent: #6E92F5; --accent-hover: #9AB3F8; --accent-soft: #1E2A4D;
    --ok: #5CC489; --ok-soft: #14291D; --ok-line: #24492F;
    --warn: #F0A35E; --warn-ink: #F5BC85; --warn-soft: #2D1F10; --warn-line: #4D3417;
    --bad: #F3877C; --bad-soft: #2E1614; --bad-line: #57261F;
    --code-bg: #0A0A0B; --code-ink: #E8E8E3;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 400 15px/1.4 Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
a { color: var(--accent); }
a:hover { color: var(--accent-hover); }
.mono { font-family: var(--mono); font-size: 12px; }
.app { max-width: 560px; margin: 0 auto; min-height: 100dvh; display: flex; flex-direction: column; }
.top { padding: 20px 16px 8px; display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
h2 { margin: 0; font-size: 15px; font-weight: 700; }
.bar { display: flex; align-items: center; gap: 4px; padding: 14px 8px 6px; }
.bar h1 { font-size: 20px; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; color: var(--ink); flex: none;
  border: 0; background: transparent; border-radius: 10px; cursor: pointer; }
.icon-btn:hover { background: var(--seg); color: var(--ink); }
main { flex: 1; padding: 8px 16px 24px; display: flex; flex-direction: column; gap: 10px; }
main.gap { gap: 20px; }
section { display: flex; flex-direction: column; gap: 8px; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 18px;
  border: 1px solid var(--ok-line); background: var(--ok-soft); color: var(--ok); font-weight: 500; font-size: 13px; text-decoration: none; }
.pill:hover { color: var(--ok); }
.pill .dot { width: 8px; height: 8px; border-radius: 4px; background: currentColor; }
.pill.bad { border-color: var(--bad-line); background: var(--bad-soft); color: var(--bad); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 44px; padding: 0 16px;
  border-radius: 10px; border: 1px solid var(--field); background: var(--surface); color: var(--ink);
  font-weight: 600; font-size: 14px; font-family: inherit; text-decoration: none; cursor: pointer; }
.btn:hover { color: var(--ink); border-color: var(--muted); }
.btn.primary { border: 0; background: var(--accent); color: #FFFFFF; }
.btn.primary:hover { background: var(--accent-hover); color: #FFFFFF; }
@media (prefers-color-scheme: dark) { .btn.primary, .btn.primary:hover { color: #0B1430; } }
.btn.round { border-radius: 22px; font-size: 15px; }
.btn.block { display: flex; width: 100%; height: 50px; border-radius: 12px; font-size: 16px; }
.banner { display: flex; gap: 12px; padding: 14px; border-radius: 14px; background: var(--warn-soft);
  border: 1px solid var(--warn-line); color: var(--ink); text-decoration: none; }
.banner:hover { color: var(--ink); }
.banner b { display: block; font-weight: 600; font-size: 14px; color: var(--warn-ink); margin-bottom: 3px; }
.banner div { font-size: 14px; }
.banner.error { background: var(--bad-soft); border-color: var(--bad-line); }
.banner.error b { color: var(--bad); }
.card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 14px; background: var(--surface);
  border: 1px solid var(--line); color: var(--ink); text-decoration: none; }
a.card:hover { color: var(--ink); border-color: var(--field); }
.card .name { font-weight: 600; font-size: 16px; overflow-wrap: anywhere; }
.card.off { background: transparent; border: 1px dashed var(--field); color: var(--muted); gap: 6px; }
.card.off .name { color: var(--muted); }
.badge { flex: none; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); }
.badge.all { background: var(--warn-soft); color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--chip); color: var(--ink-2); }
.meta { font-size: 13px; color: var(--muted); }
.empty { padding: 28px 16px; text-align: center; color: var(--muted); font-size: 14px; border: 1px dashed var(--field); border-radius: 14px; }
nav.tabs { position: sticky; bottom: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid var(--line); background: var(--surface); padding: 6px 8px calc(10px + env(safe-area-inset-bottom)); }
nav.tabs a { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px; color: var(--muted);
  text-decoration: none; font-size: 12px; font-weight: 500; border-radius: 10px; }
nav.tabs a[aria-current=page] { color: var(--accent); font-weight: 600; }
.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: 13px; font-weight: 600; color: var(--ink-2); }
input[type=text], input[type=password], input[type=search] {
  width: 100%; height: 46px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--field);
  background: var(--surface); color: var(--ink); font-weight: 500; font-size: 16px; font-family: inherit; }
input:focus-visible, .btn:focus-visible, a:focus-visible, button:focus-visible, .seg label:has(input:focus-visible) {
  outline: 2px solid var(--accent); outline-offset: 2px; }
.seg { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 4px; border-radius: 12px; background: var(--seg); }
.seg label { position: relative; display: flex; align-items: center; justify-content: center; height: 38px; border-radius: 9px;
  font-weight: 500; font-size: 14px; color: var(--ink-2); cursor: pointer; }
.seg input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.seg label:has(input:checked) { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }
fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 8px; }
legend { font-size: 13px; font-weight: 600; color: var(--ink-2); padding: 0; margin-bottom: 6px; }
.choice { display: flex; gap: 12px; padding: 14px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); cursor: pointer; }
.choice:has(input:checked) { border: 2px solid var(--accent); padding: 13px; }
.choice input { width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--accent); flex: none; }
.choice b { display: block; font-weight: 600; font-size: 15px; margin-bottom: 2px; }
.choice span span { font-size: 13px; color: var(--muted); }
.search { position: relative; }
.search svg { position: absolute; left: 13px; top: 14px; color: var(--muted); }
.search input { padding-left: 40px; font-weight: 400; }
.list { display: flex; flex-direction: column; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); overflow: hidden; }
.list > * + * { border-top: 1px solid var(--line-2); }
.item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; min-height: 64px; }
.item.tight { padding: 10px 8px 10px 14px; }
.item .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.item .title { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .sub { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item > input[type=checkbox] { width: 22px; height: 22px; margin: 0; accent-color: var(--accent); flex: none; }
.totp { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--ink-2); flex: none; min-height: 44px; cursor: pointer; }
.totp input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.totp.none { font-weight: 400; color: var(--muted); cursor: default; }
.hint { font-size: 12px; color: var(--muted); }
.sticky-foot { position: sticky; bottom: 0; padding: 12px 16px calc(14px + env(safe-area-inset-bottom)); background: var(--surface);
  border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
.sticky-foot .summary { font-size: 13px; color: var(--ink-2); }
.foot { padding: 12px 16px calc(26px + env(safe-area-inset-bottom)); }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.stat { padding: 12px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 12px; color: var(--muted); }
.stat b { font-size: 14px; font-weight: 600; }
.head-row { display: flex; align-items: center; justify-content: space-between; min-height: 44px; }
.head-row a { font-size: 14px; font-weight: 600; text-decoration: none; display: flex; align-items: center; min-height: 44px; }
.warn-text { color: var(--warn); font-weight: 500; }
.menu { display: flex; flex-direction: column; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); overflow: hidden; }
.menu form + form { border-top: 1px solid var(--line-2); }
.menu button { width: 100%; height: 50px; padding: 0 14px; border: 0; background: transparent; text-align: left;
  font-weight: 500; font-size: 15px; font-family: inherit; color: var(--ink); cursor: pointer; }
.menu button:hover { background: var(--bg); }
.menu button.danger { color: var(--bad); font-weight: 600; }
.success { width: 48px; height: 48px; border-radius: 24px; background: var(--ok-soft); color: var(--ok); display: flex; align-items: center; justify-content: center; }
.lead { margin: 0; font-size: 15px; color: var(--ink-2); }
.secret { font-family: var(--mono); font-size: 14px; line-height: 1.5; word-break: break-all; user-select: all; }
.caps { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
pre { margin: 0; padding: 14px; border-radius: 12px; background: var(--code-bg); color: var(--code-ink); font-family: var(--mono);
  font-size: 12px; line-height: 1.55; overflow-x: auto; white-space: pre; user-select: all; }
.filters { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
.filters a { flex: none; display: inline-flex; align-items: center; height: 36px; padding: 0 14px; border-radius: 18px;
  border: 1px solid var(--field); background: var(--surface); color: var(--ink); font-weight: 500; font-size: 13px; text-decoration: none; }
.filters a[aria-current=page] { border-color: var(--ink); background: var(--ink); color: var(--bg); font-weight: 600; }
.event { display: flex; gap: 12px; padding: 12px 14px; }
.event.problem { background: var(--warn-soft); }
.event .mark { flex: none; width: 10px; height: 10px; margin-top: 5px; border-radius: 5px; background: var(--ok); }
.event .mark.hollow { background: transparent; border: 2px solid var(--muted); }
.event .mark.bad { background: var(--bad); border-radius: 2px; }
.event .mark.warn { background: var(--warn); }
.event .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.event .line { display: flex; justify-content: space-between; gap: 8px; }
.event .line b { font-weight: 600; overflow-wrap: anywhere; }
.event .line time { color: var(--muted); font-family: var(--mono); font-size: 12px; flex: none; }
.event .body { color: var(--ink-2); overflow-wrap: anywhere; }
.event form { margin-top: 6px; }
.event .btn { height: 36px; font-size: 13px; padding: 0 12px; }
.login { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 18px; padding: 24px 16px 64px; }
.login form { display: flex; flex-direction: column; gap: 16px; }
.err { font-size: 14px; color: var(--bad); }
.kv { display: flex; flex-direction: column; }
.kv .item { min-height: 52px; }
.kv .k { flex: 1; font-size: 14px; color: var(--muted); }
.kv .v { font-size: 14px; font-weight: 600; text-align: right; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[hidden] { display: none !important; }
`;

export const JS = String.raw`
(() => {
  // Confirm before destructive actions.
  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (e) => { if (!confirm(form.dataset.confirm)) e.preventDefault(); });
  }

  // Copy buttons.
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = document.getElementById(btn.dataset.copy).textContent;
      const label = btn.querySelector('span') || btn;
      const before = label.textContent;
      try {
        await navigator.clipboard.writeText(text);
        label.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(btn.dataset.copy));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        label.textContent = 'Selected, press copy';
      }
      setTimeout(() => { label.textContent = before; }, 2000);
    });
  }

  // Item picker: search, all/selected toggle, live summary.
  const picker = document.querySelector('[data-picker]');
  if (picker) {
    const rows = [...picker.querySelectorAll('[data-item]')];
    const search = picker.querySelector('input[type=search]');
    const itemsBox = picker.querySelector('[data-items]');
    const summary = document.querySelector('[data-summary]');
    const noMatch = picker.querySelector('[data-nomatch]');
    const access = () => picker.querySelector('input[name=access]:checked')?.value;

    const update = () => {
      const all = access() === 'all';
      itemsBox.hidden = all;
      for (const row of rows) {
        const cb = row.querySelector('input[name=item]');
        const totp = row.querySelector('input[name=totp]');
        if (totp) { totp.disabled = !cb.checked; if (!cb.checked) totp.checked = false; }
      }
      if (!summary) return;
      if (all) { summary.innerHTML = '<strong>All items</strong> · every login in the vault, including ones added later'; return; }
      const picked = rows.filter((r) => r.querySelector('input[name=item]').checked);
      const domains = [...new Set(picked.flatMap((r) => r.dataset.domains.split(' ').filter(Boolean)))];
      const totps = picked.filter((r) => r.querySelector('input[name=totp]')?.checked).length;
      if (picked.length === 0) { summary.textContent = 'No items picked yet.'; return; }
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      summary.innerHTML = '<strong>' + picked.length + ' item' + (picked.length === 1 ? '' : 's') + '</strong>' +
        (domains.length ? ' · can fill on ' + domains.map((d) => '<span class="mono">' + esc(d) + '</span>').join(', ') : '') +
        (totps ? ' · TOTP on ' + totps : '');
    };

    const filter = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const hit = !q || row.dataset.search.includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      }
      if (noMatch) noMatch.hidden = shown > 0;
    };

    picker.addEventListener('change', update);
    search?.addEventListener('input', filter);
    update();
    filter();
  }

  // Wipe countdowns refresh themselves once a minute.
  if (document.querySelector('[data-refresh]')) setTimeout(() => location.reload(), 60_000);
})();
`;
