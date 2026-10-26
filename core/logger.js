/** Console + JSONL file logging. Logging never crashes the host. */
import fs from "node:fs";
import path from "node:path";

const LEVELS = ["debug", "info", "warn", "error"];

/**
 * @typedef {{ ts: string, level: string, source: string, message: string, meta?: Record<string, unknown> }} LogEntry
 */

export class Logger {
  #file;
  #handle = null;
  #level;

  /**
   * @param {{ file?: string, level?: string, console?: boolean }} [options]
   */
  constructor({ file, level = "info", console: toConsole = true } = {}) {
    this.#file = file;
    this.#level = level;
    this.console = toConsole;
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  get file() {
    return this.#file;
  }

  setLevel(level) {
    if (LEVELS.includes(level)) this.#level = level;
  }

  /**
   * @param {string} level
   * @param {string} source
   * @param {string} message
   * @param {Record<string, unknown>} [meta]
   */
  #emit(level, source, message, meta) {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.#level)) return;
    /** @type {LogEntry} */
    const entry = { ts: new Date().toISOString(), level, source, message, ...(meta ? { meta } : {}) };
    if (this.console) {
      const line = `${entry.ts} [${level}] [${source}] ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
    if (!this.#file) return;
    try {
      this.#handle ??= fs.openSync(this.#file, "a");
      fs.writeSync(this.#handle, `${JSON.stringify(entry)}\n`);
    } catch {
      /* logging must never stop the host */
    }
  }

  debug(source, message, meta) {
    this.#emit("debug", source, message, meta);
  }

  info(source, message, meta) {
    this.#emit("info", source, message, meta);
  }

  warn(source, message, meta) {
    this.#emit("warn", source, message, meta);
  }

  error(source, message, meta) {
    this.#emit("error", source, message, meta);
  }

  /** Last `limit` entries of the log file. */
  tail(limit = 200) {
    if (!this.#file) return [];
    try {
      const lines = fs.readFileSync(this.#file, "utf8").trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  close() {
    if (this.#handle === null) return;
    try {
      fs.closeSync(this.#handle);
    } catch {
      /* already closed */
    }
    this.#handle = null;
  }
}
