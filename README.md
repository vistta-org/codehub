# Vistta Code Hub

Self-hosted code-server IDE. One desktop app (Windows/Linux) runs the IDE on
this computer and opens IDEs on other computers it has paired with; the
Android app is a client only (it cannot run code-server's Node 24 runtime).
The hub backend manages the IDE, projects, extensions, pairing, LAN sharing and
the paired remote hosts; the IDE extension provides host management inside the IDE.

## Architecture

```
Each desktop (one app, both roles)
  Desktop app (Tauri, js-native) ──► hub backend (Node, one TCP HTTP/HTTPS port)
                                      ├─ HTTP  127.0.0.1:8181   always on, this computer only, trusted
                                      ├─ HTTPS LAN:8181         only while sharing; paired devices only
                                      ├─ /api/*                  management API (incl. /api/remotes)
                                      ├─ /_vch/*                 pairing, tickets, host actions, IDE extension
                                      ├─ /*                      proxy ⇢ code-server 127.0.0.1:8281 (HTTP + WS)
                                      └─ 127.0.0.1:83xx          one relay per paired remote host ⇢ its HTTPS hub port
Android client (client/, js-native)
  pair (QR or address + 6-digit code) ⇢ pin the host's CA ⇢ device token ⇢ one-time ticket ⇢ IDE session cookie ⇢ IDE
```

- code-server always runs on loopback with `--auth none`; the hub is the only way in.
- One TCP listener distinguishes HTTP from TLS on `server.port` (default `8181`).
  Plain HTTP is accepted only from loopback peers; non-loopback HTTP is dropped.
  HTTPS connections are accepted only while sharing is on. Stopping sharing closes
  HTTPS sessions without disconnecting local HTTP or restarting the IDE.
- Loopback HTTP is the trusted host interface: no tokens for local callers,
  admin-level actions included. HTTPS accepts paired device tokens or the
  signed IDE session cookie only — for the API **and** the proxied IDE (HTTP + WebSocket);
  only the pairing page, PWA manifest and icons are public. Revoking a device ends both.
- The desktop app talks to the loopback API through CORS (`tauri://localhost` origins
  only) and reports itself with the `x-vch-request: 1` proof header for host actions.
- Remote hosts (`hub/remotes.js`): the local hub pairs with another hub over HTTPS,
  pins that host's local CA (trust on first use; the SHA-256 fingerprint is shown on
  both sides, and a fingerprint in the pairing QR is checked), stores the device token
  in `remotes.json` in the data folder, and serves the remote IDE from a loopback relay
  that adds the token. The webview never sees the token and needs no TLS trust. Relays
  accept only requests addressed to themselves and same-origin writes/WebSockets.

## Getting started

```powershell
Set-Location .\codehub
npm install
npm run install-runtime   # downloads code-server + bundled extensions
npm run cert              # creates/renews the local CA, prints the SHA-256 fingerprint
npm start                 # hub on http://127.0.0.1:8181 (IDE autostarts)
```

`@vistta/*` dependencies use npm versions. `@vistta/js`, `@vistta/js-native` and
`@vistta/ui` are not on npm yet, so inside the Vistta workspace link the local
packages instead of a plain `npm install`:

```powershell
npm link ../packages/cli ../packages/console ../packages/css ../packages/datetime ../packages/fs ../packages/js ../packages/js-native ../packages/ui ../packages/utils
```

A checkout outside the workspace can't install until those three are published.

Open `http://127.0.0.1:8181` in a browser: that is the IDE, proxied through the hub.
The Code Hub extension uses the browser IDE's origin for status and host actions,
including `localhost`, remote relays and LAN HTTPS sessions.
To reuse a code-server installation elsewhere instead of downloading it, set
`VCH_RUNTIME_DIR` to the absolute path of its `code-server` directory before
`npm start` (for example, `$env:VCH_RUNTIME_DIR = 'C:\path\to\runtime\code-server'`
in PowerShell).
Useful scripts:

| Command          | Purpose                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `npm start`      | Run the hub backend standalone.                                                |
| `npm run server` | Run the hub with watching enabled (development).                               |
| `npm run pair`   | Print the current pairing code and QR (pairing must be opened in the app/CLI). |
| `npm run cert`   | Create/renew the local CA for LAN HTTPS.                                       |
| `npm run import` | Import data from an old Open Code Hub install.                                 |
| `npm test`       | Run the full backend test suite.                                               |

## Desktop app

AI utility tasks, including commit-message generation, default to the selected
BYOK chat model (such as Ollama) once a chat request has initialized it.
The Source Control generate-message button calls the generator without opening
GitHub setup first. Explicit utility-model
settings still take precedence; change `chat.byokUtilityModelDefault` to override
this app default.

The app is just the IDE: a frameless window whose title bar is VS Code's own,
with minimize/maximize/close and window dragging added by `hub/titlebar.js`
(the hub adds it to the workbench page; it does nothing in a plain browser).
The title bar and Welcome tab show the app icon (`assets/icon.png`, or
`icon.png` in the data folder to override it).

Everything else lives in the **Code Hub** status-bar menu (Local only / LAN):

- **Share on LAN**, **Pair a Device** (code, browser pairing link, QR and certificate fingerprint),
  projects, paired devices, extensions, logs and host settings.
- **Other Computers** — **Add Computer…** asks for the other computer's address
  (`192.168.1.20` or `host:8181`) and the pairing code shown there, then shows
  the certificate fingerprint to compare with that computer. Picking a computer
  offers **Open IDE** (its IDE opens in its own window) or **Forget** (the other
  computer revokes this device and the token is deleted).

Only the local IDE can change host settings; IDEs opened on other computers
cannot. Closing IDE windows leaves the app in the tray. **Show / Hide** toggles
only the local IDE window, leaving remote IDE windows alone; there is no
duplicate Open IDE action. **Settings** shows the local IDE and opens its
Settings editor filtered to `@ext:vistta.code-hub`. **Pair Device** shows the local
IDE and opens its pairing code and QR panel. LAN sharing remains available in
the IDE's Code Hub menu and Settings.

All Code Hub settings live together in that editor: LAN sharing, login startup,
host name, projects root, HTTP / HTTPS port, IDE port, log level and workspace
trust. Changes apply to the host configuration; the HTTP / HTTPS port requires
a host restart. The status-bar menu and **Host Settings** command open the same
view, with no separate settings window or quick picker.

**Start Minimized** keeps the desktop app hidden in the tray on every launch,
including manual launches. The hub and IDE still start; use **Show / Hide** in
the tray to open the IDE. It is off by default and independent of **Start At Login**.
The **Share on LAN** on/off state is saved and restored on the next launch;
quitting the app stops sharing without clearing that preference.

On Windows and Linux, **Code Hub: Start At Login** opts the
current OS user into automatic startup. It is off by default, reads its state
from the OS, and can be disabled again in the same editor. The bundled desktop
controller performs registration; IDE windows never receive native startup
permissions. This setting is machine-local and excluded from Settings Sync.
It starts the desktop app after login, not a pre-login service.
Use the installed executable (or a persistent AppImage path), not a temporary
development build, when enabling it.

```powershell
npm run dev            # starts hub + IDE, then opens the IDE window and tray
npm run build:windows  # stage payload + NSIS installer (npm run build:linux for Linux)
```

On Linux, `build:windows` cross-compiles the installer (MinGW + NSIS, as in the
`vistta/runner` image) after `npm run install-runtime -- --platform windows`
downloads the Windows code-server runtime. A cross-platform runtime cannot be
smoke-tested on the build host.

How the app runs the backend:

- **Development** (`npm run dev`): one command starts the backend and IDE, waits
  for the IDE to become ready, then builds and opens the IDE window and
  tray. Quitting the desktop app from the tray stops the backend started
  by this command. Set `VCH_RUNTIME_DIR` if the runtime is outside `codehub/runtime`;
  the script also detects the sibling `code-server/runtime` in this workspace.
  `npm run server` remains available for running only the backend with watching.
- **Bundled** (`npm run build:*`): `scripts/stage.js` stages
  `assets/`, `core/`, `hub/`, `scripts/`, `server.js`, its runtime `node_modules/` and the
  code-server `runtime/` as Tauri resources. The app spawns `server.js` with
  the Node bundled in those resources through a scoped Tauri shell command,
  stores persistent data under the app-data directory, and waits for `/api/health`.
  The backend watches the app process and shuts down (IDE included) as soon as the app
  is gone, whether it quit or crashed.

The `main` webview is hidden: it starts the hub, owns the tray and the app IPC,
and opens IDE windows (`app/ide-window.js`, label `ide` for this computer and
`ide-remote-<id>` for others). IDE windows load `http://127.0.0.1:<port>/` and
hold only the `ide-window-controls` capability (`app/setup.js`): minimize,
toggle maximize, is-maximized, close and start-dragging. Any other command is
refused by Tauri's ACL. The Code Hub web extension is installed into the local
code-server extensions directory, independently of optional workbench patches.
If an IDE window cannot be created, a remote IDE falls back to the system browser.

Configuration lives in `data/config.json` with `VCH_*` environment overrides
(see `core/config.js`); packaged hosts use their app-data directory instead.
The IDE extension's Host Settings command edits the corresponding file.
`server.port` / `VCH_SERVER_PORT` controls both HTTP and HTTPS; changing it requires
a host restart. Legacy `server.lanPort` fields are removed during config validation
with a warning. Remove `VCH_LAN_PORT` from the environment; it is no longer supported.
Existing saved remote addresses keep their explicit ports: update or re-pair them
if the remote host moved from `8182` to `8181`. Internal IDE and relay ports stay separate.
Pairing QR codes and links use `https://host:8181/pair?code=…` on the first
available LAN HTTPS URL; a browser opening the link receives a revocable IDE
session cookie, while the Android app uses the same link for native pairing.
Turn on Share on LAN before opening the link or scanning, or enter the host's
address and code manually.

## Android app (client)

`client/` is a client-only Android app styled like VS Code's side bar (Dark
Modern colours with the logo orange as accent; the IDE gets the same accent by
default through the Code Hub extension unless you set your own
`workbench.colorCustomizations`). Its **Computers** tree lists the computers this phone paired
with and each one's IDE state (running, stopped, offline, unpaired); expanding a
computer shows **Open IDE**, its **Projects** and **Forget**. Errors appear as
notifications that explain unreachable or untrusted computers and keep the
native message as a detail. Pairing: on the computer turn on **Share on LAN**
and choose **Pair a Device**, then on the phone **Scan QR Code** (a camera view
with **Cancel**; checks the certificate fingerprint in the QR) or **Enter
Address** (shows the fingerprint for you to compare).

```powershell
npm run client:android  # dev build on a connected device (adb)
npm run build:android   # release APK in dist/ (keystore auto-generated unless ANDROID_KEYSTORE is set)
```

Android does not trust each hub's own CA, so the app pins it per computer with
js-native's `Pinned` bridge: API calls go through native HTTPS that trusts only
that CA, and the IDE opens in a separate full-screen WebView that accepts only
certificates signed by it and has no app bridges. QR scanning uses Tauri's
barcode-scanner plugin (camera permission requested on first scan). The device
token and pinned CA stay in the app's private storage; **Forget** asks the
computer to revoke the device and deletes them.

## API overview

Management API under `/api/*` (auth levels `public`/`device`/`local` per route;
see `hub/api.js`): health/status, IDE lifecycle, projects, extensions, config,
logs, devices/pairing, remote hosts (`GET /api/remotes`, `POST /api/remotes/pair`,
`GET /api/remotes/:id/status`, `POST /api/remotes/:id/open`, `DELETE /api/remotes/:id`;
this computer only, writes need the proof header) and `DELETE /api/device` (a paired
device unpairs itself). Browser pairing `GET /pair?code=…` creates a device and
sets its IDE session cookie directly. Native pairing handshake `POST /_vch/pair`
(public; the 6-digit code is the credential), ticket exchange `POST /api/ide/ticket` +
`GET /_vch/open?ticket=` for the IDE session cookie, `GET /ca.crt` for the
public CA, `POST /_vch/host/:action` (loopback + proof header) for host actions
(`openRemote` only accepts the running relay URL of a paired computer).

## Docker host

`docker/Dockerfile` packages the hub as a headless host for remote use (no
desktop app or IDE runtime is needed on the client; the hub serves code-server
itself). Build it from the staged payload:

```powershell
npm run stage -- --target=build/docker   # add --no-runtime to skip the code-server runtime
docker build -f docker/Dockerfile -t vistta/codehub build/docker
```

Run it with `docker/docker-compose.yml` (image, port `VCH_PORT` default 8181,
`VCH_NAME`, and the `/data` and `/projects` volumes) or with plain `docker run`:

```powershell
docker run -d -p 8181:8181 -e VCH_SHARE=true -v codehub-data:/data -v codehub-projects:/projects vistta/codehub
```

Remote access needs `VCH_SHARE=true` (the LAN HTTPS listener). Plain HTTP is only
accepted from loopback, so published ports always use HTTPS. Pair a device with
`docker compose exec codehub node scripts/pair.js`, or open `/pair` in a browser.
The certificate covers the container hostname and interface IPs; for a public
hostname set `VCH_TLS_CERT` and `VCH_TLS_KEY` together.

## Release pipeline

`.gitea/workflows/release.yml` follows the packages' release workflow. Start it
manually from `main` with a **type**: `Manual` (default; releases the version in
`package.json` as-is) or `Patch`/`Minor`/`Major`/`Beta`/`Alpha` to run
`npm version` first, which commits, tags and pushes the bump. The pipeline:

1. **Validation**: `npm run setup:ci` in the workspace, then `npm test`.
2. **Release**: AI release notes from the commits since the last `v*` tag
   (`AI_BASE_URL`/`AI_MODEL` variables, `AI_API_KEY` secret), the version step,
   a milestone for closed issues, and a draft release `vX.Y.Z`.
3. **Windows**, **Linux**, **Android**, **Docker**: build in parallel on Linux
   runners (Windows is cross-compiled in `vistta/runner`) and upload their
   artifacts to the draft. The Docker job pushes `vX.Y.Z` and `latest` to
   `git.vistta.org/vistta/codehub` and attaches a `docker save` archive.
4. **Publish**: marks the release public only after every build job succeeds.

The Docker tags are pushed before publishing, so a failed later job can leave
them live while the release stays a draft.

## Tests

```powershell
npm test: Android client, config, devices, IDE extension, hub lifecycle, projects, router, tls, workbench
```

The suite boots real hubs on free ports, exchanges real pairing codes over HTTP,
starts the installed code-server runtime (checking the title-bar script and app
icon on the real workbench page), toggles the HTTPS LAN listener, and pairs two
hubs end to end through the remote-host relay.

## Licence

MIT — see [LICENSE](LICENSE).
