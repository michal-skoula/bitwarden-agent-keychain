// Starts the shared Chromium that both Playwright MCP and the keychain attach to.
//
//   npm run browser                 # headed, CDP on 127.0.0.1:9222
//   BROWSER_HEADLESS=1 npm run browser
//   BROWSER_EXECUTABLE=/usr/bin/google-chrome npm run browser

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const port = Number(process.env.BROWSER_CDP_PORT ?? 9222);
const profile = process.env.BROWSER_PROFILE ?? join(homedir(), '.local', 'share', 'bitwarden-agent-keychain', 'browser-profile');
const executable = process.env.BROWSER_EXECUTABLE ?? chromium.executablePath();

if (!existsSync(executable)) {
  console.error(`No browser at ${executable}. Run "npx playwright-core install chromium" or set BROWSER_EXECUTABLE.`);
  process.exit(1);
}

// Turn off Chrome's own password manager so filled credentials are never saved
// into the browser profile, where another tool could read them.
const prefsFile = join(profile, 'Default', 'Preferences');
if (!existsSync(prefsFile)) {
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(
    prefsFile,
    JSON.stringify({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
    }),
  );
}

const args = [
  `--remote-debugging-port=${port}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication',
];
if (process.env.BROWSER_HEADLESS === '1') args.push('--headless=new');
if (process.env.BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox');
args.push('about:blank');

console.error(`Starting ${executable}\nCDP endpoint: http://127.0.0.1:${port}\nProfile: ${profile}`);
const child = spawn(executable, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
