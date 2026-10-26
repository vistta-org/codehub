# VISTTA Code Hub — migration plan

Status: **paused mid-implementation** (2026-10-26). Nothing has been run or tested yet.

Goal: turn Open Code Hub (`../../code-server`, TypeScript + Fastify + Electron) into a
VISTTA project built on `@vistta/js` and `@vistta/js-native`, with:

- a **host app** (desktop) that runs the hub backend and code-server and lets you
  manage sharing, devices and projects;
- **client apps** (Android, Windows, Linux) that pair with a host and open its IDE.

## Decisions taken

| Topic         | Decision                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| Location      | New `vistta/codehub` folder, to become a submodule like `connect/`. Old repo stays untouched. |
| Backend       | Port to plain JavaScript on `@vistta/js/server` (no Fastify, no zod, no TypeScript build).    |
| Shells        | Tauri via js-native everywhere. macOS and iOS are **not** targets.                            |
| Compatibility | Clean break: `VCH_*` env vars, new data folder. A one-time importer for old data is planned.  |
| Pairing       | Host-issued, revocable per-device tokens instead of one shared API token.                     |

## Architecture (as designed so far)

```
Host machine
  Host app (Tauri, js-native) ──► hub backend (Node, @vistta/js/server)
                                   ├─ HTTP  127.0.0.1:8181   always on, host only, trusted
                                   ├─ HTTPS 0.0.0.0:8182     only while sharing; paired devices only
                                   ├─ /api/*                  management API
                                   ├─ /_vch/*                 pairing, tickets, host actions, IDE extension
                                   └─ /*                      proxy ⇢ code-server 127.0.0.1:8281 (HTTP + WS)
Clients (Android / Windows / Linux, js-native)
  pair (QR or address + 6-digit code) ⇢ device token ⇢ one-time ticket ⇢ IDE session cookie ⇢ IDE
```

- code-server always runs on loopback with `--auth none`; the hub is the only way in.
- LAN access: device token (API) or signed session cookie (IDE). Revoking a device ends both.
- Loopback HTTP is treated as the host itself (anyone local can already use the machine).
- Unlike the old app, local and LAN listeners run side by side, so toggling sharing no
  longer restarts the backend; it starts/stops the HTTPS listener and drops remote sockets.

## Done

Framework (`packages/js`, uncommitted in that submodule):

- `server/index.js`: optional `host` bind option (global or per protocol); `start()` can
  restart a stopped protocol without re-attaching Socket.IO/upgrade handlers;
  `stop(protocol, { force: true })` destroys open connections.
- `README.md`: documents the above under "Programmatic Server Usage".

`codehub/` (all unverified — not run, linted or type-checked yet):

- `package.json`, `tsconfig.json`, `.gitignore`, `icon.png`, `LICENSE` (copied, MIT).
- `core/` — ported from the old packages:
  - `config.js` (plain validation replaces zod; `server.port`, `server.lanPort`, `server.share`, `VCH_*` overrides; writes only on-disk values),
  - `logger.js`, `net.js`, `paths.js`, `errors.js`,
  - `supervisor.js` (adds a detached guard that kills code-server if the host dies),
  - `tls.js` (local CA, renamed subject "VISTTA Code Hub Local CA"),
  - `runtime.js` (code-server launcher, always loopback/no auth),
  - `projects.js` (fixes the old `startsWith` path-traversal check), `extensions.js`,
  - `devices.js` (**new**: admin token, pairing codes, hashed device tokens, tickets, HMAC session cookies),
  - `index.js`.
- `hub/workbench.js` — workbench patch ported (`och` → `vch` names); shared storage now
  hashes as an injected loopback authority, since LAN clients use a different port.
- `hub/extension.js` — IDE web extension (status bar, Share on LAN, Pair a Device, host actions).
- `hub/proxy.js` — own HTTP/WS proxy to code-server (HTTP/2-safe headers; serves patched
  workbench, icons, PWA manifest, extension files; can drop remote sockets).

Empty folders created: `web/`, `components/`, `scripts/`, `tests/`, `assets/`, `host/`, `client/`.

## Remaining work

### Phase 1 — hub backend (finish and verify)

1. `hub/api.js`: auth middleware (loopback / admin token / device token / session cookie) and routes:
   health, status, IDE start/stop/restart, projects (list/create/open), extensions, config
   (GET/PATCH), logs, devices (list/revoke), pairing (start/cancel/state, `POST /_vch/pair`),
   tickets (`POST /api/ide/ticket`, `GET /_vch/open?ticket=`), `/_vch/state`, `/_vch/host/:action`, `/ca.crt`.
2. `hub/index.js` (`startHub`): wire config, logger, supervisor, launcher, stores, TLS, the two
   listeners, the proxy (`routes.set("all", "/*")` or middleware — check route priority vs API),
   WebSocket upgrades, `share(enabled)`, graceful shutdown.
3. `server.js`: standalone entry (signals, `VCH_SHARE`), plus `scripts/pair.js` (print code + QR in terminal).
4. Scripts: `install-runtime.js` (port of the `.cjs`), `make-cert.js`, `import.js` (old `data/` → new), `stage-host.js`.
5. Tests (`tests/*.test.js`, `vistta test --environment=node`): config, devices/pairing, projects
   path checks, TLS, workbench patch against the installed runtime, proxy, a lifecycle test.
6. Install deps (`@peculiar/x509`, `qrcode`, `reflect-metadata`) — **needs confirmation**.

### Phase 2 — host app (`host/`, js-native desktop)

- Dashboard pages: IDE status, projects, Share on LAN, pairing (code + QR + CA fingerprint), devices, logs, settings.
- `app.background: true` for tray + hide-on-close; tray shortcuts via `Accessibility.setShortcuts`.
- Start the hub backend, then open the IDE at `http://127.0.0.1:8181` in a second window/the main window.

### Phase 3 — client apps (`client/`, Android/Windows/Linux)

- Hosts list, pairing screen (QR scan on Android, manual address + code), stored device tokens.
- Mobile-friendly project/status view; "Open IDE" via ticket → IDE.

### Phase 4 — docs and workspace

- `codehub/README.md`, `git init`, create the remote, register in `vistta/.gitmodules`,
  workspace README tables, Docker image (optional, as in Connect).

## Open questions / risks — resolve before continuing

1. **Running Node inside the Tauri host.** js-native has no sidecar support. Options:
   (a) spawn the hub with the Node bundled in `runtime/code-server/lib/node` via the Shell
   plugin (needs a scoped `shell:allow-spawn` entry and the `@vistta/cli` loader, because
   `@vistta/js/server` imports `with { type: "bundler" }`); (b) add sidecar/`externalBin`
   support to js-native; (c) require a system Node.
   - Go with: (a)
2. **Tauri webview loading the IDE** (remote `http://127.0.0.1` origin): which capabilities the
   window gets for a remote URL, CSP, whether IPC must be denied to the IDE origin. Likely needs
   js-native support for multiple windows / remote URLs.
3. **Linux WebKitGTK** for VS Code webviews and service workers (Chat, extensions) — unverified.
   WebView2 (Windows) and Android WebView are Chromium. Plan a fallback (open in browser).
4. **Android trust of the local CA**: Android ignores user CAs by default. js-native has no
   `network_security_config` patch; it needs one (pin the host CA or allow user CAs), or the
   client must pin the fingerprint from the pairing QR.
5. **Discovery**: QR/manual only for now; mDNS later?
6. **Licence**: copied MIT from Open Code Hub; Connect uses Apache 2.0 + Commons Clause,
   packages are GPL-3.0-only.
   - Go with the same as codium.
7. **Proxy routing in `@vistta/js/server`**: confirm a catch-all route or middleware can forward
   every method/path (incl. HTTP/2 requests and non-`.js` "resource" paths) without the
   framework's own page/resource handling getting in the way; WS upgrades go through
   `routes.set("websocket", "/*", ...)`.
8. **Framework changes** in `packages/js` need review, a test, and a commit in that submodule.
