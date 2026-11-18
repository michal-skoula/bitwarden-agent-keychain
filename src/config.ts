// Settings shared by the service and the CLI. All from environment variables.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localBw = join(root, 'node_modules', '.bin', 'bw');
const env = process.env;

// systemd sets STATE_DIRECTORY and CREDENTIALS_DIRECTORY for the service.
export const stateDir = env.KEYCHAIN_STATE_DIR ?? env.STATE_DIRECTORY ?? join(homedir(), '.local', 'state', 'bitwarden-agent-keychain');

export const config = {
  stateDir,
  dbFile: join(stateDir, 'keychain.db'),
  host: env.KEYCHAIN_HOST ?? '127.0.0.1',
  port: Number(env.KEYCHAIN_PORT ?? 8765),
  adminHost: env.KEYCHAIN_ADMIN_HOST ?? '127.0.0.1',
  adminPort: Number(env.KEYCHAIN_ADMIN_PORT ?? 8766),
  // What the "token created" screen tells agents to connect to.
  publicMcpUrl: env.KEYCHAIN_PUBLIC_URL ?? null,
  cdpEndpoint: env.KEYCHAIN_CDP_ENDPOINT ?? 'http://127.0.0.1:9222',
  allowedHosts: env.KEYCHAIN_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [],
  wipeAfterMs: Number(env.KEYCHAIN_WIPE_AFTER_MIN ?? 30) * 60_000,
  bwBin: env.BW_BIN ?? (existsSync(localBw) ? localBw : 'bw'),
  // The session key: BW_SESSION, or the systemd credential saved by `keychain setup-session`.
  sessionFile: env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'bw-session') : null,
};
