#!/usr/bin/env vistta
/**
 * Standalone hub entry: `npm start` (or `vistta ./server.js`).
 *
 * Signals:
 * - SIGINT / SIGTERM / SIGHUP → graceful stop (IDE + listener cleanup).
 * - Windows consoles may deliver Ctrl+C as stdin EOF instead of a signal.
 * - `VCH_SHARE=true|false` overrides `server.share` for headless use.
 *
 * Desktop app mode (`VCH_HOST_ACTIONS_FILE`): logs also stream as JSON lines on
 * stdout so the desktop app can surface them, and each host action the IDE
 * requests is reported as `{ vch: "host-action", action, result | error }`.
 * The hub also stops itself (IDE included) once the app that spawned it is gone.
 */
import os from "node:os";
import path from "node:path";
import { DesktopBridge } from "./core/desktop.js";
import { startHub } from "./hub/index.js";

const dataDir = path.resolve(process.env.VCH_DATA_DIR || path.join(import.meta.dirname, "data"));

/** Forwards a value to the desktop app over stdout when running inside Tauri. */
function toHost(value) {
  if (!process.env.VCH_HOST_ACTIONS_FILE) return;
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    /* the desktop app reads what it can */
  }
}

const desktop = process.env.VCH_HOST_ACTIONS_FILE
  ? new DesktopBridge(process.stdin, (message) => process.stdout.write(`${JSON.stringify(message)}\n`))
  : null;

const hub = await startHub({
  dataDir,
  startIde: process.env.VCH_IDE_AUTOSTART !== "false",
  desktop: !!desktop,
  desktopStartup: desktop ? (enabled) => desktop.startup(enabled) : undefined,
  hostAction: (action, body) => {
    if (!process.env.VCH_HOST_ACTIONS_FILE) return false;
    toHost({ vch: "host-action", action, body, result: null });
    return true;
  },
  openExternal: (url) => {
    const platform = os.platform();
    try {
      import("node:child_process").then(({ spawn }) => {
        const command =
          platform === "win32"
            ? spawn("cmd", ["/c", "start", "", url], { detached: true, windowsHide: true, stdio: "ignore" })
            : platform === "darwin"
              ? spawn("open", [url], { detached: true, stdio: "ignore" })
              : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
        command.unref?.();
      });
    } catch {
      /* the dashboard shows the URL anyway */
    }
  },
});

hub.logger.info("app", `data folder: ${dataDir}`);
hub.logger.onOutput = (entry) => toHost({ vch: "log", ...entry });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  hub.logger.info("app", `received ${signal}; stopping…`);
  await hub.stop().catch((error) => hub.logger.error("app", `stop failed: ${error?.stack || error?.message || error}`));
  desktop?.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGHUP", () => void shutdown("SIGHUP"));
if (process.platform === "win32" && process.stdin?.isTTY) process.stdin.on("end", () => void shutdown("EOF"));
// Desktop app mode: the app may quit or crash without stopping us; never outlive it.
if (process.env.VCH_HOST_ACTIONS_FILE) {
  const owner = process.ppid;
  const ownerAlive = () => {
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return /** @type {any} */ (error)?.code === "EPERM";
    }
  };
  setInterval(() => {
    if (!ownerAlive()) void shutdown("owner exited");
  }, 2000).unref();
}
process.on("uncaughtException", (error) => hub.logger.error("app", `uncaught: ${error?.stack || error?.message || error}`));
process.on("unhandledRejection", (/** @type {any} */ reason) =>
  hub.logger.error("app", `unhandled rejection: ${reason?.stack || reason?.message || reason}`),
);
