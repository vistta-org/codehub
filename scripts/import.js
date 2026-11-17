/**
 * import.js — one-time importer from Open Code Hub's `data/` folder.
 *
 * Migrates what still applies:
 * - `config.json` → the new config shape (`server.idePort` → `ide.port`,
 *   `UDD_*`/old defaults dropped), validated with the new rules;
 * - IDE data (`user-data`, `extensions`) → `ide/` in the new data folder;
 * - old logs stay behind.
 *
 * Usage:
 *   node scripts/import.js --from ../../code-server/data --to data
 *   node scripts/import.js --from ../../code-server/data          # default destination
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateConfig } from "../core/config.js";

const values = (needle) => {
  const index = process.argv.indexOf(needle);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
};
const hasFlag = (name) => process.argv.includes(name);

const from = path.resolve(values("--from") ?? path.join(import.meta.dirname, "..", "..", "code-server", "data"));
const to = path.resolve(values("--to") ?? path.join(import.meta.dirname, "..", "data"));

if (!fs.existsSync(from)) {
  console.error(`Source not found: ${from}`);
  process.exit(1);
}
if (path.resolve(from) === path.resolve(to)) {
  console.error("Source and destination must differ");
  process.exit(1);
}
if (fs.existsSync(to) && !hasFlag("--force")) {
  console.error(`Destination already exists: ${to} (use --force to merge over it)`);
  process.exit(1);
}
fs.mkdirSync(to, { recursive: true });

// --- config ---------------------------------------------------------------- //
try {
  const old = JSON.parse(fs.readFileSync(path.join(from, "config.json"), "utf8"));
  const projects = old.projects ?? {};
  const next = {
    name: old.name ?? "",
    server: {
      port: old.server?.port ?? undefined,
      share: false,
      logLevel: old.server?.logLevel ?? undefined,
      tls: {
        certFile: old.server?.tls?.certFile ?? undefined,
        keyFile: old.server?.tls?.keyFile ?? undefined,
        days: old.server?.tls?.selfSignedDays ?? undefined,
      },
    },
    ide: {
      port: old.server?.idePort ?? old.ide?.port ?? undefined,
      workspaceTrust: Boolean(old.ide?.workspaceTrust),
      extraArgs: Array.isArray(old.ide?.extraArgs) ? old.ide.extraArgs : undefined,
      installPath: old.ide?.installPath ?? undefined,
    },
    projects: { root: projects.root, recent: Array.isArray(projects.recent) ? projects.recent : undefined },
  };
  const config = validateConfig(next);
  fs.writeFileSync(path.join(to, "config.json"), JSON.stringify(config, null, 2));
  console.log(`config.json imported → ${path.join(to, "config.json")}`);
} catch (error) {
  console.warn(`config.json not imported: ${error instanceof Error ? error.message : error}`);
}

// --- IDE data ---------------------------------------------------------------
// user-data and extensions are large; move them wholesale. The IDE is not
// running during an import (stop the hub first).
const ideFrom = path.join(from, "ide");
const ideTo = path.join(to, "ide");
if (fs.existsSync(ideFrom)) {
  fs.rmSync(ideTo, { recursive: true, force: true });
  try {
    fs.renameSync(ideFrom, ideTo);
    console.log(`IDE data moved → ${ideTo}`);
  } catch {
    // Cross-device or locked: fall back to a copy.
    fs.cpSync(ideFrom, ideTo, { recursive: true });
    console.log(`IDE data copied → ${ideTo}`);
  }
  // Never carry over old workspace trust state; the new host is a different origin.
  const lockfile = path.join(ideTo, "user-data", "User", "workspaceStorage");
  if (fs.existsSync(lockfile)) console.log(`(kept workspace storage at ${lockfile})`);
}

// --- certificates -------------------------------------------------------------
// Old certificates are NOT imported: the new hub manages its own local CA.
// Devices must trust the new CA (fingerprint shown by `npm run cert`).

console.log("Import complete. Start the hub with `npm start` and pair devices again (device tokens are not migrated).");
