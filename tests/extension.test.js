import assert from "node:assert/strict";
import vm from "node:vm";
import { defaultConfig } from "../core/config.js";
import { extensionManifest, extensionScript } from "../hub/extension.js";

function activate(controllable, responses, origin = "http://127.0.0.1:8181", settings = {}) {
  const commands = new Map();
  const calls = [];
  const messages = [];
  const panels = [];
  const item = { show() {}, dispose() {} };
  const executed = [];
  const values = new Map(
    Object.entries(extensionManifest.contributes.configuration.properties).map(([key, value]) => [
      key.slice("codeHub.".length),
      value.default,
    ]),
  );
  for (const [key, value] of Object.entries(settings)) values.set(key, value);
  const config = defaultConfig();
  for (const [key, value] of Object.entries(responses["/api/config"] ?? {}))
    config[key] = value && typeof value === "object" ? { ...config[key], ...value } : value;
  let startupEnabled = responses["/_vch/startup"]?.enabled ?? false;
  let onChange;
  let onFocus;
  let choice;
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
    ViewColumn: { Active: 1 },
    ConfigurationTarget: { Global: 1 },
    window: {
      state: { focused: true },
      createStatusBarItem: () => item,
      createWebviewPanel: () => {
        const panel = { webview: { html: "" } };
        panels.push(panel);
        return panel;
      },
      showErrorMessage: (message) => messages.push(message),
      showInformationMessage: () => undefined,
      showQuickPick: async (items) => choice?.(items),
      showInputBox: async () => "sample-project",
      onDidChangeWindowState: (callback) => ((onFocus = callback), { dispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key) => values.get(key),
        update: async (key, value) => {
          values.set(key, value);
          await onChange?.({ affectsConfiguration: (candidate) => candidate === "codeHub." + key });
        },
      }),
      onDidChangeConfiguration: (callback) => ((onChange = callback), { dispose() {} }),
    },
    commands: {
      registerCommand: (id, handler) => (commands.set(id, handler), { dispose() {} }),
      executeCommand: async (...args) => {
        executed.push(args);
      },
    },
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    // The real hub refuses host state to remote callers.
    if (path === "/_vch/state" && !controllable)
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: "Only the host can do this" } }),
      };
    let data = path === "/_vch/state" ? (responses[path] ?? { sharing: false, controllable, lanUrls: [] }) : responses[path];
    if (typeof data === "function") data = await data(options);
    if (data instanceof Error)
      return { ok: false, status: 409, text: async () => JSON.stringify({ error: { message: data.message } }) };
    if (path === "/api/config") {
      if (options.method === "PATCH") Object.assign(config, JSON.parse(options.body));
      data = config;
    }
    if (path === "/_vch/startup" && data === undefined) {
      if (!responses["/_vch/state"]?.desktop)
        return { ok: false, status: 409, text: async () => JSON.stringify({ error: { message: "Desktop app required" } }) };
      if (options.method === "POST") startupEnabled = JSON.parse(options.body).enabled;
      data = { enabled: startupEnabled };
    }
    return {
      ok: data !== undefined,
      status: data === undefined ? 404 : 200,
      text: async () => JSON.stringify(data ?? { error: { message: "Not found" } }),
    };
  };
  const exports = {};
  vm.runInNewContext(extensionScript, {
    exports,
    require: () => vscode,
    fetch,
    URL,
    globalThis: { location: { origin: new URL(origin).origin, protocol: new URL(origin).protocol } },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
  });
  exports.activate({ subscriptions: [] });
  return {
    commands,
    calls,
    messages,
    panels,
    item,
    executed,
    values,
    config,
    setChoice: (value) => (choice = value),
    ready: () => new Promise((resolve) => setImmediate(resolve)),
    change: async (changes) => {
      for (const [key, value] of Object.entries(changes)) values.set(key, value);
      await onChange({ affectsConfiguration: (candidate) => candidate.slice("codeHub.".length) in changes });
    },
    focus: () => onFocus({ focused: true }),
  };
}

suite("IDE host extension", () => {
  test("installed script exposes host controls from the IDE origin", async () => {
    assert.equal(extensionManifest.browser, "./extension.js");
    const host = activate(true, { "/api/projects": [], "/api/devices/pairing": { pairing: { code: "123456" } } });
    host.setChoice((items) => items.find((item) => item.command === "projects"));
    await host.commands.get("codeHub.menu")();
    assert.ok(host.calls.some(({ url }) => url === "http://127.0.0.1:8181/api/projects"));
    assert.ok(
      host.calls.some(({ url, options }) => url.endsWith("/_vch/state") && options.headers["x-vch-request"] === "1"),
    );
    assert.equal(
      host.calls.some(({ url }) => url.startsWith("file:")),
      false,
    );
    assert.deepEqual(host.messages, []);
  });

  test("remote IDE cannot invoke host controls", async () => {
    const remote = activate(false, {});
    await remote.commands.get("codeHub.menu")();
    assert.equal(
      remote.calls.some(({ options }) => options.method !== "GET"),
      false,
    );
    assert.ok(remote.calls.every(({ url }) => url === "http://127.0.0.1:8181/_vch/state"));
    assert.deepEqual(remote.messages, [], "being remote is not an error");
  });

  for (const origin of ["http://localhost:8181", "http://127.0.0.1:8300", "https://192.168.1.9:8181"]) {
    test(`blob extension workers keep the IDE origin ${origin}`, async () => {
      const host = activate(
        true,
        {
          "/_vch/state": { sharing: true, controllable: true, lanUrls: ["https://192.168.1.9:8181"] },
          "/api/projects": [],
        },
        `blob:${origin}/extension-worker`,
      );
      await host.commands.get("codeHub.projects")();
      assert.ok(host.calls.some(({ url }) => url === `${origin}/api/projects`));
      assert.ok(host.calls.every(({ url }) => new URL(url).origin === origin));
      assert.equal(host.item.text, "$(broadcast) LAN");
      assert.deepEqual(host.messages, []);
    });
  }

  test("remote blob workers request state from the remote host, not local loopback", async () => {
    const origin = "https://192.168.1.9:8181";
    const remote = activate(false, {}, `blob:${origin}/extension-worker`);
    await remote.commands.get("codeHub.menu")();
    assert.ok(remote.calls.every(({ url }) => url === `${origin}/_vch/state`));
    assert.equal(remote.item.text, "$(remote) Code Hub");
    assert.deepEqual(remote.messages, []);
  });

  test("all host settings are contributed to the IDE Settings editor with one shared HTTP / HTTPS port", async () => {
    const host = activate(true, {
      "/api/config": { name: "Host", server: { port: 8181, logLevel: "info" }, ide: { port: 8281 }, projects: { root: "" } },
    });
    await host.ready();
    await host.commands.get("codeHub.configure")();
    assert.deepEqual(host.executed, [["workbench.action.openSettings", "@ext:vistta.code-hub"]]);
    const properties = extensionManifest.contributes.configuration.properties;
    for (const key of [
      "shareOnLan",
      "startAtLogin",
      "startMinimized",
      "hostName",
      "projectsRoot",
      "serverPort",
      "idePort",
      "logLevel",
      "workspaceTrust",
    ])
      assert.ok(properties["codeHub." + key], key);
    assert.equal(properties["codeHub.serverPort"].default, 8181);
    assert.equal(properties["codeHub.serverPort"].maximum, 65535);
    assert.equal(properties["codeHub.startAtLogin"].ignoreSync, true);
    assert.ok(
      Object.values(properties).every((property) => property.scope === "application"),
      "all settings must appear together in the User tab",
    );
    assert.equal("codeHub.lanPort" in properties, false);
    assert.equal(host.values.get("hostName"), "Host");
  });

  test("a chat window opens only the Chat; other windows keep their layout", async () => {
    const LAYOUT = [
      "workbench.action.closeSidebar",
      "workbench.action.closePanel",
      "workbench.action.chat.open",
      "workbench.action.maximizeAuxiliaryBar",
    ];
    const chat = activate(false, {}, undefined, { chatOnly: true });
    await chat.ready();
    assert.deepEqual(chat.executed, LAYOUT.map((command) => [command]));
    const ide = activate(true, {});
    await ide.ready();
    assert.ok(ide.executed.every(([command]) => !LAYOUT.includes(command)));
  });

  test("other computers: open asks the hub for the relay, then the app for a window", async () => {
    const host = activate(true, {
      "/api/remotes": { remotes: [{ id: "r1", name: "Laptop", url: "https://192.168.1.9:8182" }] },
      "/api/remotes/r1/status": { online: true, paired: true, status: { ide: { state: "running" } } },
      "/api/remotes/r1/open": { url: "http://127.0.0.1:8300/" },
      "/_vch/host/openRemote": { ok: true },
    });
    host.setChoice((items) => items.find((item) => item.open || item.remote?.id === "r1"));
    await host.commands.get("codeHub.computers")();
    const posted = host.calls
      .filter(({ options }) => options.method === "POST")
      .map(({ url, options }) => [new URL(url).pathname, JSON.parse(options.body), options.headers["x-vch-request"]]);
    assert.deepEqual(posted, [
      ["/api/remotes/r1/open", {}, "1"],
      ["/_vch/host/openRemote", { id: "r1", url: "http://127.0.0.1:8300/" }, "1"],
    ]);
    assert.deepEqual(host.messages, []);
  });

  test("desktop startup is edited in IDE Settings and invokes the protected OS-backed endpoint", async () => {
    const host = activate(true, {
      "/_vch/state": { sharing: false, controllable: true, desktop: true, lanUrls: [] },
      "/api/config": { name: "Host", server: { port: 8181 }, ide: { port: 8281 }, projects: { root: "" } },
    });
    await host.ready();
    assert.equal(host.values.get("startAtLogin"), false);
    await host.change({ startAtLogin: true });
    const posted = host.calls.filter(({ url, options }) => options.method === "POST" && url.endsWith("/_vch/startup"));
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0].options.body), { enabled: true });
    assert.equal(posted[0].options.headers["x-vch-request"], "1");
    assert.equal(host.values.get("startAtLogin"), true);
    assert.equal(
      host.calls.some(({ options }) => options.method === "PATCH"),
      false,
    );
    assert.deepEqual(host.messages, []);
  });

  test("settings edits preserve unrelated host configuration and apply every editable field", async () => {
    const host = activate(true, {
      "/api/config": {
        server: { share: true, tls: { days: 100 } },
        ide: { extraArgs: ["--example"] },
        projects: { recent: ["project"] },
      },
    });
    await host.ready();
    await host.change({
      startMinimized: true,
      hostName: "New",
      projectsRoot: "projects",
      serverPort: 9000,
      idePort: 9001,
      logLevel: "debug",
      workspaceTrust: true,
    });
    assert.equal(host.config.name, "New");
    assert.equal(host.config.desktop.startMinimized, true);
    assert.equal(host.config.server.port, 9000);
    assert.equal(host.config.server.logLevel, "debug");
    assert.equal(host.config.server.share, true);
    assert.equal(host.config.server.tls.days, 100);
    assert.equal(host.config.ide.port, 9001);
    assert.equal(host.config.ide.workspaceTrust, true);
    assert.deepEqual(host.config.ide.extraArgs, ["--example"]);
    assert.equal(host.config.projects.root, "projects");
    assert.deepEqual(host.config.projects.recent, ["project"]);
    assert.deepEqual(host.messages, []);
  });

  test("startup errors are reported and the IDE checkbox returns to OS state", async () => {
    const host = activate(true, {
      "/_vch/state": { sharing: false, controllable: true, desktop: true, lanUrls: [] },
      "/_vch/startup": (options) => (options.method === "POST" ? new Error("Access denied") : { enabled: false }),
    });
    await host.ready();
    await host.change({ startAtLogin: true });
    assert.equal(host.values.get("startAtLogin"), false);
    assert.ok(host.messages.some((message) => message.includes("Access denied")));
  });

  test("tray settings requests open the IDE editor once, not a native window", async () => {
    let pending = true;
    const host = activate(true, {
      "/_vch/state": () => ({ sharing: false, controllable: true, lanUrls: [], settingsRequested: pending }),
      "/_vch/settings/claim": () => {
        const open = pending;
        pending = false;
        return { open };
      },
    });
    await host.ready();
    assert.deepEqual(host.executed, [["workbench.action.openSettings", "@ext:vistta.code-hub"]]);
    host.focus();
    await host.ready();
    assert.equal(host.executed.length, 1);
    assert.equal(
      host.calls.some(({ url }) => url.endsWith("/_vch/host/openSettings")),
      false,
      "no loop back into the tray",
    );
  });

  test("remote settings changes cannot mutate the host", async () => {
    const remote = activate(false, {});
    await remote.ready();
    await remote.change({ hostName: "Remote", startAtLogin: true });
    assert.equal(
      remote.calls.some(({ options }) => options.method !== "GET"),
      false,
    );
  });

  test("tray pairing requests open the pairing panel once without changing LAN sharing", async () => {
    let pending = true;
    const host = activate(true, {
      "/_vch/state": () => ({ sharing: false, controllable: true, lanUrls: [], pairingRequested: pending }),
      "/_vch/pairing/claim": () => {
        const open = pending;
        pending = false;
        return { open };
      },
      "/api/devices/pairing": {
        pairing: { code: "123456", expiresAt: Date.now() + 60_000 },
        link: "https://192.168.1.9:8181/pair?code=123456",
        qr: "data:image/png;base64,test",
      },
    });
    await host.ready();
    assert.equal(host.panels.length, 1);
    assert.match(host.panels[0].webview.html, /123456/);
    assert.match(host.panels[0].webview.html, /Pairing QR/);
    host.focus();
    await host.ready();
    assert.equal(host.panels.length, 1);
    assert.equal(
      host.calls.filter(({ url, options }) => options.method === "POST" && url.endsWith("/api/devices/pairing")).length,
      1,
    );
    assert.equal(host.calls.some(({ url }) => url.includes("/_vch/host/")), false);
    assert.deepEqual(host.messages, []);
  });

  test("file-based extension hosts use the hub rather than file URLs", async () => {
    const host = activate(true, { "/api/projects": [] }, "file://");
    host.setChoice((items) => items.find((item) => item.command === "projects"));
    await host.commands.get("codeHub.menu")();
    assert.ok(host.calls.some(({ url }) => url === "http://127.0.0.1:8181/api/projects"));
  });
});
