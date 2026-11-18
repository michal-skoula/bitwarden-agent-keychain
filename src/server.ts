// MCP server exposing the keychain tools over Streamable HTTP.
//
// One long-running process holds the unlocked vault session; any number of
// agents connect to it with a bearer token. The token decides which vault
// items the agent can see and fill. Agents never receive a password or TOTP
// code, and nothing they call changes what they have access to.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Bitwarden, LoginSecret } from './bitwarden.ts';
import { hostOf, type Cleanup } from './cleanup.ts';
import type { BrowserFiller, FillResult } from './filler.ts';
import type { Store, TokenRecord } from './store.ts';

export interface KeychainDeps {
  bitwarden: Bitwarden;
  filler: BrowserFiller;
  store: Store;
  cleanup: Cleanup;
  log?: (line: string) => void;
}

const SELECTOR_HELP =
  'Optional. Only pass this if auto-detection fails. CSS ("#email", "input[name=login]") or a ' +
  'Playwright selector built from the snapshot, e.g. \'role=textbox[name="Email"]\'.';

function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('[redacted]');
  return out;
}

function describe(r: FillResult): string {
  const lines = [`Filled: ${r.filled.join(', ')}. Submitted by ${r.submitted === 'clicked' ? 'clicking submit' : 'pressing Enter'}.`];
  if (r.outcome === 'navigated') lines.push('The page navigated after submit.');
  if (r.outcome === 'form_gone') lines.push('The field disappeared after submit.');
  if (r.outcome === 'form_still_present_cleared')
    lines.push('The form was still on screen after submit, so the secret field was cleared. Take a snapshot to read any error message.');
  if (r.outcome === 'no_secret_filled')
    lines.push('Only the username was filled. If the site now shows a password step, call fill_login again.');
  lines.push(`Current URL: ${r.url}`);
  return lines.join('\n');
}

const OUTCOME_LOG: Record<FillResult['outcome'], string> = {
  navigated: 'page navigated',
  form_gone: 'field gone after submit',
  form_still_present_cleared: 'form still there after submit, secret cleared',
  no_secret_filled: 'username only, waiting for the next step',
};

type ToolReply = { isError?: boolean; content: { type: 'text'; text: string }[] };
const reply = (text: string, isError = false): ToolReply => ({ ...(isError ? { isError } : {}), content: [{ type: 'text', text }] });

// Unknown IDs and out-of-scope IDs get the same answer, so an agent can't probe what exists.
const notFound = (id: string) => reply(`No login item with id "${id}".`, true);

export function inScope(token: TokenRecord, itemId: string): { totp: boolean } | null {
  if (token.scope.all) return { totp: true };
  const it = token.scope.items.find((i) => i.itemId === itemId);
  return it ? { totp: it.totp } : null;
}

export function buildMcpServer({ bitwarden, filler, store, cleanup, log = () => {} }: KeychainDeps, token: TokenRecord): McpServer {
  const server = new McpServer({ name: 'bitwarden-agent-keychain', version: '0.2.0' });
  const who = `token=${token.name}`;

  async function itemName(id: string): Promise<string | null> {
    try {
      return (await bitwarden.cachedLogins()).find((i) => i.id === id)?.name ?? null;
    } catch {
      return null;
    }
  }

  async function deny(tool: string, itemId: string, why: string) {
    const name = await itemName(itemId);
    store.log({ token, kind: 'denied', itemId, itemName: name, detail: why, problem: true });
    log(`${tool} ${who} item=${itemId} denied: ${why}`);
  }

  // Loads an item the token may use, or returns the reply to send instead.
  async function load(tool: string, itemId: string): Promise<{ item: LoginSecret; totp: boolean } | ToolReply> {
    const access = inScope(token, itemId);
    if (!access) {
      await deny(tool, itemId, 'Asked for an item outside its scope.');
      return notFound(itemId);
    }
    let item: LoginSecret;
    try {
      item = await bitwarden.getLogin(itemId);
    } catch {
      return notFound(itemId);
    }
    // `bw get item` also accepts search text. Only an exact ID counts.
    if (item.id !== itemId) return notFound(itemId);
    return { item, totp: access.totp };
  }

  function recordFill(tool: 'fill_login' | 'fill_totp', item: LoginSecret, r: FillResult) {
    cleanup.recordFill(token, item.id, [r.frameUrl, r.url]);
    store.log({
      token,
      kind: tool,
      itemId: item.id,
      itemName: item.name,
      detail: OUTCOME_LOG[r.outcome],
      problem: r.outcome === 'form_still_present_cleared',
    });
    log(`${tool} ${who} item=${item.id} (${item.name}) -> ${r.outcome} ${r.url}`);
  }

  function recordFailure(tool: string, item: LoginSecret, msg: string) {
    const first = msg.split('\n')[0];
    store.log({ token, kind: 'fill_failed', itemId: item.id, itemName: item.name, detail: `${tool} failed: ${first}`, problem: true });
    log(`${tool} ${who} item=${item.id} (${item.name}) failed: ${first}`);
  }

  server.registerTool(
    'list_logins',
    {
      title: 'List logins',
      description:
        'Search the Bitwarden vault for login items you may use. Returns id, name, username and saved URIs. Never returns passwords.',
      inputSchema: { search: z.string().optional().describe('Text to search for, e.g. a site name or domain.') },
      annotations: { readOnlyHint: true },
    },
    async ({ search }) => {
      const items = (await bitwarden.listLogins(search)).filter((i) => inScope(token, i.id));
      log(`list_logins ${who} search=${JSON.stringify(search ?? '')} -> ${items.length} items`);
      const rows = items.map((i) => ({
        id: i.id,
        name: i.name,
        username: i.username,
        uris: i.uris.map((u) => u.uri),
        has_totp: i.hasTotp && inScope(token, i.id)!.totp,
      }));
      return reply(JSON.stringify(rows, null, 2));
    },
  );

  server.registerTool(
    'fill_login',
    {
      title: 'Fill login',
      description:
        'Fill a vault login into the login form open in the shared browser and submit it. You never see the password. ' +
        'Navigate to the login page with Playwright MCP first. The tab URL must match one of the item\'s saved URIs. ' +
        'Username and password fields are detected automatically. On two-step logins (username, then password), call ' +
        'this once per step. Take a snapshot afterwards to check the result.',
      inputSchema: {
        item_id: z.string().describe('Vault item id from list_logins.'),
        page_url: z.string().optional().describe('Optional URL prefix to pick a tab when several are open.'),
        username_selector: z.string().optional().describe(SELECTOR_HELP),
        password_selector: z.string().optional().describe(SELECTOR_HELP),
        submit_selector: z.string().optional().describe(`Submit button. ${SELECTOR_HELP}`),
      },
    },
    async (args) => {
      const loaded = await load('fill_login', args.item_id);
      if (!('item' in loaded)) return loaded;
      const { item } = loaded;
      try {
        const result = await filler.fillLogin(
          item.uris,
          { username: item.username, password: item.password },
          {
            pageUrl: args.page_url,
            usernameSelector: args.username_selector,
            passwordSelector: args.password_selector,
            submitSelector: args.submit_selector,
          },
        );
        recordFill('fill_login', item, result);
        return reply(describe(result));
      } catch (e) {
        const msg = redact((e as Error).message, [item.password, item.username]);
        recordFailure('fill_login', item, msg);
        return reply(msg, true);
      }
    },
  );

  server.registerTool(
    'fill_totp',
    {
      title: 'Fill TOTP code',
      description:
        'Generate the current TOTP code for a vault login (from its saved authenticator key) and fill it into the ' +
        'two-factor form in the shared browser, then submit. You never see the code. Use after fill_login when the ' +
        'site asks for an authenticator code.',
      inputSchema: {
        item_id: z.string().describe('Vault item id from list_logins. The item must have has_totp: true.'),
        page_url: z.string().optional().describe('Optional URL prefix to pick a tab when several are open.'),
        totp_selector: z.string().optional().describe(SELECTOR_HELP),
        submit_selector: z.string().optional().describe(`Submit button. ${SELECTOR_HELP}`),
      },
    },
    async (args) => {
      const loaded = await load('fill_totp', args.item_id);
      if (!('item' in loaded)) return loaded;
      const { item, totp } = loaded;
      const noTotp = reply(`"${item.name}" has no authenticator code available to you.`, true);
      if (!totp) {
        await deny('fill_totp', item.id, 'Asked for a TOTP code it may not use.');
        return noTotp;
      }
      if (!item.hasTotp) return noTotp;
      const code = await bitwarden.getTotp(item.id);
      try {
        const result = await filler.fillTotp(item.uris, code, {
          pageUrl: args.page_url,
          totpSelector: args.totp_selector,
          submitSelector: args.submit_selector,
        });
        recordFill('fill_totp', item, result);
        return reply(describe(result));
      } catch (e) {
        const msg = redact((e as Error).message, [code, item.password]);
        recordFailure('fill_totp', item, msg);
        return reply(msg, true);
      }
    },
  );

  server.registerTool(
    'sign_out',
    {
      title: 'Sign out',
      description:
        'Wipe the browser\'s cookies and storage for the sites this login was filled into. Call it when you are done ' +
        'with a site. If you don\'t, the keychain does it on a timer anyway.',
      inputSchema: { item_id: z.string().describe('Vault item id you filled earlier.') },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ item_id }) => {
      if (!inScope(token, item_id)) {
        await deny('sign_out', item_id, 'Asked to sign out of an item outside its scope.');
        return notFound(item_id);
      }
      const done = await cleanup.signOut(token, item_id);
      log(`sign_out ${who} item=${item_id} -> ${done.length} origins`);
      if (done.length === 0) return reply('Nothing to wipe. Either this login was not filled recently, or it was already wiped.');
      return reply(`Signed out. Wiped cookies and storage for ${done.map(hostOf).join(', ')}.`);
    },
  );

  server.registerTool(
    'report_blocked',
    {
      title: 'Report blocked login',
      description:
        'Tell the human that a login needs them, e.g. the site wants a push approval, an email or SMS code, or a ' +
        'captcha. Then stop working on that site. This only writes a note for the human, it changes nothing else.',
      inputSchema: {
        item_id: z.string().describe('Vault item id of the login that is blocked.'),
        reason: z.string().min(1).max(500).describe('What the site is asking for, in one or two sentences.'),
      },
    },
    async ({ item_id, reason }) => {
      if (!inScope(token, item_id)) return notFound(item_id);
      const name = await itemName(item_id);
      store.log({ token, kind: 'blocked', itemId: item_id, itemName: name, detail: reason, problem: true });
      log(`report_blocked ${who} item=${item_id}: ${reason}`);
      return reply('Reported. The human will see it in the keychain admin. Stop trying this login for now.');
    },
  );

  return server;
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
}

// Stateless Streamable HTTP: a fresh MCP server + transport per request. The
// token is checked on every request, so a revoke takes effect on the next one.
export function createKeychainHttpServer(deps: KeychainDeps, allowedHosts: string[]): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcp') return send(res, 404, 'not found');
    const token = deps.store.authenticate(bearer(req));
    if (!token) return send(res, 401, 'unauthorized');
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');

    const server = buildMcpServer(deps, token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      deps.log?.(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
    }
  });
}
