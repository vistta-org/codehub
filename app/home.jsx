/**
 * Hidden controller webview: starts this computer's hub, opens the IDE window
 * and handles tray actions plus the host actions the IDE extension requests
 * (all management lives in the IDE: Code Hub status-bar menu). Closing IDE
 * windows leaves the app in the tray; the hub keeps running.
 */
import { Component } from "@vistta/js";
import { api } from "./api.js";
import { ideInBrowser, openIdeWindow } from "./ide-window.js";
import { launchHub } from "./lifecycle.js";

const APP_NAME = "Vistta Code Hub";

/** Tray quick actions; payloads arrive as `launch-action` events. */
const TRAY_ACTIONS = [
  { id: "settings.open", label: "Settings" },
  { id: "device.pair", label: "Pair Device" },
];

/** Relay URLs the hub hands out for other computers' IDEs. */
const RELAY_URL = /^http:\/\/127\.0\.0\.1:\d+\//;

async function showIde() {
  const health = await api("/api/health");
  if (!health.ok || health.data?.ide?.state !== "running") {
    const started = await api("/api/ide/start", { method: "POST" });
    if (!started.ok) throw new Error(started.data?.error?.message ?? "The IDE could not start");
  }
  if (!(await openIdeWindow())) throw new Error("Could not open the IDE window");
}

async function showSettings() {
  const requested = await api("/_vch/host/openSettings", { method: "POST", context: "host" });
  if (!requested.ok) throw new Error(requested.data?.error?.message ?? "Could not open Settings");
  await showIde();
}

/** @param {{ id?: unknown, name?: unknown, url?: unknown }} [remote] */
async function showRemote(remote = {}) {
  const { id, name, url } = remote;
  if (typeof url !== "string" || !RELAY_URL.test(url) || typeof id !== "string" || !/^[\w-]+$/.test(id)) return;
  const title = `${typeof name === "string" && name ? name : "Remote"} — ${APP_NAME}`;
  if (!(await openIdeWindow(url, { label: `ide-remote-${id}`, title }))) await ideInBrowser(url);
}

async function pairDevice() {
  const result = await api("/_vch/host/pairDevice", {
    method: "POST",
    context: "host",
  });
  if (!result.ok) throw new Error(result.data?.error?.message ?? "Could not open device pairing");
  await showIde();
}

async function reportError(error) {
  console.error("[app]", error);
  try {
    const { Dialog } = await import("@vistta/js-native/plugins");
    await Dialog.message(error?.message ?? String(error), { title: APP_NAME, kind: "error" });
  } catch {
    /* no native dialogs (browser preview) */
  }
}

export default class Home extends Component {
  async onConnect() {
    if (window.platform !== "desktop") return;
    try {
      const { Accessibility } = await import("@vistta/js-native/plugins");
      if (!(await Accessibility.setShortcuts(TRAY_ACTIONS))) throw new Error("Could not configure the tray menu");
      Accessibility.onLaunchAction(({ id }) => {
        if (id === "show") void showIde().catch(reportError);
        else if (id === "settings.open") void showSettings().catch(reportError);
        else if (id === "device.pair") void pairDevice().catch(reportError);
      });
    } catch (error) {
      await reportError(error);
    }
    // Host actions the IDE extension requests, reported by the backend over stdout.
    window.addEventListener("vch-host", (event) => {
      const detail = /** @type {CustomEvent} */ (event).detail;
      if (detail?.vch !== "host-action") return;
      switch (detail.action) {
        case "openDashboard":
        case "pairDevice":
          void showIde().catch(reportError);
          break;
        case "openRemote":
          void showRemote(detail.body).catch(reportError);
          break;
        case "openInBrowser":
          void ideInBrowser().catch(reportError);
          break;
      }
    });
    try {
      await launchHub();
      const config = await api("/api/config");
      if (!config.ok) throw new Error(config.data?.error?.message ?? "Could not read desktop settings");
      if (!config.data.desktop.startMinimized) await showIde();
    } catch (error) {
      await reportError(error);
    }
  }

  render() {
    return null;
  }
}
