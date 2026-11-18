// A tiny website with the login shapes the keychain has to handle.

import { createServer, type Server } from 'node:http';

export const USER = 'agent@example.com';
export const PASSWORD = 'Correct-Horse-9183!';
export const TOTP = '482913';

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

function form(action: string, inner: string, extra = '') {
  return `<form method="post" action="${action}" ${extra}>${inner}<button type="submit">Sign in</button></form>`;
}

const routes: Record<string, string> = {
  // Plain form. Username field has no hints except its label.
  '/login': page(
    'Login',
    form(
      '/session',
      `<label>Account <input name="acct"></label>
       <label>Search <input name="q" type="search"></label>
       <label>Password <input name="pw" type="password"></label>`,
    ),
  ),
  // Username first, password on the next page.
  '/two-step': page('Two step', form('/two-step/password', `<label>Email <input type="email" name="email"></label>`)),
  // A JS form that rejects every login and keeps the typed values on screen.
  '/spa-fail': page(
    'SPA',
    `<div id="err"></div>` +
      form(
        '#',
        `<label>Username <input autocomplete="username" name="u"></label>
         <label>Password <input autocomplete="current-password" type="password" name="p"></label>`,
        `onsubmit="event.preventDefault(); document.getElementById('err').textContent='Wrong password';"`,
      ),
  ),
  // TOTP prompt.
  '/totp': page('Two-factor', form('/totp-check', `<label>Code <input name="otc" autocomplete="one-time-code" inputmode="numeric"></label>`)),
  // Nothing auto-detection can recognise: the "password" is a text input.
  '/odd': page(
    'Odd',
    form('/session', `<label>Member number <input name="m"></label><label>Secret word <input name="s" type="text"></label>`),
  ),
};

async function readForm(req: import('node:http').IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export function startSite(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (status: number, body: string) => res.writeHead(status, { 'content-type': 'text/html' }).end(body);

    if (req.method === 'GET' && routes[url.pathname]) return html(200, routes[url.pathname]);
    if (req.method === 'POST' && url.pathname === '/session') {
      const f = await readForm(req);
      const user = f.get('acct') ?? f.get('m');
      const pw = f.get('pw') ?? f.get('s');
      if (user === USER && pw === PASSWORD) return res.writeHead(303, { location: '/home' }).end();
      return html(401, page('Denied', `<p>Bad credentials</p>`));
    }
    if (req.method === 'POST' && url.pathname === '/two-step/password') {
      const f = await readForm(req);
      return html(200, page('Password', form('/two-step/done', `<input type="hidden" name="email" value="${f.get('email')}"><label>Password <input type="password" name="password"></label>`)));
    }
    if (req.method === 'POST' && url.pathname === '/two-step/done') {
      const f = await readForm(req);
      if (f.get('email') === USER && f.get('password') === PASSWORD) return res.writeHead(303, { location: '/home' }).end();
      return html(401, page('Denied', ''));
    }
    if (req.method === 'POST' && url.pathname === '/totp-check') {
      const f = await readForm(req);
      return f.get('otc') === TOTP ? res.writeHead(303, { location: '/home' }).end() : html(401, page('Bad code', ''));
    }
    if (url.pathname === '/home') return html(200, page('Welcome', '<p>Signed in</p>'));
    html(404, page('Not found', ''));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })));
}
