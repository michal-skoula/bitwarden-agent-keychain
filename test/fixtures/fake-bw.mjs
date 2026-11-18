#!/usr/bin/env node
// Stand-in for the Bitwarden CLI. Reads items from $FAKE_BW_ITEMS (a JSON file)
// and supports just the subcommands the keychain uses.
import { readFileSync } from 'node:fs';

const items = JSON.parse(readFileSync(process.env.FAKE_BW_ITEMS, 'utf8'));
const [cmd, sub, arg] = process.argv.slice(2);
const unlocked = process.env.BW_SESSION === 'fake-session';
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const fail = (msg) => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};

switch (cmd) {
  case 'status':
    out({ status: unlocked ? 'unlocked' : 'locked' });
    break;
  case 'unlock':
    if (process.env[process.argv[4]] !== 'master') fail('Invalid master password.');
    out('fake-session');
    break;
  case 'sync':
    if (!unlocked) fail('Vault is locked.');
    out('Syncing complete.');
    break;
  case 'list': {
    if (!unlocked) fail('Vault is locked.');
    const search = process.argv.includes('--search') ? process.argv[process.argv.indexOf('--search') + 1].toLowerCase() : null;
    out(items.filter((i) => !search || JSON.stringify([i.name, i.login?.username, i.login?.uris]).toLowerCase().includes(search)));
    break;
  }
  case 'get': {
    if (!unlocked) fail('Vault is locked.');
    const item = items.find((i) => i.id === arg);
    if (!item) fail('Not found.');
    if (sub === 'item') out(item);
    else if (sub === 'totp') item.login?.totp ? out('482913') : fail('No TOTP available for this login.');
    else fail(`unsupported: get ${sub}`);
    break;
  }
  default:
    fail(`unsupported command: ${cmd}`);
}
