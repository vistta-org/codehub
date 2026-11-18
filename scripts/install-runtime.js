#!/usr/bin/env node
/**
 * install-runtime.js — downloads the code-server runtime this project runs on.
 *
 * Windows/Linux amd64+arm64 use the official prebuilt release tarball; other
 * platforms (macOS) fall back to `npm install code-server`. Also downloads the
 * bundled IDE extensions shipped with the hub into `runtime/extensions`.
 *
 * Usage:
 *   node scripts/install-runtime.js             # auto-detect version + platform
 *   node scripts/install-runtime.js --force     # re-download even if present
 *   node scripts/install-runtime.js --version 4.141.0
 *   node scripts/install-runtime.js --check     # dry run, show plan only
 *   node scripts/install-runtime.js --platform windows  # another OS's runtime (cross-builds; no smoke test)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REPO = "coder/code-server";
const ROOT = path.join(import.meta.dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const CS_DIR = path.join(RUNTIME_DIR, "code-server");
const MANIFEST = path.join(RUNTIME_DIR, "runtime-manifest.json");
const EXTENSIONS_DIR = path.join(RUNTIME_DIR, "extensions");

// Installed into the IDE on first start; pinned by version and checksum.
const BUNDLED_EXTENSIONS = [
  {
    file: "ollama-vscode-0.0.14.vsix",
    url: "https://github.com/ollama/ollama-vscode/releases/download/v0.0.14/ollama-vscode-0.0.14.vsix",
    sha256: "a811fd4b6d68b6aa6dbbf12dd0af6c75f3530789b461001add17cdb7ed1e5262",
  },
];

const args = process.argv.slice(2);
const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hasFlag = (name) => args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(fs.readFileSync(import.meta.filename, "utf8").split(/Usage:/)[1]);
  process.exit(0);
}

const FORCE = hasFlag("--force");
const CHECK_ONLY = hasFlag("--check");
const VERSION = getArg("--version") || process.env.CODE_SERVER_VERSION || undefined;
const PLATFORMS = { windows: "win32", linux: "linux" };
const TARGET = getArg("--platform");
if (TARGET && !PLATFORMS[TARGET]) {
  console.error(`[install-runtime] ERROR: --platform must be one of: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(1);
}
const PLATFORM = TARGET ? PLATFORMS[TARGET] : os.platform();
const CROSS = PLATFORM !== os.platform();

const log = (message) => console.log(`[install-runtime] ${message}`);
const warn = (message) => console.warn(`[install-runtime] WARN: ${message}`);
function fatal(message) {
  console.error(`[install-runtime] ERROR: ${message}`);
  process.exit(1);
}

function platformInfo() {
  const platform = PLATFORM;
  const arch = CROSS ? "x64" : os.arch();
  if (platform === "win32") {
    if (arch !== "x64") fatal(`Unsupported Windows architecture: ${arch} (only amd64 releases are published)`);
    return { os: "windows", arch: "amd64", asset: (version) => `code-server-${version}-windows-amd64.tar.gz` };
  }
  if (platform === "linux") {
    if (arch === "x64")
      return { os: "linux", arch: "amd64", asset: (version) => `code-server-${version}-linux-amd64.tar.gz` };
    if (arch === "arm64")
      return { os: "linux", arch: "arm64", asset: (version) => `code-server-${version}-linux-arm64.tar.gz` };
    fatal(`Unsupported Linux architecture: ${arch}`);
  }
  if (platform === "darwin") return { os: "macos", arch, asset: null };
  fatal(`Unsupported platform: ${platform}`);
}

async function download(url, destination) {
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fatal(`download failed: HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(destination, buffer);
  log(`saved ${(buffer.length / 1024 / 1024).toFixed(1)} MB -> ${path.relative(ROOT, destination)}`);
}

/** Extract .tar.gz, flattening the single top-level code-server-X dir into destDir. */
function extractTarGz(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const staging = `${destDir}.__staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", staging], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (tar.status !== 0)
    fatal(
      `tar extraction failed (exit ${tar.status}). Is bsdtar/tar available? (Windows 10+ ships tar.exe; macOS/Linux include it.)`,
    );

  const entries = fs.readdirSync(staging, { withFileTypes: true });
  const root = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("code-server"));
  fs.rmSync(destDir, { recursive: true, force: true });
  if (root) fs.renameSync(path.join(staging, root.name), destDir);
  else fs.renameSync(staging, destDir);
  fs.rmSync(staging, { recursive: true, force: true });

  for (const bin of [path.join(destDir, "bin", "code-server"), path.join(destDir, "bin", "code-server.cmd")]) {
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      /* best effort on win32 */
    }
  }
}

/** npm fallback (macOS, or any platform lacking a release asset). */
function installViaNpm(version) {
  log("no prebuilt release for this platform — installing via npm into an isolated prefix");
  const prefix = path.join(RUNTIME_DIR, "npm");
  fs.mkdirSync(prefix, { recursive: true });
  const pkg = version ? `code-server@${version}` : "code-server";
  const result = spawnSync("npm", ["install", "--prefix", prefix, pkg], { stdio: "inherit" });
  if (result.status !== 0) fatal("npm install of code-server failed. On macOS ensure Xcode CLT: xcode-select --install.");
  const bin = path.join(prefix, "node_modules", "code-server", "bin", "code-server");
  if (!fs.existsSync(bin)) fatal("npm install finished but code-server CLI not found where expected");
  return { kind: "npm", bin, binDir: path.join(prefix, "node_modules", ".bin") };
}

function resolveLatestVersion() {
  log("resolving latest code-server release version…");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    fetch('https://api.github.com/repos/${REPO}/releases/latest', { headers: { 'User-Agent': 'vistta-codehub' } })
      .then((r) => { if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); } return r.json(); })
      .then((j) => console.log((j.tag_name || '').replace(/^v/, '')))
      .catch((e) => { console.error(e); process.exit(1); });
  `,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) fatal(`could not resolve latest version: ${result.stderr || result.stdout}`);
  const version = result.stdout.trim();
  if (!version) fatal("empty version tag from GitHub API");
  return version;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function installBundledExtensions() {
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  for (const extension of BUNDLED_EXTENSIONS) {
    const dest = path.join(EXTENSIONS_DIR, extension.file);
    if (fs.existsSync(dest) && sha256(dest) === extension.sha256) continue;
    const partial = `${dest}.download`;
    await download(extension.url, partial);
    if (sha256(partial) !== extension.sha256) {
      fs.rmSync(partial, { force: true });
      fatal(`checksum mismatch for ${extension.file}`);
    }
    fs.renameSync(partial, dest);
    log(`bundled extension ready: ${extension.file}`);
  }
}

function smokeTest(bin, winSuffix) {
  const cli =
    process.platform === "win32"
      ? bin + (fs.existsSync(bin + winSuffix) ? winSuffix : fs.existsSync(bin + ".cmd") ? ".cmd" : winSuffix)
      : bin;
  const result = spawnSync(cli, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status === 0) log(`smoke test OK: ${(result.stdout || "").trim().split(/\r?\n/)[0]}`);
  else if (result.error) warn(`smoke test failed: ${result.error.message}`);
  else warn(`smoke test exited ${result.status}${result.stderr ? `: ${result.stderr.trim().split(/\r?\n/)[0]}` : ""}`);
}

async function main() {
  const plat = platformInfo();
  const envOverride = process.env.CODE_SERVER_COMMAND;

  if (CHECK_ONLY) {
    log(`platform: ${plat.os}/${plat.arch}`);
    if (envOverride) log(`strategy: external (${envOverride})`);
    else log(`strategy: ${plat.asset ? "release-binary" : "npm"}`);
    if (VERSION) log(`version: ${VERSION}`);
    const manifest = readManifest();
    if (manifest) log(`current manifest: ${manifest.kind} ${manifest.version || ""}`);
    log("dry run complete.");
    return;
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  // 1) Explicit external command wins — nothing is downloaded or managed here.
  if (envOverride) {
    log(`using external code-server command: ${envOverride}`);
    return;
  }

  // 2) Already managed and not forcing → skip.
  const prev = readManifest();
  if (prev && prev.kind === "release-binary" && prev.version && prev.platform === plat.os && !FORCE) {
    const alreadyHavePinned = VERSION && prev.version === VERSION;
    if (!VERSION || alreadyHavePinned) {
      log(`code-server ${prev.version} already installed — nothing to do (use --force to reinstall).`);
      await installBundledExtensions();
      return;
    }
  }

  // 3) Download path (windows/linux) or npm fallback (macos).
  if (plat.asset) {
    const version = VERSION || resolveLatestVersion();
    const url = `https://github.com/${REPO}/releases/download/v${version}/${plat.asset(version)}`;
    const archive = path.join(RUNTIME_DIR, path.basename(url));
    await fsp.rm(archive, { force: true }).catch(() => undefined);
    await download(url, archive);
    extractTarGz(archive, CS_DIR);
    await fsp.rm(archive, { force: true }).catch(() => undefined);
    const manifest = {
      kind: "release-binary",
      version,
      bin: path.join(CS_DIR, "bin", "code-server"),
      platform: plat.os,
      arch: plat.arch,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    log(`code-server ${version} installed -> ${path.relative(ROOT, CS_DIR)}`);
    if (CROSS) log(`smoke test skipped: a ${plat.os} runtime cannot run on this host`);
    else smokeTest(manifest.bin, ".exe");
  } else {
    const managed = installViaNpm(VERSION);
    const manifest = {
      kind: "npm",
      version: VERSION || "latest",
      bin: managed.bin,
      binDir: managed.binDir,
      platform: plat.os,
      arch: plat.arch,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    log(`code-server (npm) CLI -> ${path.relative(ROOT, managed.bin)}`);
    smokeTest(managed.bin, "");
  }

  await installBundledExtensions();
  log("done.");
}

main().catch((error) => fatal(error instanceof Error ? error.stack || error.message : String(error)));
