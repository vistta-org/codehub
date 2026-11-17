/** IDE extension management through the code-server CLI (same extensions dir as the running IDE). */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";
import { resolveSpawn } from "./runtime.js";

export class ExtensionManager {
  /**
   * @param {{ runtimeDir: string, extensionsDir: string, logger: import("./logger.js").Logger }} deps
   */
  constructor(deps) {
    this.deps = deps;
  }

  list() {
    const dir = this.deps.extensionsDir;
    if (!fs.existsSync(dir)) return [];
    const manifestPath = path.join(dir, "extensions.json");
    if (fs.existsSync(manifestPath)) {
      try {
        return JSON.parse(fs.readFileSync(manifestPath, "utf8")).map((entry) => ({
          id: entry.identifier.id,
          version: entry.version,
          location: path.join(dir, entry.relativeLocation ?? ""),
        }));
      } catch {
        this.deps.logger.warn("api", `Could not parse ${manifestPath}; scanning folders instead`);
      }
    }
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const match = /^(?<id>[^.]+\.[^-]+)-(?<version>[\d.]+).*$/.exec(entry.name);
        return {
          id: match?.groups?.id ?? entry.name,
          version: match?.groups?.version ?? "unknown",
          location: path.join(dir, entry.name),
        };
      });
  }

  /** Makes the host's web extension available without depending on workbench patch anchors. */
  installBuiltIn(manifest, script) {
    const root = this.deps.extensionsDir;
    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    const relativeLocation = `${id}-${manifest.version}`;
    const location = path.join(root, relativeLocation);
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(path.join(location, "package.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(location, "extension.js"), script);
    const index = path.join(root, "extensions.json");
    const entries = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, "utf8")) : [];
    if (!Array.isArray(entries)) throw new Error(`Invalid extension index: ${index}`);
    const current = entries.filter((entry) => entry.identifier?.id?.toLowerCase() !== id);
    current.push({
      identifier: { id },
      version: manifest.version,
      location: { fsPath: location, path: location.replaceAll("\\", "/"), scheme: "file" },
      relativeLocation,
      metadata: { installedTimestamp: Date.now(), pinned: true, source: "resource" },
    });
    const temporary = `${index}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(current));
    fs.renameSync(temporary, index);
  }

  #cli(args, timeout) {
    const resolved = resolveSpawn(this.deps.runtimeDir);
    if (!resolved) throw new AppError('code-server runtime missing — run "npm run install-runtime"', 500, "runtime_missing");
    fs.mkdirSync(this.deps.extensionsDir, { recursive: true });
    const result = spawnSync(
      resolved.nodeBin ?? process.execPath,
      [resolved.entry, "--extensions-dir", this.deps.extensionsDir, ...args],
      { encoding: "utf8", cwd: this.deps.runtimeDir, windowsHide: true, timeout },
    );
    if (result.status !== 0) {
      const output = result.stderr || result.stdout || result.error?.message || "unknown error";
      throw new AppError(`Extension command failed: ${output}`, 500, "extension_failed");
    }
  }

  /** @param {string} id extension ID or VSIX path */
  install(id) {
    if (typeof id !== "string" || !id) throw new AppError("id is required", 400, "invalid_request");
    const before = new Set(this.list().map((entry) => `${entry.id}@${entry.version}`));
    this.#cli(["--install-extension", id, "--disable-telemetry"], 180_000);
    const after = this.list();
    const found =
      after.find((entry) => entry.id.toLowerCase() === id.toLowerCase()) ??
      after.find((entry) => id.toLowerCase().includes(entry.id.toLowerCase())) ??
      after.find((entry) => !before.has(`${entry.id}@${entry.version}`));
    if (!found) throw new AppError(`Install reported success but ${id} was not found`, 500, "install_failed");
    return found;
  }

  /** @param {string} id */
  uninstall(id) {
    this.#cli(["--uninstall-extension", id], 60_000);
  }

  /** Installs each bundled VSIX once, so later uninstalls are respected. */
  installBundled(dir) {
    if (!fs.existsSync(dir)) return;
    const marker = path.join(this.deps.extensionsDir, ".bundled.json");
    let done = [];
    try {
      done = JSON.parse(fs.readFileSync(marker, "utf8"));
    } catch {
      /* first run */
    }
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".vsix") || done.includes(file)) continue;
      try {
        const installed = this.install(path.join(dir, file));
        this.deps.logger.info("app", `Bundled extension installed: ${installed.id} ${installed.version}`);
        done.push(file);
        fs.writeFileSync(marker, JSON.stringify(done));
      } catch (error) {
        this.deps.logger.warn("app", `Bundled extension ${file} not installed: ${error.message}`);
      }
    }
  }
}
