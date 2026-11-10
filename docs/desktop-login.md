# Desktop browser sign-in

The desktop app opens `/desktop-login` in the system browser. Users sign in on the website (or reuse their existing website session), confirm the displayed account, and allow the browser to open `piwork://auth/callback`. The desktop main process exchanges the authorization code and notifies the UI to reload the account and model catalog.

- Each attempt has a random state and an S256 PKCE challenge. The verifier remains in the main process and is stored with Electron `safeStorage` so a pending login can survive an app restart for up to ten minutes.
- Website confirmation creates a 60-second authorization code. Only its hash is stored in `DesktopLoginGrant`. Exchange checks the PKCE proof and atomically deletes the grant; concurrent exchange and replay fail.
- The callback contains only the code and state. The main process receives a fresh Auth.js session over HTTPS and installs an HttpOnly cookie in the existing account partition. Neither the renderer nor the Pi worker receives the cookie or verifier.
- Account changes are blocked during an active chat or sync operation. Invalid or unsolicited callbacks are ignored. Failed exchanges preserve the previous account. Signing out of the desktop does not sign out the browser.

## Shipping

Deploy the website with migration `0027_desktop_browser_login.sql`, then distribute the updated desktop app. Its electron-builder configuration registers the `piwork` URL scheme. On macOS, test the installed app bundle for OS-level browser handoff; the generic development Electron bundle does not provide the installed app's URL registration. Local development servers may use HTTP on loopback addresses; other servers require HTTPS.

No new environment variables or Pi SDK changes are required. Existing `AUTH_SECRET` and database configuration remain in use.

## Verification

From the website repository, with the local server running and its environment loaded:

```sh
node --conditions=react-server --import tsx --test tests/unit/auth/desktop-login.test.ts
node --env-file=.env --import tsx tests/e2e/desktop-login-http.mts
node --env-file=.env --import tsx tests/e2e/desktop-login-browser.mts
```

The browser test expects the desktop repository at `../piwork-desktop` (override with `DESKTOP_REPO`), a built desktop app, and Google Chrome. `DESKTOP_TEST_URL` overrides the local website URL. It uses temporary accounts and profiles, exercises the real website and Electron IPC, and delivers the custom URL through Electron's OS event handler. Installed-app Launch Services registration requires a separate macOS check.

From the desktop repository:

```sh
pnpm build
node --test tests/account-login.test.mjs
node tests/account-e2e.mjs
node tests/web-history-e2e.mjs
node tests/sync-desktop-e2e.mjs
```
