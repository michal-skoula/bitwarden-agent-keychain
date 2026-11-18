// Entry point: open the vault with the saved session key, then serve /mcp for
// agents and the admin UI on its own port.

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createAdminServer } from './admin/server.ts';
import { Bitwarden } from './bitwarden.ts';
import { Cleanup } from './cleanup.ts';
import { config } from './config.ts';
import { BrowserFiller } from './filler.ts';
import { createKeychainHttpServer } from './server.ts';
import { Store } from './store.ts';

function log(line: string) {
  process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);
}

function sessionKey(): string | null {
  if (process.env.BW_SESSION) return process.env.BW_SESSION;
  if (config.sessionFile && existsSync(config.sessionFile)) return readFileSync(config.sessionFile, 'utf8').trim();
  return null;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    out._writeToOutput = (s: string) => {
      if (!muted) process.stderr.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function unlock(): Promise<Bitwarden> {
  const key = sessionKey();
  const bw = new Bitwarden(config.bwBin, key);
  const status = await bw.status();
  if (status === 'unauthenticated') {
    throw new Error(`Bitwarden CLI is not logged in. Run "${config.bwBin} login" once as this user, then "keychain setup-session".`);
  }
  if (status !== 'unlocked') {
    if (key || !process.stdin.isTTY) {
      // The service never asks for the master password. A dead key needs the setup step again.
      throw new Error(
        key
          ? 'The saved Bitwarden session key no longer works (someone ran "bw lock" or "bw logout"). Rerun "keychain setup-session", then restart.'
          : 'No Bitwarden session key. Run "keychain setup-session" (or set BW_SESSION), then start again.',
      );
    }
    // Local development: ask once in the terminal.
    await bw.unlock(await promptHidden('Bitwarden master password: '));
    if ((await bw.status()) !== 'unlocked') throw new Error('Unlock failed.');
  }
  await bw.sync();
  log('Vault unlocked and synced.');
  return bw;
}

try {
  const bitwarden = await unlock();
  const store = new Store(config.dbFile);
  const filler = new BrowserFiller(config.cdpEndpoint);
  const cleanup = new Cleanup({ store, filler, ttlMs: config.wipeAfterMs, log });

  const { host, port, adminHost, adminPort } = config;
  const allowedHosts = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, ...config.allowedHosts];
  const mcp = createKeychainHttpServer({ bitwarden, filler, store, cleanup, log }, allowedHosts);
  const admin = createAdminServer({ store, bitwarden, cleanup, mcpUrl: config.publicMcpUrl ?? `http://${host}:${port}/mcp`, log });

  mcp.listen(port, host, () => log(`Keychain MCP listening on http://${host}:${port}/mcp (browser: ${config.cdpEndpoint})`));
  admin.listen(adminPort, adminHost, () => log(`Admin UI on http://${adminHost}:${adminPort}/`));
  cleanup.start();
  if (store.listTokens().every((t) => t.revokedAt !== null)) log('No active tokens yet. Create one in the admin UI or with "keychain token create".');
  if (!store.hasAdmin()) log('No admin password set. Run "keychain admin set-password" to use the admin UI.');

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log('Shutting down.');
      cleanup.stop();
      mcp.close();
      admin.close();
      store.close();
      process.exit(0);
    });
  }
} catch (e) {
  log((e as Error).message);
  process.exit(1);
}
