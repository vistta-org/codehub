#!/usr/bin/env vistta
/**
 * Prints the pairing code on the terminal (and a QR code with the LAN share
 * URLs when sharing is on), for headless hosts.
 *
 * Usage:
 *   node scripts/pair.js            # show current/created pairing code
 *   node scripts/pair.js --watch    # reprint whenever the code changes
 */
import fs from "node:fs";
import path from "node:path";
import { DeviceStore } from "../core/devices.js";

const dataDir = path.resolve(process.env.VCH_DATA_DIR || path.join(import.meta.dirname, "..", "data"));
fs.mkdirSync(dataDir, { recursive: true });

const devices = new DeviceStore(dataDir);
let pairing = devices.pairing ?? devices.startPairing(15 * 60_000);

const show = async () => {
  console.log("\n=== Vistta Code Hub — pair a device ===");
  console.log(`Code: ${pairing.code}  (expires ${pairing.expiresAt})`);
  console.log("On the device, choose Pair and enter this code together with the host address.");
  const qr = await import("qrcode");
  const text = JSON.stringify({ host: process.env.VCH_HOST ?? "", code: pairing.code });
  const terminal = await qr.toString(text, { type: "terminal", small: true });
  console.log(terminal);
};

await show();

if (process.argv.includes("--watch")) {
  // The DeviceStore writes only in-memory here; a long-lived host prints new
  // codes itself. This simple loop re-issues a fresh code when it expires.
  const expiry = Date.parse(pairing.expiresAt);
  const wait = Math.max(0, expiry - Date.now() + 500);
  setTimeout(() => {
    pairing = devices.startPairing(15 * 60_000);
    void show().then(() => process.exit(0));
  }, wait);
}
