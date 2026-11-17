/**
 * Desktop app hub launcher: decides how `server.js` runs on this machine and
 * keeps its handle for the app lifetime.
 *
 * - Bundled app (`npm run build:*`): `stage.js` puts `server.js`,
 *   `core/`, `hub/`, `node_modules/` and `runtime/` in Tauri resources;
 *   the hub runs with the Node bundled in the code-server runtime, spawned
 *   through the Tauri shell command scoped to that resource in the app setup.
 * - Development (`npm run dev`): there is no payload next to the exe; the app
 *   expects the hub to be already running (`npm start`) and just talks to it.
 *
 * The backend is a supervisor of its own children; it shuts down cleanly when
 * killed, so a plain `handle.kill()` ends the whole tree.
 */
/** @typedef {{ kind: "checking" | "bundled" | "external", payloadDir?: string, error?: string, focusPairing?: boolean }} HostMode */

import { Context } from "@vistta/js";
import { api } from "./api.js";
import { desktopStartup } from "./startup.js";

const BOOT_TIMEOUT_MS = 60_000;

/** How the hub behind the dashboard runs. */
export const mode = new Context("vch.host_mode", /** @type {HostMode} */ ({ kind: "checking" }), {
  cache: "none",
  actions: { set: (_prev, value) => value },
});

/** @type {{ pid?: number, kill?: () => Promise<void> } | null} */
let running = null;

/**
 * Loads (once) and returns the `@vistta/js-native/plugins` namespaces used by
 * the launcher. Typed loosely: the package ships no .d.ts for browser code.
 * @returns {Promise<any>}
 */
async function plugin() {
  return import("@vistta/js-native/plugins");
}

async function probeFile(path) {
  const { Filesystem } = await plugin();
  return Filesystem.exists(path);
}

/**
 * Resolves the staged payload directory (the one holding `server.js`). Staging
 * puts the payload in the resource folder in installers.
 */
async function findPayload() {
  const { System } = await plugin();
  const directory = await System.resourceDir();
  const payload = await System.join(directory, "codehub");
  if (await probeFile(await System.join(payload, "server.js"))) return payload;
  return undefined;
}

/** Bundled Node inside the code-server runtime, if present. */
async function findBundledNode(payload) {
  const { System } = await plugin();
  const binary = navigator.userAgent.includes("Windows") ? "node.exe" : "node";
  for (const directory of ["lib", "bin"]) {
    const candidate = await System.join(payload, "runtime", "code-server", directory, binary);
    if (await probeFile(candidate)) return `codehub-node-${directory}`;
  }
  return undefined;
}

/**
 * Boots the hub backend (bundled payload) or verifies an already-running
 * external hub (`npm start`). Resolves once `/api/health` answers.
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ pid?: number, external: boolean }>}
 */
export async function launchHub(options = {}) {
  if (running) return { pid: running.pid, external: !running.kill };
  const payload = await findPayload();

  if (!payload) {
    mode.set({ kind: "external" });
    await waitForHealth(options.port);
    running = {};
    return { external: true };
  }

  const commandName = await findBundledNode(payload);
  if (!commandName) {
    mode.set({ kind: "bundled", payloadDir: payload, error: "no bundled Node in the code-server runtime" });
    throw new Error("The staged runtime has no bundled Node; re-run `npm run install-runtime`.");
  }
  mode.set({ kind: "bundled", payloadDir: payload });

  const { Shell, System } = await plugin();
  const entry = await System.join(payload, "server.js");
  const dataDir = await System.join(await System.appDataDir(), "codehub");
  const command = Shell.Command.create(commandName, [entry], {
    cwd: payload,
    // env merges over the parent env, so only hub-specific pairs go here.
    env: {
      VCH_DATA_DIR: dataDir,
      VCH_HOST_ACTIONS_FILE: "1",
      ...(options.port ? { VCH_SERVER_PORT: String(options.port) } : {}),
    },
  });
  command.stdout.on("data", (line) => {
    const event = parsePipeLine(line);
    if (event?.vch === "desktop-request") {
      void respond(event).catch((error) => console.error("[desktop] Could not reply to hub:", error));
    } else if (event) window.dispatchEvent(new CustomEvent("vch-host", { detail: event }));
    else console.log("[hub]", line);
  });
  command.stderr.on("data", (line) => console.warn("[hub]", line));
  command.on("close", ({ code }) => {
    console.warn(`[hub] exited (code ${code})`);
    if (running?.pid) running = null;
    window.dispatchEvent(new CustomEvent("vch-host", { detail: { vch: "exit", code } }));
  });
  command.on("error", (line) => console.error("[hub]", line));
  const spawned = command.spawn();
  async function respond(event) {
    /** @type {{ vch: string, id: string, value?: boolean, error?: string }} */
    const response = { vch: "desktop-response", id: event.id };
    try {
      if (typeof event.id !== "string" || event.action !== "startup") throw new Error("Unknown desktop request");
      response.value = await desktopStartup(System, event.body);
    } catch (error) {
      response.error = error.message ?? String(error);
    }
    await (await spawned).write(`${JSON.stringify(response)}\n`);
  }
  const handle = await spawned;
  running = { pid: handle.pid, kill: () => handle.kill() };
  await waitForHealth(options.port);
  return { pid: handle.pid, external: false };
}

/**
 * Kills a hub this app spawned; external hubs are left running (the user
 * started them in a terminal).
 */
export async function stopHub() {
  const current = running;
  running = null;
  if (current?.kill) await current.kill().catch(() => undefined);
}

/**
 * Waits until the loopback hub answers `/api/health`; rejects with the last
 * probe when the boot deadline passes.
 * @param {number} [port]
 */
export async function waitForHealth(port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await api("/api/health");
    if (probe.ok) return probe.data;
    last = probe;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `The hub did not come up on port ${port ?? 8181}: ${JSON.stringify(last?.data?.error ?? last?.data ?? {})}`,
  );
}

/** @param {string} line */
function parsePipeLine(line) {
  const text = String(line).trim();
  if (!text.startsWith("{") || !text.includes('"vch":')) return null;
  try {
    const value = JSON.parse(text);
    return value?.vch ? value : null;
  } catch {
    return null;
  }
}