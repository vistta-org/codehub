/**
 * Hub lifecycle: shared HTTP/HTTPS port, sharing toggle, pairing and full
 * IDE start through the installed runtime. Skipped when the runtime is absent
 * (CI machines) - everything else here is pure Node HTTP.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findFreePort, lanAddresses } from "../core/net.js";
import { killTree } from "../core/supervisor.js";
import { startHub } from "../hub/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(os.tmpdir(), `vch-hub-${randomUUID()}`);
const runtime = process.env.VCH_RUNTIME_ROOT_TEST
  ? path.resolve(process.env.VCH_RUNTIME_ROOT_TEST)
  : path.join(ROOT, "..", "..", "code-server", "runtime");
const hasRuntime = fs.existsSync(path.join(runtime, "code-server", "package.json"));

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any }} [options]
 */
function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url.replace(/^https:/, "http:"), { method, headers }, resolve);
    request.on("error", reject);
    if (body) request.end(JSON.stringify(body));
    else request.end();
  });
}

suite("hub lifecycle", () => {
  let portChain = Promise.resolve();
  const uniquePorts = () => {
    const allocate = async () => {
      const port = await findFreePort(20000 + Math.floor(Math.random() * 8000));
      const idePort = await findFreePort(port + 100);
      return { port, idePort };
    };
    // The test runner starts tests eagerly; serialize port allocation so no
    // two boots race onto the same port.
    const result = portChain.then(allocate);
    portChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  async function boot(options = {}) {
    const ports = await uniquePorts();
    return startHub({
      dataDir: `${dataDir}-${randomUUID()}`,
      runtimeRoot: runtime,
      startIde: false,
      startShare: false,
      ...ports,
      ...options,
    });
  }

  test("start: loopback listener answers health and admin endpoints, stops cleanly", async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    const hub = await boot();
    try {
      const health = await request(`http://127.0.0.1:${hub.config.server.port}/api/health`);
      assert.equal(health.statusCode, 200);
      const body = JSON.parse(await collect(health));
      assert.equal(body.ok, true);
      assert.equal(body.sharing, false);
      assert.equal(typeof body.version, "string");
      assert.equal(body.lanUrls.length, 0);
      const extensionsDir = path.join(hub.dataDir, "ide", "extensions");
      const installed = JSON.parse(fs.readFileSync(path.join(extensionsDir, "extensions.json"), "utf8"));
      assert.ok(installed.some((entry) => entry.identifier.id === "vistta.code-hub"));
      assert.ok(fs.existsSync(path.join(extensionsDir, "vistta.code-hub-0.1.4", "extension.js")));
      // devices: host-only endpoint works locally without tokens
      const devices = await request(`http://127.0.0.1:${hub.config.server.port}/api/devices`);
      assert.equal(devices.statusCode, 200);
    } finally {
      await hub.stop();
    }
    await assert.rejects(() => request(`http://127.0.0.1:${hub.config.server.port}/api/health`));
  });

  test("unknown API routes return JSON 404s, never the IDE proxy", async () => {
    const hub = await boot();
    try {
      const missing = await request(`http://127.0.0.1:${hub.config.server.port}/api/definitely/not/here`);
      assert.equal(missing.statusCode, 404);
      const body = JSON.parse(await collect(missing));
      assert.equal(body.error.code, "not_found");
    } finally {
      await hub.stop();
    }
  });

  test("desktop settings and LAN sharing survive restarts, including an explicit stop", async () => {
    let hub = await boot();
    const savedDataDir = hub.dataDir;
    const savedConfig = () => JSON.parse(fs.readFileSync(path.join(savedDataDir, "config.json"), "utf8"));
    try {
      await hub.updateConfig({ desktop: { startMinimized: true } });
      await hub.hostAction("share");
      assert.equal(hub.sharing(), true);
      assert.equal(hub.config.server.share, true);
      assert.equal(savedConfig().server.share, true);
      await hub.stop();
      assert.equal(savedConfig().server.share, true, "shutdown must not clear the sharing preference");

      hub = await boot({ dataDir: savedDataDir, startShare: undefined });
      assert.equal(hub.sharing(), true);
      assert.equal(hub.config.desktop.startMinimized, true);
      await hub.hostAction("stopSharing");
      assert.equal(hub.sharing(), false);
      assert.equal(hub.config.server.share, false);
      assert.equal(savedConfig().server.share, false);
      await hub.stop();

      hub = await boot({ dataDir: savedDataDir, startShare: undefined });
      assert.equal(hub.sharing(), false);
      assert.equal(hub.config.desktop.startMinimized, true);
    } finally {
      await hub.stop();
    }
  });

  test("desktop app origins get CORS headers and preflight answers", async () => {
    const hub = await boot();
    try {
      // Preflight for the dashboard's host-action POSTs.
      const probe = await request(`http://127.0.0.1:${hub.config.server.port}/api/health`, {
        method: "OPTIONS",
        headers: { origin: "http://tauri.localhost", "access-control-request-method": "POST" },
      });
      assert.equal(probe.statusCode, 204);
      assert.equal(probe.headers["access-control-allow-origin"], "http://tauri.localhost");
      assert.match(probe.headers["access-control-allow-headers"], /x-vch-request/);
      // Plain requests echo the origin; other origins get nothing.
      const health = await request(`http://127.0.0.1:${hub.config.server.port}/api/health`, {
        headers: { origin: "http://tauri.localhost" },
      });
      const body = JSON.parse(await collect(health));
      assert.equal(body.ok, true);
      assert.equal(health.headers["access-control-allow-origin"], "http://tauri.localhost");
      const hostile = await request(`http://127.0.0.1:${hub.config.server.port}/api/health`, {
        headers: { origin: "https://evil.example" },
      });
      await collect(hostile);
      assert.equal(hostile.headers["access-control-allow-origin"], undefined);
      // Remote (HTTPS) listener never gets CORS from the hub.
      await hub.share(true);
      const lan = await new Promise((resolve, reject) => {
        const lanRequest = https.request(
          `https://127.0.0.1:${hub.config.server.port}/api/health`,
          { method: "GET", headers: { origin: "http://tauri.localhost" }, rejectUnauthorized: false },
          resolve,
        );
        lanRequest.on("error", reject);
        lanRequest.end();
      });
      await collect(lan);
      assert.equal(lan.headers["access-control-allow-origin"], undefined);
      await hub.share(false);
    } finally {
      await hub.stop();
    }
  });

  test("pairing over HTTP loopback: code becomes token, token scopes to device routes", async () => {
    const hub = await boot();
    try {
      const opened = await request(`http://127.0.0.1:${hub.config.server.port}/api/devices/pairing`, { method: "POST" });
      assert.equal(opened.statusCode, 200);
      const { pairing } = JSON.parse(await collect(opened));
      assert.match(pairing.code, /^\d{6}$/);
      const paired = await request(`http://127.0.0.1:${hub.config.server.port}/_vch/pair`, {
        method: "POST",
        body: { code: pairing.code, name: "TestClient", platform: "browser" },
      });
      assert.equal(paired.statusCode, 200);
      const granted = JSON.parse(await collect(paired));
      assert.ok(granted.token);
      assert.equal(granted.device.name, "TestClient");
      // The device token grants device-level endpoints.
      const projects = await request(`http://127.0.0.1:${hub.config.server.port}/api/projects`, {
        headers: { authorization: `Bearer ${granted.token}` },
      });
      assert.equal(projects.statusCode, 200);
      assert.ok(Array.isArray(JSON.parse(await collect(projects))));
      // Without any token, device endpoints are refused even on loopback auth:
      // pairing is free but the API is not for unauthenticated callers.
      const anonymous = await request(`http://127.0.0.1:${hub.config.server.port}/api/devices/pairing`, { method: "POST" });
      assert.equal(anonymous.statusCode, 200, "pairing open stays host-local; loopback is trusted");
    } finally {
      await hub.stop();
    }
  });

  test("wrong pairing code is refused and consumes an attempt", async () => {
    const hub = await boot();
    try {
      await request(`http://127.0.0.1:${hub.config.server.port}/api/devices/pairing`, { method: "POST" });
      const wrong = await request(`http://127.0.0.1:${hub.config.server.port}/_vch/pair`, {
        method: "POST",
        body: { code: "000000", name: "Bad" },
      });
      assert.equal(wrong.statusCode, 403);
      const body = JSON.parse(await collect(wrong));
      assert.equal(body.error.code, "invalid_code");
    } finally {
      await hub.stop();
    }
  });

  test("IDE start through the installed runtime and the proxy serves it", async () => {
    if (!hasRuntime) return "skipped: no code-server runtime installed";
    const hub = await boot({ startIde: true });
    try {
      assert.equal(hub.launcher.status().state, "running");
      const started = await request(`http://127.0.0.1:${hub.config.server.port}/api/ide/start`, { method: "POST" });
      assert.equal(started.statusCode, 200);
      const through = await request(`http://127.0.0.1:${hub.config.server.port}/healthz`);
      assert.equal(through.statusCode, 200);
      await collect(through);
      const page = await request(`http://127.0.0.1:${hub.config.server.port}/`, {
        headers: { accept: "text/html", "accept-encoding": "gzip" },
      });
      const html = await collect(page);
      assert.equal(page.statusCode, 200);
      assert.equal(page.headers["content-encoding"], undefined, "the page is rewritten uncompressed");
      assert.ok(html.includes('<script src="/_vch/titlebar.js" defer></script>'), "title-bar script injected");
      assert.equal(Number(page.headers["content-length"]), Buffer.byteLength(html));
      const script = await request(`http://127.0.0.1:${hub.config.server.port}/_vch/titlebar.js`);
      assert.match(await collect(script), /plugin:window\|/);
      const commit = html.match(/(stable-[0-9a-f]+)\/static\//)?.[1];
      assert.ok(commit, "workbench static base found");
      const icon = await request(`http://127.0.0.1:${hub.config.server.port}/${commit}/static/out/media/code-icon.svg`);
      assert.equal(icon.headers["content-type"], "image/png", "the app icon replaces the code-server one");
      await collect(icon);
      await hub.share(true);
      await hub.share(false);
      assert.equal(hub.launcher.status().state, "running", "stopping sharing keeps the local IDE running");
    } finally {
      await hub.stop();
    }
  });

  test("host browser actions reach the desktop app or fall back to the system browser", async () => {
    const actions = [];
    const opened = [];
    let handled = true;
    const hub = await boot({
      hostAction: (action) => {
        actions.push(action);
        return handled;
      },
      openExternal: (url) => {
        opened.push(url);
      },
    });
    try {
      hub.hostAction("openInBrowser");
      assert.deepEqual(actions, ["openInBrowser"]);
      assert.deepEqual(opened, []);
      handled = false;
      hub.hostAction("openInBrowser");
      assert.deepEqual(opened, [`http://127.0.0.1:${hub.config.server.port}`]);
    } finally {
      await hub.stop();
    }
  });

  test("LAN listener: the IDE needs a device credential, branding assets do not", async () => {
    const lanDir = `${dataDir}-lan`;
    fs.rmSync(lanDir, { recursive: true, force: true });
    const hub = await boot({ dataDir: lanDir });
    try {
      await hub.share(true);
      const lan = `https://127.0.0.1:${hub.config.server.port}`;
      const anonymous = await secure(`${lan}/`);
      assert.equal(anonymous.statusCode, 401);
      await collect(anonymous);
      const manifest = await secure(`${lan}/manifest.json`);
      assert.equal(manifest.statusCode, 200);
      await collect(manifest);
      const opened = await request(`http://127.0.0.1:${hub.config.server.port}/api/devices/pairing`, { method: "POST" });
      const { pairing, fingerprint, link } = JSON.parse(await collect(opened));
      assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      assert.equal(new URL(link).port, String(hub.config.server.port));
      assert.equal(new URL(link).pathname, "/pair");
      const browser = await secure(link, { headers: { accept: "text/html" } });
      assert.equal(browser.statusCode, 302);
      assert.equal(browser.headers.location, "/");
      const sessionCookie = browser.headers["set-cookie"][0];
      assert.match(sessionCookie, /^vchSession=.*; HttpOnly; Secure;/);
      await collect(browser);
      const browserSession = await secure(`${lan}/`, { headers: { cookie: sessionCookie.split(";")[0] } });
      assert.notEqual(browserSession.statusCode, 401);
      await collect(browserSession);
      const reused = await secure(`${lan}/pair?code=${encodeURIComponent(pairing.code)}`, {
        headers: { accept: "text/html" },
      });
      assert.equal(reused.statusCode, 403, "the pairing code is single use");
      await collect(reused);
      const paired = await request(`http://127.0.0.1:${hub.config.server.port}/api/devices/pairing`, { method: "POST" });
      const { pairing: nextPairing } = JSON.parse(await collect(paired));
      const native = await secure(`${lan}/_vch/pair`, { method: "POST", body: { code: nextPairing.code, name: "Lan" } });
      const { token } = JSON.parse(await collect(native));
      const allowed = await secure(`${lan}/`, { headers: { authorization: `Bearer ${token}` } });
      assert.notEqual(allowed.statusCode, 401, "a paired device reaches the IDE proxy");
      await collect(allowed);
      const upgraded = await new Promise((resolve, reject) => {
        const attempt = https.request(`${lan}/`, {
          rejectUnauthorized: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        });
        attempt.on("upgrade", () => resolve("upgraded"));
        attempt.on("response", (response) => resolve(response.statusCode));
        attempt.on("error", () => resolve("closed"));
        attempt.on("close", () => resolve("closed"));
        attempt.end();
        setTimeout(() => reject(new Error("upgrade did not settle")), 5000);
      });
      assert.equal(upgraded, "closed", "anonymous WebSockets are dropped");
    } finally {
      await hub.stop();
    }
  });

  test("remote hosts: pair over HTTPS with a pinned CA, relay adds the token, forget revokes", async () => {
    const hostDir = `${dataDir}-host`;
    const clientDir = `${dataDir}-client`;
    for (const dir of [hostDir, clientDir]) fs.rmSync(dir, { recursive: true, force: true });
    const host = await boot({ dataDir: hostDir });
    const client = await boot({ dataDir: clientDir });
    try {
      await host.share(true);
      const hostApi = `http://127.0.0.1:${host.config.server.port}`;
      const clientApi = `http://127.0.0.1:${client.config.server.port}`;
      const { pairing, fingerprint } = JSON.parse(
        await collect(await request(`${hostApi}/api/devices/pairing`, { method: "POST" })),
      );
      const body = { address: `127.0.0.1:${host.config.server.port}`, code: pairing.code, fingerprint };

      const unproven = await request(`${clientApi}/api/remotes/pair`, { method: "POST", body });
      assert.equal(unproven.statusCode, 403, "pairing from the app needs the proof header");
      await collect(unproven);
      const paired = await request(`${clientApi}/api/remotes/pair`, {
        method: "POST",
        body,
        headers: { "x-vch-request": "1" },
      });
      const remote = JSON.parse(await collect(paired));
      assert.equal(paired.statusCode, 200, JSON.stringify(remote));
      assert.equal(remote.fingerprint, fingerprint);
      assert.equal(remote.token, undefined, "the token never leaves the hub process");
      assert.equal(remote.ca, undefined, "the pinned CA never leaves the hub process");
      assert.equal(host.devices.list().length, 1);

      const listed = JSON.parse(await collect(await request(`${clientApi}/api/remotes`)));
      assert.equal(listed.remotes.length, 1);
      assert.equal(listed.remotes[0].token, undefined);
      assert.equal(listed.remotes[0].ca, undefined);
      const status = JSON.parse(await collect(await request(`${clientApi}/api/remotes/${remote.id}/status`)));
      assert.equal(status.online, true);
      assert.equal(status.paired, true);

      const port = await client.remotes.relay(remote.id);
      const relay = `http://127.0.0.1:${port}`;
      const through = await request(`${relay}/api/status`);
      assert.equal(through.statusCode, 200, "the relay authenticates as the paired device");
      await collect(through);
      const ide = await request(`${relay}/`);
      assert.notEqual(ide.statusCode, 401);
      await collect(ide);
      const rebound = await request(`${relay}/api/status`, { headers: { host: `evil.example:${port}` } });
      assert.equal(rebound.statusCode, 403, "foreign Host headers are refused (DNS rebinding)");
      await collect(rebound);
      const forged = await request(`${relay}/api/projects`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: { name: "x" },
      });
      assert.equal(forged.statusCode, 403, "cross-origin writes are refused (CSRF)");
      await collect(forged);

      const forgot = await request(`${clientApi}/api/remotes/${remote.id}`, { method: "DELETE" });
      assert.equal(forgot.statusCode, 200);
      await collect(forgot);
      assert.equal(host.devices.list().length, 0, "forgetting a host revokes the device there");
      await assert.rejects(() => request(`${relay}/api/status`), "the relay closes");
    } finally {
      await client.stop();
      await host.stop();
    }
  });

  test("host app mode: the hub and its IDE stop when the owning app dies", async () => {
    const ownedDir = `${dataDir}-owned`;
    fs.rmSync(ownedDir, { recursive: true, force: true });
    const { port, idePort } = await uniquePorts();
    const env = {
      ...process.env,
      VCH_DATA_DIR: ownedDir,
      VCH_RUNTIME_ROOT: runtime,
      VCH_SERVER_PORT: String(port),
      VCH_IDE_PORT: String(idePort),
      VCH_SHARE: "false",
      VCH_HOST_ACTIONS_FILE: "1",
      VCH_IDE_AUTOSTART: hasRuntime ? "true" : "false",
    };
    // Stand-in for the desktop app: spawns the hub, then gets killed outright.
    // `detached` matches Tauri: Node would otherwise tie the child to its own job (Windows).
    const owner = spawn(
      process.execPath,
      [
        "-e",
        `const hub = require("node:child_process").spawn(process.execPath, [${JSON.stringify(path.join(ROOT, "server.js"))}], { stdio: "ignore", detached: true, windowsHide: true }); console.log(hub.pid); setInterval(() => {}, 1e6);`,
      ],
      { env, stdio: ["ignore", "pipe", "ignore"] },
    );
    const hubPid = await new Promise((resolve) => owner.stdout.once("data", (data) => resolve(Number(String(data).trim()))));
    const health = `http://127.0.0.1:${port}/api/health`;
    try {
      const deadline = Date.now() + 90_000;
      let ide;
      while (Date.now() < deadline) {
        const body = await request(health)
          .then(collect)
          .catch(() => null);
        ide = body && JSON.parse(body).ide?.state;
        if (ide === (hasRuntime ? "running" : "stopped")) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(ide, hasRuntime ? "running" : "stopped", "the owned hub booted");
      owner.kill("SIGKILL");
      const gone = async (url) => {
        const until = Date.now() + 20_000;
        while (Date.now() < until) {
          if (
            !(await request(url)
              .then(collect)
              .then(
                () => true,
                () => false,
              ))
          )
            return true;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
      };
      assert.ok(await gone(health), "the hub shut down after its owner died");
      if (hasRuntime) assert.ok(await gone(`http://127.0.0.1:${idePort}/healthz`), "code-server stopped with it");
    } finally {
      owner.kill("SIGKILL");
      // Only when it is still serving, so a recycled PID is never touched.
      if (
        await request(health)
          .then(collect)
          .then(
            () => true,
            () => false,
          )
      )
        killTree(hubPid);
    }
  });

  test("sharing toggle: HTTPS listener up, CA served, remote sockets end", async () => {
    const hub = await boot();
    try {
      const on = await hub.share(true);
      assert.equal(on, true);
      // Loopback HTTP keeps working while sharing.
      const health = await request(`http://127.0.0.1:${hub.config.server.port}/api/health`);
      assert.equal(health.statusCode, 200);
      const body = JSON.parse(await collect(health));
      assert.equal(body.sharing, true);
      assert.ok(body.lanUrls.length > 0);
      // The CA is served to new devices.
      const ca = await request(`http://127.0.0.1:${hub.config.server.port}/ca.crt`);
      assert.equal(ca.statusCode, 200);
      assert.ok((await collect(ca)).includes("BEGIN CERTIFICATE"));
      const off = await hub.share(false);
      assert.equal(off, false);
    } finally {
      await hub.stop();
    }
  });

  test("one port serves trusted HTTP and untrusted HTTPS, including after repeated toggles", async () => {
    const hub = await boot();
    const local = `http://localhost:${hub.config.server.port}`;
    const lan = `https://127.0.0.1:${hub.config.server.port}`;
    try {
      await assert.rejects(() => secure(`${lan}/api/health`), "TLS is refused while sharing is off");
      await Promise.all([hub.share(true), hub.share(false), hub.share(true)]);
      const localState = await request(`${local}/_vch/state`, { headers: { "x-vch-request": "1" } });
      assert.equal(localState.statusCode, 200);
      assert.equal(JSON.parse(await collect(localState)).controllable, true);
      const remoteState = await secure(`${lan}/_vch/state`, { headers: { "x-vch-request": "1" } });
      assert.equal(remoteState.statusCode, 403, "HTTPS loopback does not acquire host privileges");
      await collect(remoteState);
      const status = await secure(`${lan}/api/status`);
      assert.equal(status.statusCode, 401);
      await collect(status);
      const health = await secure(`${lan}/api/health`);
      const body = JSON.parse(await collect(health));
      assert.equal(health.statusCode, 200);
      assert.equal(body.sharing, true);
      assert.ok(body.lanUrls.every((url) => new URL(url).port === String(hub.config.server.port)));
      await hub.share(false);
      await assert.rejects(() => secure(`${lan}/api/health`));
      const stillLocal = await request(`${local}/api/health`);
      assert.equal(stillLocal.statusCode, 200);
      await collect(stillLocal);
    } finally {
      await hub.stop();
    }
    await assert.rejects(() => request(`${local}/api/health`));
  });

  test("non-loopback HTTP is blocked before authentication, even with forged local headers", async () => {
    const address = lanAddresses()[0];
    if (!address) return "skipped: no non-loopback IPv4 interface";
    const hub = await boot();
    try {
      for (const sharing of [false, true, false]) {
        await hub.share(sharing);
        await assert.rejects(() =>
          request(`http://${address}:${hub.config.server.port}/api/devices`, {
            headers: { host: `localhost:${hub.config.server.port}`, "x-forwarded-for": "127.0.0.1", "x-vch-request": "1" },
          }),
        );
        if (sharing) {
          const health = await secure(`https://${address}:${hub.config.server.port}/api/health`);
          assert.equal(health.statusCode, 200);
          await collect(health);
        }
      }
    } finally {
      await hub.stop();
    }
  });

  test("fragmented HTTP and idle pre-handshake sockets do not prevent shutdown", async () => {
    const hub = await boot();
    const fragmented = net.connect(hub.config.server.port, "127.0.0.1");
    const idle = net.connect(hub.config.server.port, "127.0.0.1");
    try {
      const response = collect(fragmented);
      await new Promise((resolve, reject) => {
        fragmented.once("error", reject);
        fragmented.once("connect", () => {
          fragmented.write("G");
          setTimeout(() => {
            fragmented.write("ET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            resolve();
          }, 20);
        });
      });
      assert.match(await response, /^HTTP\/1\.1 200/);
      await new Promise((resolve, reject) => {
        idle.once("error", reject);
        if (idle.readyState === "open") resolve();
        else idle.once("connect", resolve);
      });
      const closed = new Promise((resolve) => idle.once("close", resolve));
      await hub.stop();
      await closed;
    } finally {
      fragmented.destroy();
      idle.destroy();
      await hub.stop();
    }
  });

  test("shared-port WebSockets proxy both protocols; stopping sharing closes only TLS sessions", async () => {
    const hub = await boot();
    const upstream = http.createServer();
    const upstreamSockets = new Set();
    const protocols = [];
    upstream.on("connection", (socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
    });
    upstream.on("upgrade", (request, socket) => {
      protocols.push(request.headers["x-forwarded-proto"]);
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    let localSocket;
    let remoteSocket;
    try {
      await new Promise((resolve, reject) => {
        upstream.once("error", reject);
        upstream.listen(hub.config.ide.port, "127.0.0.1", () => resolve(undefined));
      });
      await hub.share(true);
      const pairing = hub.startPairing();
      const paired = await secure(`https://127.0.0.1:${hub.config.server.port}/_vch/pair`, {
        method: "POST",
        body: { code: pairing.code, name: "WebSocket" },
      });
      const { token } = JSON.parse(await collect(paired));
      localSocket = await websocket(`http://127.0.0.1:${hub.config.server.port}/`);
      remoteSocket = await websocket(`https://127.0.0.1:${hub.config.server.port}/`, { authorization: `Bearer ${token}` });
      assert.deepEqual(protocols, ["http", "https"]);
      const disconnected = new Promise((resolve) => remoteSocket.once("close", resolve));
      await hub.share(false);
      await disconnected;
      assert.equal(localSocket.destroyed, false);
      await hub.share(true);
      const again = await websocket(`https://127.0.0.1:${hub.config.server.port}/`, { authorization: `Bearer ${token}` });
      again.destroy();
      assert.deepEqual(protocols, ["http", "https", "https"], "re-enabling sharing does not duplicate upgrade handlers");
    } finally {
      localSocket?.destroy();
      remoteSocket?.destroy();
      await hub.stop();
      for (const socket of upstreamSockets) socket.destroy();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  test("saving a new shared port leaves current URLs correct until restart", async () => {
    const directory = `${dataDir}-config`;
    const hub = await boot({ dataDir: directory });
    const port = hub.config.server.port;
    try {
      await hub.share(true);
      await hub.updateConfig({ server: { ...hub.config.server, port: port + 1 } });
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")).server.port, port + 1);
      const health = await secure(`https://127.0.0.1:${port}/api/health`);
      const body = JSON.parse(await collect(health));
      assert.ok(body.lanUrls.every((url) => new URL(url).port === String(port)));
      assert.ok(hub.lanUrls().every((url) => new URL(url).port === String(port)));
    } finally {
      await hub.stop();
    }
  });
});

function websocket(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const attempt = client.request(url, {
      rejectUnauthorized: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    attempt.once("upgrade", (response, socket) => resolve(socket));
    attempt.once("response", (response) => {
      response.resume();
      reject(new Error(`Upgrade returned HTTP ${response.statusCode}`));
    });
    attempt.once("error", reject);
    attempt.setTimeout(5000, () => attempt.destroy(new Error("WebSocket upgrade timed out")));
    attempt.end();
  });
}

/**
 * HTTPS request to a LAN listener (self-signed local CA).
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any }} [options]
 */
function secure(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, rejectUnauthorized: false }, resolve);
    request.on("error", reject);
    if (body) request.end(JSON.stringify(body));
    else request.end();
  });
}

function collect(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks).toString()));
    response.on("error", reject);
  });
}
