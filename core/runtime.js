/** code-server lifecycle: spawn on the bundled Node, health-check, restart, crash detection. */
import fs from "node:fs";
import path from "node:path";
import { waitForHttp } from "./supervisor.js";

const LABEL = "code-server";

/**
 * Finds the code-server entry script and the Node binary shipped with it.
 * @param {string} runtimeDirectory
 * @returns {{ nodeBin: string | null, entry: string } | null}
 */
export function resolveSpawn(runtimeDirectory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, "package.json"), "utf8"));
    if (!manifest.main) return null;
    const entry = path.join(runtimeDirectory, manifest.main);
    if (!fs.existsSync(entry)) return null;
    const binary = process.platform === "win32" ? "node.exe" : "node";
    const nodeBin =
      [path.join(runtimeDirectory, "lib", binary), path.join(runtimeDirectory, "bin", binary)].find((file) =>
        fs.existsSync(file),
      ) ?? null;
    return { nodeBin, entry };
  } catch {
    return null;
  }
}

/** @typedef {"stopped" | "starting" | "running" | "stopping" | "crashed"} RuntimeState */

export class CodeServerLauncher {
  /** @type {RuntimeState} */
  #state = "stopped";
  #pid;
  #startedAt;
  #lastError;
  #starting;

  /**
   * @param {{
   *   config: import("./config.js").AppConfig,
   *   logger: import("./logger.js").Logger,
   *   supervisor: import("./supervisor.js").Supervisor,
   *   dataDir: string,
   *   runtimeDir: string,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    deps.supervisor.on("exit", ({ label, code, signal }) => {
      if (label !== LABEL) return;
      this.#pid = undefined;
      if (this.#state === "stopping") return;
      this.#state = "crashed";
      this.#lastError = `code-server exited unexpectedly (code=${code}, signal=${signal})`;
      deps.logger.error("supervisor", this.#lastError);
    });
  }

  get runtimeDir() {
    return this.deps.runtimeDir;
  }

  get port() {
    return this.deps.config.ide.port;
  }

  dirs() {
    const ide = path.join(this.deps.dataDir, "ide");
    return { userData: path.join(ide, "user-data"), extensions: path.join(ide, "extensions") };
  }

  start() {
    if (this.#state === "running") return Promise.resolve(this.status());
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start() {
    const { config, logger, supervisor } = this.deps;
    this.#state = "starting";
    this.#lastError = undefined;
    try {
      const dirs = this.dirs();
      for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
      const resolved = resolveSpawn(this.runtimeDir);
      if (!resolved)
        throw new Error(`code-server runtime not found at ${this.runtimeDir}. Run "npm run install-runtime" first.`);
      const port = config.ide.port;
      // code-server stays on loopback without its own auth: the hub proxy is the only way in.
      const args = [
        resolved.entry,
        "--bind-addr",
        `127.0.0.1:${port}`,
        "--auth",
        "none",
        "--user-data-dir",
        dirs.userData,
        "--extensions-dir",
        dirs.extensions,
        "--disable-telemetry",
        "--disable-getting-started-override",
        "--disable-update-check",
        "--app-name",
        "VISTTA Code Hub",
      ];
      if (!config.ide.workspaceTrust) args.push("--disable-workspace-trust");
      args.push(...config.ide.extraArgs);
      const record = supervisor.spawn({
        label: LABEL,
        command: resolved.nodeBin ?? process.execPath,
        args,
        // code-server reads these from the environment; clear any inherited values.
        env: { PASSWORD: "", HASHED_PASSWORD: "" },
        cwd: this.runtimeDir,
        onStdout: (chunk) => logger.info("ide", chunk.toString().trim()),
        onStderr: (chunk) => logger.info("ide", chunk.toString().trim()),
      });
      this.#pid = record.pid;
      await waitForHttp(`http://127.0.0.1:${port}/healthz`, 90_000);
      if (!supervisor.get(LABEL)) throw new Error("code-server exited during startup");
      this.#state = "running";
      this.#startedAt = Date.now();
      logger.info("supervisor", `code-server running on 127.0.0.1:${port} (pid ${record.pid})`);
      return this.status();
    } catch (error) {
      this.#state = "crashed";
      this.#lastError = error instanceof Error ? error.message : String(error);
      logger.error("supervisor", `failed to start code-server: ${this.#lastError}`);
      await supervisor.kill(LABEL, 5000);
      throw error;
    }
  }

  async stop() {
    await this.#starting?.catch(() => undefined);
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    await this.deps.supervisor.kill(LABEL, 15_000);
    this.#state = "stopped";
    this.#pid = undefined;
    this.#startedAt = undefined;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  status() {
    return {
      state: this.#state,
      pid: this.#pid,
      port: this.port,
      startedAt: this.#startedAt ? new Date(this.#startedAt).toISOString() : undefined,
      uptimeMs: this.#startedAt ? Date.now() - this.#startedAt : undefined,
      lastError: this.#lastError,
    };
  }
}
