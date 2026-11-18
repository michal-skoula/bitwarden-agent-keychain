# Plan: Bitwarden logins in T3's browser, on a self-updating T3 fork

Three parts, built in this order:

1. **Pipeline.** A nightly agent merges upstream T3 releases into the fork. A timer deploys whatever the agent signed off on.
2. **Keychain service.** This repo grows a small HTTP API that T3 asks for credentials. The vault, the origin check and later the scopes all live here.
3. **T3 change.** One new preview tool, `preview_fill_credential`, that fills a login into a T3 browser tab. The agent never sees the secret.

The pipeline comes first and runs on an unmodified release for a while. That way, when the T3 change lands, the only new thing is the change itself.

Facts this plan relies on are referenced to files in `~/code/t3code` (fork of pingdotgg/t3code, at upstream `main` when cloned).

---

## Part 1: the pipeline

```
 01:00 UTC  T3 scheduled task (agent, in ~/code/t3code-merge)
            fetch upstream tags -> merge latest stable into `fork`
            -> build -> run tests + PATCHES.md checks
            -> ok:     push `fork`, move `deploy`, keep the tarball
            -> stuck:  AskUserQuestion in its thread, push nothing

 04:00 Prague  systemd user timer (script, no agent)
            fetch `deploy` --ff-only -> nothing new? exit
            -> tarball for that commit? else build
            -> install as a new version -> health check -> roll back if bad
            -> only on broken states: gh issue on the fork
```

The two steps never talk to each other. They only share the `deploy` branch on GitHub and a local tarball cache keyed by commit SHA.

### Branches and versions

- **`upstream`** remote: `https://github.com/pingdotgg/t3code`. The fork has no tags yet. Fetch them with `git fetch upstream 'refs/tags/*:refs/tags/*'`.
- **`fork`**: your changes on top of upstream. It starts at the latest stable tag (`v0.1.10` today), **not** at upstream `main`. `main` has database migrations that aren't in any release yet. Once a build with those migrations runs, you can't go back to an official release until upstream ships one (`servicePreflight.ts:60-80`).
- **`deploy`**: only the merge agent moves it, and only to a commit it has checked. Only ever fast-forwarded.
- **Fork `main`**: left alone as a plain mirror. Nothing builds from it.
- **Latest stable tag**: `git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1`. Nightlies are `vX.Y.Z-nightly.*` (`scripts/resolve-nightly-release.ts:115`).
- **Version string**: `APP_VERSION=<tag>+fork.<sha7>`, e.g. `0.1.10+fork.3f9c2ab`.
  - `+build` metadata is valid (`serviceProtocol.ts:181`) and counts as stable (`cliRelease.ts:91`).
  - Comparisons ignore it (`serviceProtocol.ts:230`), so `0.1.11+fork.x` beats `0.1.10+fork.y`.
  - Don't use a `-fork` suffix. That's a prerelease and sorts *below* the plain version.

### Checkouts

| Path | Who uses it |
| --- | --- |
| `~/code/t3code` | You and your agents, developing changes on `fork` (or worktrees off it) |
| `~/code/t3code-merge` | The merge agent only. A bound scheduled task runs in its project's main checkout, so it needs its own T3 project and its own clone |
| `~/code/t3code-deploy` | The deploy script only |
| `~/t3-builds/<sha>.tar.gz` | Tarballs the merge agent built and checked. The deploy script reuses them, so it doesn't build twice |

### Building (same commands for agent and script)

From `.github/workflows/release*.yml`. Nothing needs secrets, and Linux builds aren't signed (`scripts/build-cli-archive.ts:653`).

```sh
vp i
APP_VERSION=$V vp run --filter t3 build
APP_VERSION=$V node apps/server/scripts/cli.ts build-exe --verbose
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$V" \
  --resource-monitor-dir ~/.t3/runtime/versions/<current>/resource-monitor --output-dir release-cli
node scripts/smoke-cli-archive.ts --archive release-cli/t3-$V-linux-x64.tar.gz --expect-version "$V"
```

- Reusing the installed `resource-monitor` binary skips Rust entirely.
- Node must be exactly the version in `engines.node`, which is 26.13.1 and is what mise has here.

One-time installs, all as `t3`, no root needed:
- `vp`: `curl -fsSL https://vite.plus | bash`
- `patchelf`: `pip3 install --user patchelf`, or a static binary from its GitHub releases

`build-cli-archive` also runs `vp install --prod` without a lockfile, so the build needs npm access. The internet works here.

Cost: CI uses 32 vCPUs with a 30-minute timeout. This machine has 4 cores and every process `t3` runs shares 7 GiB, so expect tens of minutes. Phase 0 measures it.

### Installing a build (deploy script)

```sh
d=~/.t3/runtime/versions/$V
mkdir -p "$d.tmp" && tar -xzf ~/t3-builds/$SHA.tar.gz -C "$d.tmp" --strip-components=1
echo "$V" > "$d.tmp/.install-complete" && mv "$d.tmp" "$d"
~/.t3/runtime/versions/$CURRENT/t3 update "$V" --yes
```

- If the version directory is there with a matching `.install-complete`, `t3 update` downloads nothing (`pinnedRuntime.ts:310-325`).
- It runs the database preflight, repoints `~/.local/bin/t3`, rewrites `t3code.service` and restarts (`update.ts:336-620`, `bootService.ts:1209`). The `10-cowork.conf` override survives the rewrite.
- **To check in Phase 0:** whether `t3 update` accepts two builds that compare equal (`0.1.10+fork.a` → `0.1.10+fork.b`). If it refuses, use `"$d/t3" service install` and then `"$d/t3" install`.
- Rollback: `t3 update "$PREV" --allow-downgrade --yes`, as the current script does.

### Keeping the build in place

The server never updates itself on a timer (`managedUpdates.ts:21`). But the "Update available" banner in the desktop and phone apps can install an official release over your build (`ws.ts:2673` → `cloud/selfUpdate.ts`).

To block that, add `Environment=T3CODE_RELEASE_BASE_URL=http://127.0.0.1:9/` to `10-cowork.conf`. The banner then fails harmlessly. It will still show whenever upstream is ahead of your build.

### The deploy script (replaces `~/.local/bin/t3-nightly-update`)

1. Skip if a `claude` process is running. That keeps the current rule, which protects agents mid-turn.
2. `git -C ~/code/t3code-deploy fetch origin deploy`. If HEAD equals `origin/deploy`, exit 0.
3. `git merge --ff-only origin/deploy`. If that fails, open an issue and exit. History was rewritten, and a person should look.
4. Use `~/t3-builds/<sha>.tar.gz` if it's there, otherwise build. A failed build opens an issue and changes nothing.
5. Install, then health-check `http://100.127.105.79:3773/` 12 times, 5 s apart (same as today).
6. If unhealthy, roll back. If the rollback fails too, open an issue.
7. Delete tarballs and version directories older than the last three.

The timer stays at 04:00 Europe/Prague. The server runs in UTC, so the agent's 01:00 UTC is 02:00 or 03:00 Prague, depending on daylight saving. That leaves at least an hour.

Issues go out with `gh issue create -R michal-skoula/t3code`. `gh` is already logged in here, and the GitHub app pushes them to your phone.

### The merge agent

**Setup**
- A T3 project for `~/code/t3code-merge`.
- `schedule_task` with `fixed_time` `01:00` (server time, UTC), `bindToCurrentThread: true`, `freshSession: true`.
  - Bound means every run posts in one thread you can find.
  - A fresh session means last night's context doesn't pile up.
  - While a run waits on your answer, the next night's run queues behind it once instead of starting a second copy (`ScheduledTaskService.ts:851-865`).
- The task prompt is one line: "Follow `.fork/merge-agent.md`". The procedure lives in the fork, under version control, and you change it without recreating the task.

**What reaches your phone** (`AgentAwarenessRelay.ts`, `agentAwareness.ts:154`):
- `AskUserQuestion` sends "needs input".
- Ending a turn sends "completed", and a failure sends "failed".
- Push only works if this T3 environment is linked to T3 Connect. Otherwise you get desktop and web notifications only.

**`.fork/merge-agent.md`, roughly**
1. Fetch upstream tags. Find the latest stable tag.
2. If it's already merged into `fork`, and `fork` has no commits since `deploy`, end with one line: "nothing new".
3. Merge the tag into `fork` (a merge commit, never a rebase). Resolve conflicts that are clearly mechanical. If a conflict touches what a `PATCHES.md` entry describes and the right answer isn't obvious, ask with `AskUserQuestion` and push nothing.
4. Install, typecheck, and run the tests for the packages the merge touched plus every package a patch touches.
   - Long commands go in the background. Claude Code's Bash tool stops at 10 minutes, and T3 doesn't change that.
5. Build the tarball as `<tag>+fork.<sha7>`, run `smoke-cli-archive`, and copy it to `~/t3-builds/<sha>.tar.gz`.
6. Go through `PATCHES.md` and check each entry the way it says. If anything fails, ask.
7. Push `fork`. Fast-forward `deploy` to the same commit and push it.
8. End with a short summary: tag merged, conflicts resolved and how, checks run.

The agent also deploys your own changes. Anything you push to `fork` ships on the next night where the checks pass, even without a new upstream tag.

**`PATCHES.md`** has one entry per change: what it does, which files, and how to tell it still works, in plain words. There's no hard-coded gate. The agent reads the entry and decides how to check it.

**Possible later upgrade.** The run fires every night, and each finished turn sends a "completed" push. If those get annoying, switch the trigger to `{type: 'webhook'}` (needs T3 Connect). A cheap cron script then checks `git ls-remote --tags upstream` and `fork` vs `deploy`, and calls the webhook only when there's work.

---

## Part 2: keychain service changes (this repo)

T3 doesn't talk to Bitwarden. It asks this service for the credential, so all vault logic stays in code you fully control.

**`GET /v1/match?url=<frame url>`** returns the logins whose saved URIs match that URL, using the existing `origin.ts` rules: `[{ id, name, username }]`. No secrets.

**`POST /v1/secret { itemId, url, kind: "login" | "totp" }`**
- Checks `url` against the item's URIs **again**, so even a buggy T3 change can't pull a password for the wrong site.
- Returns `{ username, password }` or `{ code }`. TOTP is generated fresh every time.

**Two tokens.**
- The **host token** is for T3 and is allowed `/v1/*`.
- **Agent tokens** only get the MCP tools.
- Both live in `~/.config/bitwarden-agent-keychain/`, mode 0600.

**Unlocking.**
- The service starts locked, as a systemd user unit.
- `npm run unlock` asks for the master password in your terminal and hands it to the service over a Unix socket (mode 0600). The service then holds the session key in memory only.
- An idle auto-lock (say 8 h) is an optional extra.
- While locked, `/v1/secret` returns `423 Locked`. The T3 tool turns that into "the vault is locked, ask the user to run `npm run unlock`".

**What stays.** The MCP server and the CDP filler stay as they are, for agents and browsers outside T3.

**T3 wiring.** Add to `10-cowork.conf`:
```
Environment=T3_KEYCHAIN_URL=http://127.0.0.1:8765
Environment=T3_KEYCHAIN_TOKEN_FILE=/home/t3/.config/bitwarden-agent-keychain/host-token
```
That puts a file path in the unit, not the token itself.

---

## Part 3: the T3 change

### Where it goes

T3 has one automation host. `ServerBrowser` drives both headless tabs and desktop tabs through one Playwright `Page` (`ServerBrowser.ts:1094-1170`, `:3461`). So the tool is added once.

| File | Change |
| --- | --- |
| `packages/contracts/src/previewAutomation.ts` | Add `"fillCredential"` to `PREVIEW_AUTOMATION_SERVER_OPERATIONS` (`:46-54`). Add input and result schemas. |
| `apps/server/src/mcp/toolkits/preview/tools.ts` | Add `preview_fill_credential` to both toolkits (`:233-260`) |
| `apps/server/src/mcp/toolkits/preview/handlers.ts` | Add one handler in the table (`:192-278`) calling `invokeTargeted("fillCredential", …)` |
| `apps/server/src/preview/ServerBrowser.ts` | A `case "fillCredential"` in `executeTabOperation` (`:2775`) that calls the new file. A per-document "evaluated" / "filled" flag, reset on main-frame navigation. A guard in the `evaluate` and `waitFor` cases. |
| `apps/server/src/preview/credentialFill.ts` (new) | Field detection, checks, fill, submit, settle, clear. The detection is ported from this repo's `src/filler.ts`. |
| `apps/server/src/preview/KeychainClient.ts` (new) | `fetch` to `T3_KEYCHAIN_URL` with the host token. |
| `apps/server/src/preview/credentialFill.test.ts` (new) | Real-browser tests in the style of `ServerBrowserPage.test.ts:231`, with a fake keychain HTTP server. |

The edits to existing files stay at a few lines each. `ServerBrowser.ts` is big and changes often upstream, so that's where merge conflicts will happen. Keeping our part there to one `case` that calls into our own file keeps them easy to resolve.

The secret is fetched **inside** the `case`. It never sits in the broker queue or in tool arguments. That matters because the toolkit's tracing span records raw arguments (`McpHttpServer.ts:1145`).

### The tool

```
preview_fill_credential({
  tabId,
  itemId?,          // omit: the keychain matches by the field's frame URL; several matches -> error listing names
  kind?: "login" | "totp",
  username?, password?, code?, submit?   // aria-ref locators from preview_snapshot; omit to auto-detect
})
-> { filled: ["username","password"], submitted: "click" | "enter", outcome: "navigated" | "form_gone" | "cleared", url }
```

### What the `case` does

All of this runs inside the tab's `tab.control.agent(...)` run, so a navigation can't slip in halfway (`ServerBrowser.ts:2751`).

1. **Desktop tabs:** refuse for now (`tab.desktop !== null`). On those, the value would travel over the desktop CDP relay. Headless tabs come first.
2. **Earlier JS:** refuse if `preview_evaluate` has run in this document. Otherwise a script could have put a listener on the field before the fill. Navigating to a new page resets this.
3. **Find the fields.** Use the given refs, or auto-detect.
4. **Check the fields.**
   - The password field must be `input[type=password]`.
   - The code field must be text, tel or number.
   - The form must not be `method=GET`, which would put the password in the URL. URLs show up in `networkEntries` and `preview_status`, unmasked.
5. **Fetch the secret.** Read the frame URL with `ownerFrame().url()` and ask the keychain with it. The keychain does the origin check.
6. **Fill and submit.** Fill, then submit with the given ref, the form's submit button, or Enter.
7. **Settle.** Wait up to 10 s for a navigation or for the field to go away. Otherwise clear it.
8. **Lock the document.** Mark it as filled. Until the next navigation, `preview_evaluate` and `preview_wait_for` with `text` are refused on that tab, because `wait_for` could be used to test guesses.
9. **Errors.** Return fixed error messages. `toOperationError` only keeps the first line of a Playwright error, but the cause object still carries the full error, so never pass a raw Playwright error through. Strip the query string from the returned URL.

Snapshots already mask filled password values (`ServerBrowserPage.ts:258-274`, `:757`), so a `preview_snapshot` mid-fill shows dots. That's the gap Playwright MCP had.

### Remaining gaps, accepted for now

- A page that writes the password into its own console log or text. That's the site's bug.
- An agent clicking "show password" during the at most 10-second settle window. The field is cleared at the end of it.
- `preview_evaluate` after a navigation that stays on the same site, where the app may still hold the value in memory. A stricter rule would block `evaluate` until a navigation to a different site.

### `PATCHES.md` entry

> **preview_fill_credential.** New tool that fills a Bitwarden login from the keychain service into a T3 browser tab. Files: `credentialFill.ts`, `KeychainClient.ts`, small hooks in `previewAutomation.ts`, `tools.ts`, `handlers.ts`, `ServerBrowser.ts`. Still works if: the credentialFill tests pass; with a built server, an agent can log into a local test page with a dummy login, and the password shows up in no preview tool output (snapshot, status, evaluate, wait_for); a fill on a page whose site doesn't match the item is refused; `preview_evaluate` is refused after a fill until the page navigates.

---

## Phases

| # | What | Done when |
| --- | --- | --- |
| 0 | Install toolchain. Create `fork` from `v0.1.10`. Build plain `0.1.10+fork.<sha>` by hand. Install it, then roll back to official `0.1.10`. | Server runs the custom build, rollback works, and build time and peak memory are measured |
| 1 | Deploy script and timer. `T3CODE_RELEASE_BASE_URL` override. Issue alerts. | Moving `deploy` by hand gets installed at 04:00. A deliberately broken build rolls back and opens an issue |
| 2 | Merge agent: clone, T3 project, `.fork/merge-agent.md`, empty `PATCHES.md`, scheduled task. Dry run: start `fork` at the previous stable tag and let the agent merge `v0.1.10`. | One full night with no hands, plus one run where it asks a question you answer from your phone |
| 3 | Keychain service: `/v1/match`, `/v1/secret`, host token, unlock socket, systemd unit. | Tests in this repo, plus `npm run unlock` working against your real vault |
| 4 | The T3 change plus its `PATCHES.md` entry. Developed in `~/code/t3code` on `fork`. | Tests pass, then the agent's nightly check passes and it deploys |
| 5 (later) | A check after each deploy: the timer triggers the agent, which tries the fill with real preview tools on the running server and rolls back if it's broken. | Optional |

## Your calls

1. **Phone push.** Is this T3 environment linked to T3 Connect? Without it, the agent's questions only reach the desktop and web apps, and the GitHub issue becomes your phone channel.
2. **Picking the login.** If the agent passes no `itemId`, the keychain picks by the page's site, like the Bitwarden extension. I think that's right, since the agent then doesn't need the keychain MCP at all.
3. **In-app updates.** OK to turn off the app's "Update" button for this server? Otherwise one tap puts you back on the official build until the next deploy.
