# bitwarden-agent-keychain

An MCP server that lets an AI agent log into websites with your Bitwarden logins without ever seeing the passwords.

The agent browses with [Playwright MCP](https://github.com/microsoft/playwright-mcp). When it reaches a login form, it calls `fill_login` with a vault item id. The keychain fetches the password from the Bitwarden CLI, types it into the form through its own Playwright connection, submits, and reports back with something like "Filled: username, password. The page navigated after submit." The password never appears in a tool result.

```
                 ┌──────────────────────┐
  agent ────────►│ Playwright MCP       │──┐
    │            └──────────────────────┘  │  CDP
    │            ┌──────────────────────┐  ├──────► Chromium (127.0.0.1:9222)
    └───────────►│ keychain MCP (:8765) │──┘
                 │   └─ bw CLI ─► vault │
                 └──────────────────────┘
```

Status: V2. Each agent gets its own token, scoped to the vault items you picked. The keychain wipes a site's cookies and storage 30 minutes after it filled a login there. There's an admin web UI for tokens and activity. The tests run against a real browser and a real Playwright MCP. Read [Known gaps](#known-gaps) before relying on it.

## Setup

Needs Node 24 or newer.

```sh
npm install
npx playwright-core install chromium   # or point BROWSER_EXECUTABLE at your Chrome

# Once, by hand. This is where your Bitwarden account 2FA happens.
npx bw login
# Self-hosted: npx bw config server https://vault.example.com  (before login)
```

For local development, in two terminals:

```sh
npm run browser   # shared Chromium with CDP on 127.0.0.1:9222
npm start         # asks for your master password, then serves /mcp on :8765 and the admin UI on :8766
```

To skip the password prompt, export `BW_SESSION` from `bw unlock --raw`. Then make a token and an admin login:

```sh
npm run keychain -- token create dev --all --expires 1d   # prints the token once
npm run keychain -- admin set-password
```

On a server it runs as a systemd service under its own user. See [docs/install.md](docs/install.md).

### Connect an agent

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@0.0.85", "--cdp-endpoint", "http://127.0.0.1:9222"]
    },
    "keychain": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer ${KEYCHAIN_TOKEN}" }
    }
  }
}
```

Then block the Playwright MCP tools that can read page internals. With these on, the agent can read a filled field directly. In `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code_unsafe",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_network_request",
      "mcp__playwright__browser_console_messages"
    ]
  }
}
```

Don't enable the `devtools` capability (tracing, recording) either. Traces store DOM snapshots that include input values.

## Tools

| Tool | What it does |
| --- | --- |
| `list_logins(search?)` | Vault search. Returns id, name, username, saved URIs, `has_totp`. No passwords. |
| `fill_login(item_id, page_url?, username_selector?, password_selector?, submit_selector?)` | Fills the login into the open tab whose URL matches the item's saved URIs, then submits. Fields are detected automatically. Selectors are only an override. |
| `fill_totp(item_id, page_url?, totp_selector?, submit_selector?)` | Generates the item's current TOTP code with `bw get totp`, fills it and submits. Handles single-field and six-box inputs. Needs TOTP allowed for that item on the token. |
| `sign_out(item_id)` | Wipes cookies and storage for the sites this login was filled into. Optional: the timer does it anyway. |
| `report_blocked(item_id, reason)` | Writes a "Needs you" note to the admin UI, e.g. when a site wants a push approval. Changes nothing else. |

`list_logins` only shows items in the token's scope. Asking for an item outside it gets the same "No login item" error as an unknown ID, so an agent can't probe what exists. Denials are logged.

Selectors can be CSS (`#email`) or Playwright selectors. The agent can build those from what it sees in a snapshot, for example `role=textbox[name="Email"]`.

For two-step logins (email page, then password page), the agent calls `fill_login` once per page.

## How it keeps the password from the agent

1. **No secret in any tool result.** Error messages are scrubbed of the password and username before they go back.
2. **Origin check.** The keychain only fills into a tab or iframe whose URL matches the item's saved URIs, using Bitwarden's match rules (base domain by default, plus host, starts with, exact, regex and never). A prompt-injected agent can't get your bank password typed into `evil.example`. Plain `http` pages only get credentials if the saved URI is `http` too.
3. **Fill, submit, then clear.** This one matters most. Playwright MCP's `browser_snapshot` prints input values, password fields included:

   ```
   - textbox "Password" [ref=e6]: SuperSecret123
   ```

   So turning off JS evaluation and network tools isn't enough on its own. The keychain submits right after filling. If the password field is still on screen 10 seconds later (wrong password, captcha, a JS form that stays put), it clears the field. The test suite checks this with a real `browser_snapshot`.
4. **No saved passwords in the browser.** `npm run browser` turns off Chrome's password manager in its profile.
5. **Scoped tokens.** Each token reaches only the items picked for it, with TOTP allowed per item. Tokens are stored as SHA-256 hashes and shown once. Revoke takes effect on the next request.
6. **Cleanup.** Every fill records the origin it typed into and the page it landed on. 30 minutes after the last fill there (`KEYCHAIN_WIPE_AFTER_MIN`), on `sign_out`, or on "Wipe now", the keychain clears that origin's storage through CDP and deletes cookies on its registrable domain. Pending wipes survive restarts. Your own browsing on other sites stays logged in.

## Admin UI

Server-rendered pages on a separate port (`KEYCHAIN_ADMIN_PORT`, default 8766), built for a phone: tokens with the "Needs you" banner, a new-token form with a searchable item picker and per-item TOTP, the one-time token screen with the `claude mcp add` command, token detail with signed-in sites and their wipe timers, rotate and revoke, the activity log, and vault status with a sync button.

Login is one username and a scrypt-hashed password. The session cookie is `HttpOnly`, `SameSite=Strict`, and lasts 30 days, renewed on use. Failed logins get a doubling delay. Every form carries a CSRF token, and cross-site POSTs are refused. Agent tokens don't work here.

The same token actions work from the terminal:

```sh
keychain token create routine-invoices --item <id> --item <id>:totp --expires 90d
keychain token list
keychain token rotate routine-invoices
keychain token revoke routine-invoices
```

## Design options considered

**Shared browser over CDP (built).** The keychain and Playwright MCP both attach to one Chromium. It's the least code, it works with stock Playwright MCP, and the agent's tool list doesn't change. The cost is that both share a CDP port, and the password sits in the DOM for a moment.

**Keychain proxies Playwright MCP.** The keychain launches the browser over a pipe (no port), re-exports all Playwright MCP tools and adds `fill_login`. It can scrub every snapshot and refuse leaky tools on the server side instead of relying on client deny lists. It's stronger and about twice the work. It's the likely V2 if the snapshot window or the open CDP port turns out to matter.

**Browser extension.** Close to 1Password's approach. It fills in your real Chrome profile and works with `--extension` mode in Playwright MCP. It's the most work and the hardest to test, and V1 doesn't need it.

**Vault access.** The keychain uses `bw` (the CLI), not `bw serve`. `bw serve` exposes the unlocked vault over unauthenticated localhost HTTP, which is a bad idea on any machine with more than one user.

[Bitwarden Agent Access](https://github.com/bitwarden/agent-access) (`aac`, early preview) is the other candidate. It's an encrypted tunnel from `bw` on your machine to a paired client, with a human approval for each request, and it looks credentials up by domain. It hands the password to whoever connects, so the keychain would be that client and the agent still never sees it. It could replace the `bw` wrapper and the unlocked session later, and its approval prompt covers part of the scoping work.

## Your open questions

**MFA.** There are two kinds.

- *Your Bitwarden account's 2FA* only comes up at `bw login`, which you run once by hand. After that, unlocking only needs the master password, so the agent never deals with it.
- *Websites' 2FA* works when the TOTP secret is saved in the Bitwarden item (the "Authenticator key" field, which needs Premium). `fill_totp` generates the code from it. Codes in the separate Bitwarden Authenticator app aren't reachable from the CLI, so move the sites you want agents to use into vault items. Email and SMS codes are out of scope, and an agent shouldn't need your inbox.

**Hosting.** Run it on the machine where the browser runs. The keychain has to reach the browser's CDP port, and that port must stay on localhost. Anyone who can reach it controls the browser, including its cookies and whatever is typed into it. For agents on other machines, put the keychain behind `tailscale serve` later. Don't expose it publicly.

## Known gaps

- **The CDP port is wide open locally.** Any local process can attach to the browser on 9222 and read pages, cookies and filled fields. Agents need that port for Playwright MCP, so it's an accepted risk. Cleanup keeps logged-in sessions in the browser short.
- **Tokens sit in readable config.** Agents keep their token in a local MCP config that other agents on the same account can read. Keep the full-access token short-lived, keep routine tokens narrow, and watch the activity log for a token used from the wrong place.
- **A wipe doesn't log out on the server.** It removes the browser's copy of the session. Within the 30 minutes, another agent sharing the browser could reuse it.
- **Snapshot race.** From the fill until the page navigates (usually milliseconds, at most 10 seconds on a failed login), an agent that snapshots at the same moment could see the value. The proxy design closes this.
- **The vault stays unlocked while the service runs.** By design: access is limited by token scope and expiry instead.
- **Items need a saved URI.** Logins without one can't be filled, by design.
- **JS on the page itself can read the field.** That's true of every password manager, and the origin check limits which pages get filled.

## Roadmap

1. ~~Scoped tokens, browser cleanup after use, and a small admin web UI~~. Done, see [docs/v2-plan.md](docs/v2-plan.md).
2. Filling into T3's built-in browser ([docs/t3-integration-plan.md](docs/t3-integration-plan.md)).
3. Proxy mode: a pipe-launched browser, redacted snapshots, and a server-side tool denylist.

## Development

```sh
npm test          # e2e: Chromium + Playwright MCP + fake bw, plus the admin UI over HTTP
npm run typecheck
node test/fixtures/demo.ts <dir>   # screenshots of every admin page with demo data
```

Config is through environment variables: `KEYCHAIN_HOST`, `KEYCHAIN_PORT`, `KEYCHAIN_ADMIN_HOST`, `KEYCHAIN_ADMIN_PORT`, `KEYCHAIN_PUBLIC_URL`, `KEYCHAIN_CDP_ENDPOINT`, `KEYCHAIN_ALLOWED_HOSTS`, `KEYCHAIN_STATE_DIR`, `KEYCHAIN_WIPE_AFTER_MIN`, `KEYCHAIN_TIMEZONE`, `BW_BIN`, `BW_SESSION`. The browser launcher reads `BROWSER_CDP_PORT`, `BROWSER_PROFILE`, `BROWSER_EXECUTABLE`, `BROWSER_HEADLESS=1` and `BROWSER_NO_SANDBOX=1`.
