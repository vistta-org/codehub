/**
 * Desktop app setup: the config `vistta run|build ./app` consumes. One app
 * for both roles: it runs this computer's hub (spawning the bundled payload
 * when present) and opens IDEs on paired computers through that hub. The
 * `main` webview stays hidden (lifecycle, tray, IPC); everything visible is
 * an IDE window (`ide-window.js`). The app keeps running in the tray.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const icon = fileURLToPath(new URL("./icon.png", import.meta.url));

/** Platform of the bundled runtime, which may differ from the host in cross-builds. */
function runtimePlatform() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../runtime/runtime-manifest.json", import.meta.url), "utf8")).platform;
  } catch {
    return process.platform === "win32" ? "windows" : process.platform;
  }
}

/** Window controls the frameless IDE windows may use, and nothing else. */
const IDE_WINDOW_CAPABILITY = {
  identifier: "ide-window-controls",
  description: "Title-bar buttons and dragging for the frameless IDE windows (hub/titlebar.js)",
  windows: ["ide", "ide-remote-*"],
  remote: { urls: ["http://127.0.0.1:*"] },
  permissions: [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
  ],
};

/** @typedef {Record<string, any>} SetupConfig */

/** @returns {Promise<SetupConfig>} */
export default async function setup() {
  const bundled = process.env.NODE_ENV === "production";
  const binary = runtimePlatform() === "windows" ? "node.exe" : "node";
  return {
    title: "Vistta Code Hub",
    icon,
    description: "Your IDE on this computer and on the computers you pair with",
    viewport: "width=device-width, initial-scale=1",
    colorScheme: "dark",
    theme: "#1f1f1f",
    app: {
      id: "org.vistta.codehub",
      name: "Vistta Code Hub",
      // Tray icon + hide-on-close: the hub keeps running without a window.
      background: true,
      visible: false,
      width: 480,
      height: 320,
    },
    // Loopback API access from the tauri:// origin (hub serves CORS headers).
    csp: {
      "default-src": "'self' ipc: http://ipc.localhost",
      "connect-src": "'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*",
      "img-src": "'self' data: blob:",
    },
    // extraCapabilities merge into the `default` capability, whose `windows`
    // list is ["main"] only. IDE windows load loopback URLs and only get
    // IDE_WINDOW_CAPABILITY (window controls), never app IPC.
    extraCapabilities: [
      { identifier: "fs:scope", allow: [{ path: "$RESOURCE/codehub/**" }] },
      ...(bundled
        ? [
            {
              identifier: "shell:allow-spawn",
              allow: ["lib", "bin"].map((directory) => ({
                name: `codehub-node-${directory}`,
                cmd: `$RESOURCE/codehub/runtime/code-server/${directory}/${binary}`,
                args: true,
              })),
            },
            "shell:allow-kill",
            "shell:allow-stdin-write",
          ]
        : []),
      // Runtime IDE windows (labels "ide" and "ide-remote-<id>"), from main only.
      "core:window:allow-create",
      "core:webview:allow-create-webview-window",
      "core:window:allow-set-focus",
      "core:window:allow-show",
      "core:window:allow-hide",
      "core:window:allow-destroy",
    ],
    extraTauriConfig: {
      app: { security: { capabilities: ["default", IDE_WINDOW_CAPABILITY] } },
      ...(bundled
        ? {
            bundle: {
              resources: {
                "server.js": "codehub/server.js",
                "package.json": "codehub/package.json",
                "assets/": "codehub/assets/",
                "core/": "codehub/core/",
                "hub/": "codehub/hub/",
                "scripts/": "codehub/scripts/",
                "node_modules/": "codehub/node_modules/",
                "runtime/": "codehub/runtime/",
              },
            },
          }
        : {}),
    },
  };
}
