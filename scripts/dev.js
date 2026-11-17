#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.VCH_SERVER_PORT || 8181);
const address = `http://127.0.0.1:${port}/api/health`;
const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@vistta/cli"))), "bin.js");
let backend;
let desktop;
let interrupted = false;
let backendError;

function runtimeDir() {
  if (process.env.VCH_RUNTIME_DIR || process.env.VCH_RUNTIME_ROOT) return {};
  const local = path.join(root, "runtime", "code-server", "package.json");
  if (fs.existsSync(local)) return {};
  const sibling = path.resolve(root, "..", "..", "code-server", "runtime", "code-server");
  if (fs.existsSync(path.join(sibling, "package.json"))) return { VCH_RUNTIME_DIR: sibling };
  throw new Error('No code-server runtime found. Run "npm run install-runtime" first or set VCH_RUNTIME_DIR.');
}

async function waitForIde(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !interrupted) {
    if (backendError) throw backendError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Hub exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
    let response;
    try {
      response = await fetch(address, { signal: AbortSignal.timeout(2000) });
    } catch (error) {
      if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
    }
    if (response?.ok) {
      const health = await response.json();
      if (health.ide?.state === "running") return;
      if (health.ide?.state === "crashed")
        throw new Error(`IDE failed to start: ${health.ide.lastError ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!interrupted) throw new Error(`Hub/IDE did not become ready at ${address}`);
}

async function stopBackend() {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
  const exited = new Promise((resolve) => backend.once("exit", resolve));
  backend.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (backend.exitCode === null) {
    backend.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VCH_SERVER_PORT must be a valid port");
  if (port !== 8181) throw new Error("The desktop app currently connects to port 8181; remove VCH_SERVER_PORT");
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(1000) });
    if (response) throw new Error(`Port ${port} is already in use; stop the existing hub before running npm run dev`);
  } catch (error) {
    if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
  }
  backend = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, ...runtimeDir() },
    stdio: "inherit",
  });
  backend.on("error", (error) => (backendError = error));
  await waitForIde(backend);
  if (interrupted) return;
  desktop = spawn(process.execPath, [cli, "run", "./app", `--setup=./app/setup.js`, "--out=build/app", "--dev"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    desktop.once("error", reject);
    desktop.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (!interrupted && result.code !== 0)
    throw new Error(`Desktop app exited (code ${result.code}, signal ${result.signal})`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    desktop?.kill("SIGTERM");
  });
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopBackend();
}
