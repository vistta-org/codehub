/**
 * API dispatcher rules without a server: route matching, auth levels and the
 * host-proof requirement are checked directly against `createRouter`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../core/config.js";
import { DeviceStore } from "../core/devices.js";
import { Logger } from "../core/logger.js";
import { createRoutes, matchRoute, PROOF_HEADER } from "../hub/api.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-"));
process.once("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));

function fakeHub(directory = dataDir) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const store = new DeviceStore(directory);
  const config = structuredClone(defaultConfig());
  const hub = {
    config,
    logger: new Logger({ console: false }),
    startedAt: Date.now(),
    version: "0.0.0-test",
    desktop: false,
    desktopStartup: /** @type {((enabled?: boolean) => Promise<boolean>) | undefined} */ (undefined),
    dataDir: directory,
    sharing: () => false,
    caCertificate: () => undefined,
    lanUrls: () => [],
    workbench: () => ({ patched: true }),
    devices: store,
    projects: {
      root: config.projects.root,
      recent: () => [],
      list: () => [],
      open: () => config.projects.root,
      create: () => ({ name: "x" }),
    },
    extensions: { list: () => [] },
    launcher: {
      status: () => ({ state: "stopped" }),
      start: () => undefined,
      stop: () => undefined,
      restart: () => undefined,
    },
    updateConfig: (patch) => ({ ...config, ...patch }),
    startPairing: () => store.startPairing(),
    hostAction: () => undefined,
    remotes: {
      list: () => [
        { id: "r1", name: "Laptop", url: "https://192.168.1.9:8182", relayActive: true, relayPort: 8300 },
        { id: "r2", name: "Idle", url: "https://192.168.1.10:8182", relayActive: false, relayPort: 8301 },
      ],
    },
  };
  const routes = createRoutes(/** @type {any} */ (hub));
  return { hub, store, routes };
}

function decorate(route, overrides = {}) {
  return {
    method: "GET",
    headers: {},
    cookies: {},
    params: {},
    body: undefined,
    remote: false,
    isLocal: false,
    device: null,
    admin: false,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    ...overrides,
  };
}

async function call(route, hub, request, response) {
  return route.handler(request, response ?? { writableEnded: false, headersSent: false }, hub);
}

suite("router", () => {
  const { hub, store, routes } = fakeHub();

  test("matchRoute resolves params and methods", async () => {
    const found = matchRoute(routes, "DELETE", "/api/devices/abc-123");
    assert.ok(found);
    assert.equal(found.params.id, "abc-123");
    assert.equal(matchRoute(routes, "GET", "/api/health")?.route.path, "/api/health");
    assert.equal(matchRoute(routes, "POST", "/api/health"), null, "method must match");
    assert.equal(matchRoute(routes, "GET", "/api/health/extra"), null, "exact segment count");
    const action = matchRoute(routes, "POST", "/_vch/host/share");
    assert.equal(action.params.action, "share");
  });

  test("health is public and reports the IDE state", async () => {
    const route = matchRoute(routes, "GET", "/api/health");
    const state = await call(route.route, hub, decorate(route.route));
    assert.equal(state.ok, true);
    assert.equal(state.ide.state, "stopped");
    assert.deepEqual(Object.keys(state.error ?? {}), []);
    assert.equal(typeof state.uptimeMs, "number");
  });

  test("host-only routes refuse remote devices", async () => {
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Remote" });
    const device = store.authenticate(created.token);
    const route = matchRoute(routes, "GET", "/api/devices");
    await assert.rejects(
      () => call(route.route, hub, decorate(route.route, { remote: true, isLocal: false, device })),
      /Only the host can do this/,
    );
  });

  test("cancel pairing closes the code and remains host-only", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-cancel-"));
    try {
      const { hub: isolatedHub, store: isolatedStore, routes: isolatedRoutes } = fakeHub(directory);
      const pairing = isolatedStore.startPairing();
      const route = matchRoute(isolatedRoutes, "DELETE", "/api/devices/pairing");
      assert.ok(route);
      await assert.rejects(
        () => call(route.route, isolatedHub, decorate(route.route, { remote: true })),
        /Only the host can do this/,
      );
      assert.equal(isolatedStore.pairing.code, pairing.code);
      assert.deepEqual(await call(route.route, isolatedHub, decorate(route.route, { isLocal: true })), { ok: true });
      assert.equal(isolatedStore.pairing, null);
      assert.throws(() => isolatedStore.pair(pairing.code), /Pairing is not open/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("paired devices may use device routes", async () => {
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Client" });
    const device = store.authenticate(created.token);
    const route = matchRoute(routes, "POST", "/api/ide/ticket");
    const granted = await call(route.route, hub, decorate(route.route, { device, body: { target: "/?folder=x" } }));
    assert.ok(granted.ticket);
    assert.ok(granted.url.includes("/_vch/open?ticket="));
    // Host-only routes still refused with a device token
    const stop = matchRoute(routes, "POST", "/api/ide/stop");
    await assert.rejects(() => call(stop.route, hub, decorate(stop.route, { device })), /Only the host can do this/);
  });

  test("host actions require the proof header (drive-by protection)", async () => {
    const route = matchRoute(routes, "POST", "/_vch/host/share");
    await assert.rejects(() => call(route.route, hub, decorate(route.route, { isLocal: true })), /Origin not allowed/);
    const ok = await call(
      route.route,
      hub,
      decorate(route.route, { isLocal: true, headers: { [PROOF_HEADER]: "1" }, params: { action: "share" } }),
    );
    assert.deepEqual(ok, { ok: true });
    await assert.rejects(
      () =>
        call(
          route.route,
          hub,
          decorate(route.route, { isLocal: true, headers: { [PROOF_HEADER]: "1" }, params: { action: "explode" } }),
        ),
      /Unknown action/,
    );
  });

  test("openRemote only opens a paired computer's running relay", async () => {
    const route = matchRoute(routes, "POST", "/_vch/host/openRemote");
    const open = (body) =>
      call(
        route.route,
        hub,
        decorate(route.route, { isLocal: true, headers: { [PROOF_HEADER]: "1" }, params: { action: "openRemote" }, body }),
      );
    assert.deepEqual(await open({ id: "r1", url: "http://127.0.0.1:8300/?folder=x" }), { ok: true });
    await assert.rejects(() => open({ id: "r1", url: "https://evil.example/" }), /Open the computer first/);
    await assert.rejects(() => open({ id: "r1", url: "http://127.0.0.1:8181/" }), /Open the computer first/);
    await assert.rejects(
      () => open({ id: "r2", url: "http://127.0.0.1:8301/" }),
      /Open the computer first/,
      "relay not running",
    );
    await assert.rejects(() => open({ id: "nope", url: "http://127.0.0.1:8300/" }), /Open the computer first/);
  });

  test("/_vch/state reports sharing to the IDE extension", async () => {
    const route = matchRoute(routes, "GET", "/_vch/state");
    await assert.rejects(() => call(route.route, hub, decorate(route.route, { isLocal: true })), /Origin not allowed/);
    const state = await call(route.route, hub, decorate(route.route, { isLocal: true, headers: { [PROOF_HEADER]: "1" } }));
    assert.deepEqual(state, { sharing: false, controllable: true, desktop: false, lanUrls: [] });
  });

  test("settings requests are host-protected, claimed once, and never forwarded to a separate window", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-settings-"));
    try {
      const { hub: desktopHub, routes: desktopRoutes } = fakeHub(directory);
      const route = matchRoute(desktopRoutes, "POST", "/_vch/host/openSettings");
      const request = decorate(route.route, { isLocal: true, params: { action: "openSettings" } });
      await assert.rejects(() => call(route.route, desktopHub, request), /Origin not allowed/);
      request.headers = { [PROOF_HEADER]: "1" };
      const actions = [];
      desktopHub.hostAction = (action) => actions.push(action);
      assert.deepEqual(await call(route.route, desktopHub, request), { ok: true });
      const state = matchRoute(desktopRoutes, "GET", "/_vch/state");
      assert.equal((await call(state.route, desktopHub, request)).settingsRequested, true);
      const claim = matchRoute(desktopRoutes, "POST", "/_vch/settings/claim");
      assert.deepEqual(await call(claim.route, desktopHub, request), { open: true });
      assert.deepEqual(await call(claim.route, desktopHub, request), { open: false });
      assert.deepEqual(actions, []);
      await assert.rejects(
        () => call(route.route, desktopHub, { ...request, isLocal: false, remote: true }),
        /Only the host can do this/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("tray pairing requests are host-protected and claimed by only one IDE", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-pairing-"));
    try {
      const { hub: desktopHub, routes: desktopRoutes } = fakeHub(directory);
      const action = matchRoute(desktopRoutes, "POST", "/_vch/host/pairDevice").route;
      const claim = matchRoute(desktopRoutes, "POST", "/_vch/pairing/claim").route;
      const state = matchRoute(desktopRoutes, "GET", "/_vch/state").route;
      const request = decorate(action, {
        isLocal: true,
        headers: { [PROOF_HEADER]: "1" },
        params: { action: "pairDevice" },
      });
      for (const route of [action, claim]) {
        await assert.rejects(() => call(route, desktopHub, { ...request, headers: {} }), /Origin not allowed/);
        await assert.rejects(
          () => call(route, desktopHub, { ...request, isLocal: false, remote: true }),
          /Only the host can do this/,
        );
      }
      assert.deepEqual(await call(action, desktopHub, request), { ok: true });
      assert.equal((await call(state, desktopHub, request)).pairingRequested, true);
      assert.deepEqual(await call(claim, desktopHub, request), { open: true });
      assert.deepEqual(await call(claim, desktopHub, request), { open: false });
      assert.equal((await call(state, desktopHub, request)).pairingRequested, undefined);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("startup routes validate and await the native desktop result with host-only proof", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-startup-"));
    try {
      const { hub: desktopHub, routes: desktopRoutes } = fakeHub(directory);
      const get = matchRoute(desktopRoutes, "GET", "/_vch/startup").route;
      const set = matchRoute(desktopRoutes, "POST", "/_vch/startup").route;
      const request = decorate(get, { isLocal: true, headers: { [PROOF_HEADER]: "1" } });
      await assert.rejects(() => call(get, desktopHub, request), /desktop app/);
      desktopHub.desktop = true;
      let enabled = false;
      desktopHub.desktopStartup = async (value) => {
        if (value !== undefined) enabled = value;
        return enabled;
      };
      assert.deepEqual(await call(get, desktopHub, request), { enabled: false });
      assert.deepEqual(await call(set, desktopHub, { ...request, body: { enabled: true } }), { enabled: true });
      assert.deepEqual(await call(set, desktopHub, { ...request, body: { enabled: false } }), { enabled: false });
      await assert.rejects(() => call(set, desktopHub, { ...request, body: { enabled: "yes" } }), /true or false/);
      await assert.rejects(() => call(get, desktopHub, { ...request, headers: {} }), /Origin not allowed/);
      await assert.rejects(() => call(get, desktopHub, { ...request, isLocal: false }), /Only the host/);
      desktopHub.desktopStartup = async () => {
        throw new Error("Access denied");
      };
      await assert.rejects(() => call(set, desktopHub, { ...request, body: { enabled: true } }), /Access denied/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("pairing route is public and works without any host credential", async () => {
    store.startPairing();
    const route = matchRoute(routes, "POST", "/_vch/pair");
    const granted = await call(
      route.route,
      hub,
      decorate(route.route, { method: "POST", body: { code: store.pairing.code, platform: "android" } }),
    );
    assert.ok(granted.token);
    assert.equal(granted.device.platform, "android");
  });

  test("browser pairing page creates a secure session without returning a token", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-router-browser-"));
    try {
      const { hub: isolatedHub, store: isolatedStore, routes: isolatedRoutes } = fakeHub(directory);
      isolatedStore.startPairing();
      const route = matchRoute(isolatedRoutes, "GET", "/pair");
      const response = {
        writableEnded: false,
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
          this.headersSent = true;
        },
        end(body) {
          this.body = body;
          this.writableEnded = true;
        },
      };
      await call(
        route.route,
        isolatedHub,
        decorate(route.route, { params: { code: isolatedStore.pairing.code }, remote: true }),
        response,
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "/");
      assert.match(response.headers["set-cookie"], /^vchSession=.+; HttpOnly; Secure; SameSite=Lax;/);
      assert.doesNotMatch(response.headers["set-cookie"], /[?&]token=/);
      assert.equal(isolatedStore.pairing, null);
      const cookie = decodeURIComponent(response.headers["set-cookie"].split(";")[0].split("=")[1]);
      assert.ok(isolatedStore.verifySession(cookie));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("projects/open returns a deep link with ?folder=", async () => {
    const route = matchRoute(routes, "POST", "/api/projects/open");
    hub.projects.open = (value) => value;
    const folder = path.join("C:\\work", "demo").replace(/\\/g, "/");
    // A paired device opening a project.
    const paired = store.list()[0] ?? null;
    const result = await call(
      route.route,
      hub,
      decorate(route.route, { method: "POST", device: paired ?? { id: "x" }, body: { project: folder } }),
    );
    assert.equal(result.path, folder);
    assert.ok(result.url.includes("/?folder="));
    assert.ok(decodeURIComponent(result.url).includes("work/demo"));
  });
});
