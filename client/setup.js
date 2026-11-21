/**
 * Android client setup: the config `vistta run|build ./client android` consumes.
 * Client only: it pairs with computers running Vistta Code Hub and opens their
 * IDE; it runs no hub of its own (Android cannot run code-server's Node 24
 * runtime). All hub traffic goes through js-native's Pinned bridge, so the
 * page itself only needs IPC.
 */
import { style } from "@vistta/ui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const icon = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
const defaultKeystore = join(import.meta.dirname, "../android.keystore");

/** @typedef {Record<string, any>} SetupConfig */

/** @returns {Promise<SetupConfig>} */
export default async function setup() {
  const keystore = process.env.ANDROID_KEYSTORE || defaultKeystore;
  return {
    title: "Vistta Code Hub",
    icon,
    // VS Code Dark Modern palette and type, with the logo orange as accent.
    styles: [
      style({
        colors: {
          dark: "#1f1f1f",
          light: "#cccccc",
          primary: "#ad6d32",
          secondary: "#313131",
          info: "#3794ff",
          success: "#2ea043",
          warning: "#cca700",
          error: "#f85149",
        },
        radius: "2px",
        font: {
          family: '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Roboto, "Droid Sans", sans-serif',
          size: { default: "3.5rem", small: "3rem" },
        },
        icon: { size: "1.25em" },
        border: { color: "#3c3c3c" },
      }),
    ],
    description: "Open the IDE of your computers from your phone",
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
    colorScheme: "dark",
    theme: "#181818",
    app: {
      id: "org.vistta.codehub",
      name: "Vistta Code Hub",
    },
    csp: {
      "default-src": "'self' ipc: http://ipc.localhost",
      "connect-src": "'self' ipc: http://ipc.localhost",
      "img-src": "'self' data: blob:",
    },
    ...(process.env.NODE_ENV === "production" && existsSync(keystore)
      ? { keystore: { file: keystore, password: process.env.ANDROID_KEYSTORE_PASSWORD } }
      : {}),
  };
}
