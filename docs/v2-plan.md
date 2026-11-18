# Plan: V2, scoped tokens and cleanup

V1 has one token, and whoever holds it can fill every login. V2 lets you hand out tokens that only reach the items you picked. Routines get a narrow token as a secret, and sessions you supervise get a full-access one.

Mockup (phone): https://claude.ai/artifact/BoxTW1Bn2VE1pmKiAfdksb

## What stays the same

- One MCP URL for every agent. The token in the `Authorization` header decides what that agent can do. Agents differ only in the `KEYCHAIN_TOKEN` secret.
- The fill tools, the origin check, fill-then-submit-then-clear, and the shared browser over CDP.
- Bitwarden holds the credentials. The keychain stores item IDs, never copies of passwords.

## Decided against

- **OAuth.** Unattended routines can't click through a consent screen, and a static token covers both cases.
- **Scoping by domain or by Bitwarden folder.** A domain can't tell two accounts on the same site apart, and it would grant new items silently. An item can only sit in one folder, so two tokens couldn't share one.
- **A browser profile per token, and proxy mode.** Too much machinery for how often this gets used. The keychain wipes site data after use instead (see Cleanup).

## How it runs

A system service under its own user, the same way Caddy runs. The vault session, the token store and the log live in that user's state directory, so agents running as `t3` can't read them. Michal sets this up. It needs root.

The vault unlocks itself on start, and there's no unlock screen or auto-lock. A one-time setup step runs `bw unlock --raw` and saves the session key as a systemd credential (`LoadCredential=`), readable only by the service. The master password is never stored. If the key stops working (someone ran `bw lock` or `bw logout`), the service refuses to start and logs why. Rerun the setup step to fix it.

Agent access is limited with token expiry, not by locking the vault.

Two listeners:

| Listener | Who uses it |
| --- | --- |
| `/mcp` | Agents, with a bearer token |
| admin UI + API | You only. A separate port, so the reverse proxy can expose it on its own terms |

The browser also runs as the service user, with CDP on localhost. Agents' Playwright MCP still has to attach to it, so any local process can drive the browser. That's an accepted risk. Cleanup keeps the window in which a session sits in the browser short.

## Tokens

- Format `kc_<43 chars base64url>` (32 random bytes). The store keeps a SHA-256 hash and the first 6 characters to tell tokens apart in the UI. The full token is shown once, at creation.
- Each token has a name, a created time, an optional expiry, last-used time, a revoked flag, and a scope:
  - `all`: every login item, including ones added later.
  - a list of `{ item_id, totp: bool }`.
- Rotate keeps the scope and replaces the secret. Revoke takes effect on the next request.
- Store: one SQLite file (tokens, scopes, activity, pending wipes). Node 24 has `node:sqlite` built in, so no new dependency.

## Agent tools

| Tool | V2 behaviour |
| --- | --- |
| `list_logins(search?)` | Only items in the token's scope. `has_totp` is true only if the item has a key *and* the token may use it. |
| `fill_login(item_id, ...)` | Item not in scope: the same "no such item" error as an unknown ID, so the agent can't probe what exists. Logged as denied. |
| `fill_totp(item_id, ...)` | Needs the item in scope with `totp: true`. |
| `sign_out(item_id)` **new** | Wipes the browser data for that item's sites right away. Optional for agents. The timer covers it if they don't. |
| `report_blocked(item_id, reason)` **new, optional** | Writes a "Needs you" entry, e.g. the site wants a push approval. The keychain can't reliably detect that itself. Saves nothing else. |

Agents can't create, change or see tokens. Nothing an agent calls changes what it has access to.

## Cleanup

Every successful fill records two origins: the frame the keychain typed into, and the page URL after submit. The login often happens on an SSO host and lands on another one. Each origin gets a wipe time of `last fill + 30 min` (configurable).

When the time comes, or on `sign_out`, or on "Wipe now" in the UI, the keychain:

1. calls CDP `Storage.clearDataForOrigin` with `storageTypes: "all"`. That covers localStorage, IndexedDB, cache and service workers, which matters because many single-page apps keep their login token there, not in a cookie.
2. deletes the cookies whose domain matches the origin's registrable domain, which catches `.mbank.cz`-style parent-domain cookies.

Only origins the keychain filled get wiped. Your own manual browsing in the same browser stays logged in.

Pending wipes live in the store. If the service restarts, it wipes everything on the list at startup.

This doesn't end the session on the website's server, it only removes the browser's copy, which is the part other agents can reach. A routine running at the same time as a supervised session can still reuse that session within the 30 minutes. Routines at 03:00 rarely overlap with you.

## MFA

- **TOTP:** `fill_totp` already works. Put the authenticator key in the Bitwarden item and tick TOTP for that item on the token.
- **Email, SMS, push:** the routine stops and reports (`report_blocked`). Switch the site to TOTP where it offers it. With cleanup, routines log in fresh each run, so a site that always sends an email code doesn't suit a routine.

## Admin UI

The screens in the mockup:

1. Tokens: list, vault lock state, the "Needs you" banner
2. New token: name, expiry, all or selected items, searchable item picker with a TOTP toggle per item, and a summary of the domains it can reach
3. Token created: shown once, with the `.mcp.json` snippet
4. Token detail: items, signed-in sites with their wipe timers, rotate, revoke
5. Activity: fills, denials, sign-outs, wipes, blocked reports

Plus a login screen. It's server-rendered HTML with a little JS, built into the service, with no frontend build.

Admin login is a username and password, no MFA, since the UI is internal only. The password is stored as a scrypt hash (`node:crypto`, no dependency), and a setup command sets it. A successful login gets an `HttpOnly`, `SameSite=Strict` session cookie that lasts 30 days and renews on use, so you rarely log in again. Failed logins get a growing delay. Agent tokens are never accepted here.

The same actions go through an admin CLI for terminal use (`keychain token create|list|revoke|rotate`). It runs as the service user, or talks to the admin API.

## Build order

1. **Token store and scoping.** SQLite store, hashed tokens, scope checks in the three tools, the CLI. The e2e tests get a scoped token and an out-of-scope fill.
2. **Cleanup.** Origin tracking, the timer, `sign_out`, startup wipe. Test: fill, wipe, then check the site's cookie and localStorage are gone in the real browser.
3. **Admin UI.** Login, the five screens, activity log, `report_blocked`.
4. **Deploy as a service.** Unit file and install notes for Michal. He does the root part.

## Getting tokens to agents

Each routine runs in its own T3 project. Its token goes in that project's local Claude Code MCP config (`claude mcp add --scope local ...`, stored per project path and never committed). Supervised sessions use a full-access token the same way.

All those configs sit in files `t3` can read, so any agent on this account can read every token, the full-access one included. A routine that goes looking could use the full token instead of its own. So:

- Give the full-access token a short expiry, a day or a week, and rotate it.
- Keep routine tokens narrow, so that a leaked one exposes little.
- The activity log shows which token did each fill, so a routine using the full-access token stands out.

## Open questions

- Does T3's own secret store (`apps/server/src/secrets/`) support per-task secrets? If it does, that would beat a plain-text MCP config. Not checked yet.
- Filling into T3's built-in browser is still a separate track ([t3-integration-plan.md](t3-integration-plan.md)). T3 isolates its browser per named profile, not per project, so the same cleanup approach would apply there.
