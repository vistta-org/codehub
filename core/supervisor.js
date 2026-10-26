/** Child-process supervision: spawn, track, health-check and kill process trees. */
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

const isWindows = process.platform === "win32";

/** Forcefully ends a process and its descendants. */
export function killTree(pid) {
  try {
    if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Whether a process with this ID still exists. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Runs detached: if the owner process disappears without cleaning up (for
// example when the host app is force-closed), it ends the orphaned child tree.
const GUARD_SCRIPT = `
const [owner, child] = process.argv.slice(-2).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const timer = setInterval(() => {
  if (!alive(child)) return process.exit(0);
  if (alive(owner)) return;
  clearInterval(timer);
  try {
    if (process.platform === "win32") require("child_process").spawnSync("taskkill", ["/PID", String(child), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(child, "SIGTERM");
  } catch {}
  process.exit(0);
}, 1000);
`;

/**
 * Supervises labelled child processes. Emits `exit` with `{ label, code, signal, pid }`.
 */
export class Supervisor extends EventEmitter {
  /** @type {Map<string, { proc: import("node:child_process").ChildProcess, pid: number, startedAt: number, label: string, guard?: import("node:child_process").ChildProcess }>} */
  #processes = new Map();

  /**
   * @param {{
   *   label: string,
   *   command: string,
   *   args?: string[],
   *   env?: Record<string, string | undefined>,
   *   cwd?: string,
   *   onStdout?: (chunk: Buffer) => void,
   *   onStderr?: (chunk: Buffer) => void,
   *   guard?: boolean,
   * }} options
   */
  spawn(options) {
    if (this.#processes.has(options.label)) throw new Error(`${options.label} is already running`);
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined),
    );
    const child = spawn(options.command, options.args ?? [], {
      env,
      cwd: options.cwd,
      windowsHide: true,
      shell: isWindows && options.command.toLowerCase().endsWith(".cmd"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error(`Could not start ${options.label}`);
    const record = { proc: child, pid: child.pid, startedAt: Date.now(), label: options.label, guard: undefined };
    if (options.guard !== false) {
      record.guard = spawn(process.execPath, ["-e", GUARD_SCRIPT, String(process.pid), String(child.pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      record.guard.unref();
    }
    this.#processes.set(options.label, record);
    child.stdout?.on("data", (chunk) => options.onStdout?.(chunk));
    child.stderr?.on("data", (chunk) => options.onStderr?.(chunk));
    child.once("exit", (code, signal) => {
      this.#processes.delete(options.label);
      this.emit("exit", { label: options.label, code: code ?? -1, signal: signal ?? null, pid: record.pid });
    });
    return record;
  }

  /** @param {string} label */
  get(label) {
    return this.#processes.get(label);
  }

  get size() {
    return this.#processes.size;
  }

  /**
   * Terminates a process tree: graceful first, forced after `timeoutMs`.
   * @param {string} label
   */
  async kill(label, timeoutMs = 10_000) {
    const record = this.#processes.get(label);
    if (!record) return false;
    const exited = new Promise((resolve) => record.proc.once("exit", () => resolve(true)));
    // Windows has no graceful signal for console-less children.
    if (isWindows) killTree(record.pid);
    else record.proc.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    if (!result) {
      killTree(record.pid);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    return !this.#processes.has(label);
  }

  async stopAll(timeoutMs = 10_000) {
    await Promise.all([...this.#processes.keys()].map((label) => this.kill(label, timeoutMs)));
  }
}

/**
 * Waits until an HTTP endpoint answers (any 2xx, or 401/302 when auth is up).
 * @param {string} url
 */
export async function waitForHttp(url, timeoutMs = 60_000, intervalMs = 300) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(intervalMs * 4) });
      if (response.ok || response.status === 401 || response.status === 302) return;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Endpoint did not become ready in ${timeoutMs}ms: ${url} (${last?.message ?? last})`);
}
