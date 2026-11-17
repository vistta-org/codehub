/**
 * IDE windows: each host's IDE opens in its own frameless native window. The
 * local IDE is the proxied `http://127.0.0.1:<hub-port>/`; a remote host's IDE
 * is its loopback relay (see `hub/remotes.js`). IDE windows only hold the
 * window-control capability (`app/setup.js`), never app IPC. `ideInBrowser`
 * is the fallback when window creation is denied (Linux WebKitGTK risk).
 */
import { BASE } from "./api.js";

/** Label of the local IDE window; remote ones are `ide-remote-<id>`. */
export const IDE_WINDOW_LABEL = "ide";

/** @type {Map<string, { window: any, home: string }>} */
const windows = new Map();

/**
 * Opens (or focuses) an IDE window at `url`. Resolves true when the native
 * window was created/focused; false when the caller should fall back to the
 * browser.
 * @param {string} [url]
 * @param {{ label?: string, title?: string }} [options]
 */
export async function openIdeWindow(url = `${BASE}/`, { label = IDE_WINDOW_LABEL, title = "Vistta Code Hub — IDE" } = {}) {
  const existing = windows.get(label);
  if (existing) {
    try {
      await existing.window.show();
      await existing.window.setFocus();
      if (url && url !== existing.home) await navigate(existing.window, url);
      return true;
    } catch {
      windows.delete(label);
    }
  }
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const ide = new WebviewWindow(label, {
      url,
      title,
      width: 1280,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      center: true,
      visible: true,
      // VS Code's own title bar plus hub/titlebar.js replace the native frame.
      decorations: false,
      // Let HTML5 drag drop reach the IDE; the native window isn't a drop target.
      dragDropEnabled: false,
    });
    const created = await new Promise((resolve) => {
      ide.once("tauri://created", () => resolve(true));
      ide.once("tauri://error", () => resolve(false));
      setTimeout(() => resolve(false), 10_000);
    });
    if (!created) return false;
    await ide.show();
    await ide.setFocus();
    void ide.once("tauri://destroyed", () => windows.delete(label));
    windows.set(label, { window: ide, home: new URL("/", url).toString() });
    return true;
  } catch {
    return false;
  }
}

/** Navigates an IDE window (e.g. `/?folder=…` deep links). */
async function navigate(window, url) {
  try {
    if (typeof window.navigate === "function") return void (await window.navigate(url));
  } catch {
    /* deep links land on the next manual open instead */
  }
}

/** An IDE window is open (native window, not the browser fallback). */
export function ideWindowOpen(label = IDE_WINDOW_LABEL) {
  return windows.has(label);
}

/**
 * Opens an IDE in the system browser (explicit fallback; also the
 * `openInBrowser` host action). Leaves any IDE window as it is.
 * @param {string} [url]
 */
export async function ideInBrowser(url = `${BASE}/`) {
  try {
    const { Shell } = await import("@vistta/js-native/plugins");
    await Shell.open(url);
  } catch {
    window.open(url, "_blank");
  }
}

/** Closes every IDE window when the app shuts down (best effort). */
export async function closeIdeWindows() {
  const open = [...windows.values()];
  windows.clear();
  for (const { window } of open) {
    try {
      await window.destroy();
    } catch {
      /* already closed */
    }
  }
}
