# Installing the keychain as a service

Needs root. The keychain and its browser run as their own user, `keychain`, so agents running as `t3` can't read the vault session, the token store or the browser profile.

## Once

```sh
# 1. User and code. Node 24+ must be at /usr/bin/node (the mise one in ~t3 isn't reachable).
useradd --system --home-dir /var/lib/bitwarden-agent-keychain --shell /usr/sbin/nologin keychain
git clone https://github.com/michal-skoula/bitwarden-agent-keychain /opt/bitwarden-agent-keychain
cd /opt/bitwarden-agent-keychain
npm ci --omit=dev
PLAYWRIGHT_BROWSERS_PATH=/opt/bitwarden-agent-keychain/browsers npx playwright-core install --with-deps chromium

# 2. Units and the admin wrapper.
install -m 0644 deploy/bitwarden-agent-keychain.service deploy/keychain-browser.service /etc/systemd/system/
install -m 0755 deploy/keychain /usr/local/bin/keychain
systemctl daemon-reload
mkdir -p /var/lib/bitwarden-agent-keychain && chown keychain:keychain /var/lib/bitwarden-agent-keychain && chmod 700 /var/lib/bitwarden-agent-keychain

# 3. Bitwarden. Your account 2FA happens here, once.
keychain bw config server https://vault.example.com   # self-hosted only, before login
keychain bw login
keychain setup-session        # asks for the master password, saves only the session key

# 4. Admin login for the web UI.
keychain admin set-password   # username "admin" unless you pass one

# 5. Start.
systemctl enable --now keychain-browser bitwarden-agent-keychain
journalctl -u bitwarden-agent-keychain -f
```

The admin UI listens on `127.0.0.1:8766`, the MCP endpoint on `127.0.0.1:8765/mcp`, and Chromium's CDP on `127.0.0.1:9222`.

## Reverse proxy (Caddy)

Expose the admin UI on its own name, internal only. The keychain sets `Secure` on the session cookie when Caddy forwards `X-Forwarded-Proto: https`, which it does by default.

```
keychain-admin.example {
  reverse_proxy 127.0.0.1:8766
}
```

Agents on this machine use `http://127.0.0.1:8765/mcp` directly. To serve `/mcp` under a name too, add a site for it and set `KEYCHAIN_PUBLIC_URL` and `KEYCHAIN_ALLOWED_HOSTS` in the unit (commented out there).

## When the vault shows as locked

The service refuses to start if the saved session key stops working, which happens after `bw lock` or `bw logout`. The log says so. Fix:

```sh
keychain setup-session
systemctl restart bitwarden-agent-keychain
```

## Updating

```sh
cd /opt/bitwarden-agent-keychain && git pull && npm ci --omit=dev
systemctl restart bitwarden-agent-keychain
```

Pending wipes are in the store, so a restart wipes everything that was still waiting.

## If Chromium won't start

Some kernels don't let an unprivileged service create the sandbox's user namespace. Check `journalctl -u keychain-browser`. As a last resort add `Environment=BROWSER_NO_SANDBOX=1` to `keychain-browser.service`.
