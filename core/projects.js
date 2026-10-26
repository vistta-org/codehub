/** Projects: real directories under the projects root, never copied into app data. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `child` is `parent` or inside it. */
export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export class ProjectStore {
  /**
   * @param {import("./config.js").AppConfig} config
   * @param {(recent: string[]) => void} [persistRecent]
   */
  constructor(config, persistRecent) {
    this.config = config;
    this.persistRecent = persistRecent;
  }

  get root() {
    return path.resolve(this.config.projects.root);
  }

  /** @param {string} candidate */
  #validate(candidate) {
    const absolute = path.resolve(candidate);
    if (!isInside(this.root, absolute))
      throw new AppError(`Project path must be inside the projects root (${this.root})`, 400, "invalid_path");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory())
      throw new AppError(`Project not found: ${absolute}`, 404, "not_found");
    return absolute;
  }

  list() {
    const root = this.root;
    if (!fs.existsSync(root)) return [];
    const recent = this.config.projects.recent;
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const projectPath = path.join(root, entry.name);
        const index = recent.indexOf(projectPath);
        return {
          name: entry.name,
          path: projectPath,
          isGitRepo: fs.existsSync(path.join(projectPath, ".git")),
          recent: index >= 0 ? index : undefined,
        };
      });
  }

  /**
   * @param {string} name
   * @param {{ gitInit?: boolean }} [options]
   */
  create(name, options = {}) {
    if (typeof name !== "string" || !NAME.test(name))
      throw new AppError("Project name must match [A-Za-z0-9][A-Za-z0-9._-]*", 400, "invalid_name");
    const absolute = path.join(this.root, name);
    if (fs.existsSync(absolute)) throw new AppError(`Project already exists: ${name}`, 409, "exists");
    fs.mkdirSync(absolute, { recursive: true });
    let isGitRepo = false;
    if (options.gitInit) {
      isGitRepo = spawnSync("git", ["init", "-b", "main"], { cwd: absolute, windowsHide: true, stdio: "ignore" }).status === 0;
    }
    return { name, path: absolute, isGitRepo };
  }

  /**
   * Validates a project name or path and records it as recent.
   * @param {string} nameOrPath
   */
  open(nameOrPath) {
    if (typeof nameOrPath !== "string" || !nameOrPath) throw new AppError("project is required", 400, "invalid_request");
    for (const candidate of [path.resolve(this.root, nameOrPath), path.resolve(nameOrPath)]) {
      try {
        const absolute = this.#validate(candidate);
        this.#markRecent(absolute);
        return absolute;
      } catch {
        /* try the next interpretation */
      }
    }
    throw new AppError(`Project not found: ${nameOrPath}`, 404, "not_found");
  }

  recent() {
    return [...this.config.projects.recent];
  }

  #markRecent(absolute) {
    const recent = [absolute, ...this.config.projects.recent.filter((entry) => entry !== absolute)].slice(0, 10);
    this.config.projects.recent = recent;
    this.persistRecent?.(recent);
  }
}
