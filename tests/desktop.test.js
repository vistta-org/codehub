import { transformSync } from "esbuild";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import setup from "../app/setup.js";
import { DesktopBridge } from "../core/desktop.js";

function load(file, modules = {}, { platform = "desktop", userAgent = "Windows" } = {}) {
  const { code } = transformSync(fs.readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8"), {
    loader: "jsx",
    format: "cjs",
    jsxFactory: "element",
    supported: { "dynamic-import": false },
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === "@vistta/js")
        return {
          Component: class {},
          Context: class {
            set(value) {
              this.value = value;
            }
          },
        };
      if (!(id in modules)) throw new Error(`Unexpected dependency: ${id}`);
      return modules[id];
    },
    window: { platform, addEventListener() {} },
    navigator: { userAgent },
    console,
    element: (type, props, ...children) => ({ type, props, children }),
  });
  return module.exports;
}

function startupFixture(options = {}) {
  let enabled = false;
  const calls = [];
  const System = {
    isAutostartEnabled: async () => enabled,
    enableAutostart: async () => {
      calls.push("enable");
      enabled = true;
    },
    disableAutostart: async () => {
      calls.push("disable");
      enabled = false;
    },
  };
  return { System, calls, startup: load("startup.js", {}, options).desktopStartup };
}

suite("desktop app", () => {
  test("tray Settings requests the IDE editor and focuses the local IDE without a second settings window", async () => {
    let shortcuts;
    /** @type {((action: { id: string }) => void) | undefined} */
    let handler;
    const calls = [];
    const Home = load("home.jsx", {
      "@vistta/js-native/plugins": {
        Accessibility: {
          setShortcuts: async (items) => {
            shortcuts = items;
            return true;
          },
          onLaunchAction: (callback) => {
            handler = callback;
          },
        },
      },
      "./api.js": {
        api: async (path, options) => {
          if (path === "/api/config") return { ok: true, data: { desktop: { startMinimized: false } } };
          if (path === "/_vch/host/openSettings" || path === "/_vch/host/pairDevice") {
            assert.equal(options.method, "POST");
            assert.equal(options.context, "host");
            calls.push(path.endsWith("openSettings") ? "settings-request" : "pairing-request");
          }
          return { ok: true, data: { ide: { state: "running" } } };
        },
      },
      "./lifecycle.js": { launchHub: async () => calls.push("hub") },
      "./ide-window.js": {
        openIdeWindow: async () => {
          calls.push("ide");
          return true;
        },
      },
    }).default;
    await new Home().onConnect();
    assert.deepEqual(
      Array.from(shortcuts, ({ label }) => label),
      ["Settings", "Pair Device"],
    );
    assert.ok(handler);
    handler({ id: "settings.open" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["hub", "ide", "settings-request", "ide"]);
    handler({ id: "device.pair" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["hub", "ide", "settings-request", "ide", "pairing-request", "ide"]);
  });

  for (const startMinimized of [false, true]) {
    test(`desktop launch ${startMinimized ? "stays in the tray" : "opens the IDE"} and tray Show opens the IDE`, async () => {
      let handler;
      const calls = [];
      const Home = load("home.jsx", {
        "@vistta/js-native/plugins": {
          Accessibility: {
            setShortcuts: async () => true,
            onLaunchAction: (callback) => {
              handler = callback;
            },
          },
        },
        "./api.js": {
          api: async (path) => {
            if (path === "/api/config") return { ok: true, data: { desktop: { startMinimized } } };
            return { ok: true, data: { ide: { state: "running" } } };
          },
        },
        "./lifecycle.js": { launchHub: async () => calls.push("hub") },
        "./ide-window.js": {
          openIdeWindow: async () => {
            calls.push("ide");
            return true;
          },
        },
      }).default;
      await new Home().onConnect();
      assert.deepEqual(calls, startMinimized ? ["hub"] : ["hub", "ide"]);
      handler({ id: "show" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.at(-1), "ide");
      assert.equal(calls.length, startMinimized ? 2 : 3);
    });
  }

  test("native startup is opt-in, reads the OS, and verifies enabling and disabling", async () => {
    const { System, calls, startup } = startupFixture();
    assert.equal(await startup(System), false);
    assert.deepEqual(calls, []);
    assert.equal(await startup(System, { enabled: true }), true);
    assert.equal(await startup(System, { enabled: false }), false);
    assert.deepEqual(calls, ["enable", "disable"]);
  });

  test("native startup errors and unsuccessful OS changes reject", async () => {
    const { System, startup } = startupFixture();
    System.enableAutostart = async () => {
      throw new Error("Access denied");
    };
    await assert.rejects(() => startup(System, { enabled: true }), /Access denied/);
    System.enableAutostart = async () => {};
    await assert.rejects(() => startup(System, { enabled: true }), /did not apply/);
  });

  test("native startup rejects unsupported platforms before touching the OS", async () => {
    for (const options of [{ userAgent: "Macintosh" }, { platform: "android", userAgent: "Linux Android" }]) {
      const { System, calls, startup } = startupFixture(options);
      await assert.rejects(() => startup(System, { enabled: true }), /only supported/);
      assert.deepEqual(calls, []);
    }
    const { System, startup } = startupFixture({ userAgent: "Linux" });
    assert.equal(await startup(System), false);
  });

  test("desktop pipe correlates startup replies and forwards native errors", async () => {
    const input = new PassThrough();
    const sent = [];
    const bridge = new DesktopBridge(input, (message) => sent.push(message));
    try {
      const first = bridge.startup(true);
      const second = bridge.startup();
      input.write(JSON.stringify({ vch: "desktop-response", id: sent[1].id, value: false }) + "\n");
      input.write(JSON.stringify({ vch: "desktop-response", id: sent[0].id, value: true }) + "\n");
      assert.equal(await first, true);
      assert.equal(await second, false);
      const failed = bridge.startup(false);
      input.write(JSON.stringify({ vch: "desktop-response", id: sent[2].id, error: "Access denied" }) + "\n");
      await assert.rejects(() => failed, /Access denied/);
      assert.equal(bridge.pending.size, 0);
    } finally {
      bridge.close();
    }
  });

  test("desktop pipe timeouts and disconnects reject instead of reporting success", async () => {
    const bridge = new DesktopBridge(new PassThrough(), () => {}, 20);
    try {
      await assert.rejects(() => bridge.startup(), /timed out/);
      const pending = bridge.startup(true);
      bridge.close();
      await assert.rejects(() => pending, /connection closed/);
      await assert.rejects(() => bridge.startup(), /connection is closed/);
    } finally {
      bridge.close();
    }
  });

  test("bundled controller answers native startup requests over the child stdin pipe", async () => {
    /** @type {((line: string) => void) | undefined} */
    let stdout;
    const replies = [];
    const { System: startupSystem } = startupFixture();
    const System = {
      ...startupSystem,
      resourceDir: async () => "resources",
      appDataDir: async () => "data",
      join: async (...parts) => parts.join("\\"),
    };
    const command = {
      stdout: {
        on: (_name, callback) => {
          stdout = callback;
        },
      },
      stderr: { on() {} },
      on() {},
      spawn: async () => ({ pid: 123, write: async (value) => replies.push(JSON.parse(value)), kill: async () => {} }),
    };
    const lifecycle = load("lifecycle.js", {
      "./api.js": { api: async () => ({ ok: true }) },
      "./startup.js": { desktopStartup: load("startup.js").desktopStartup },
      "@vistta/js-native/plugins": {
        System,
        Filesystem: { exists: async () => true },
        Shell: { Command: { create: () => command } },
      },
    });
    await lifecycle.launchHub();
    assert.ok(stdout);
    stdout(JSON.stringify({ vch: "desktop-request", id: "request-1", action: "startup", body: { enabled: true } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [{ vch: "desktop-response", id: "request-1", value: true }]);
  });

  test("IDE windows never receive startup or stdin-write capabilities and no settings window remains", async () => {
    const config = await setup();
    const capabilities = config.extraTauriConfig.app.security.capabilities;
    assert.equal(
      capabilities.some((entry) => entry.identifier === "host-settings"),
      false,
    );
    const ide = capabilities.find((entry) => entry.identifier === "ide-window-controls");
    assert.equal(
      ide.permissions.some((permission) => /autostart|shell:/.test(permission)),
      false,
    );
    assert.equal(fs.existsSync(new URL("../app/settings.jsx", import.meta.url)), false);
  });
});
