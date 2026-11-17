/**
 * Code Hub configuration: `config.json` in the data directory plus `VCH_*`
 * environment overrides. AI provider credentials never live here; they stay in
 * the IDE's own secret storage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE = "config.json";
const LOG_LEVELS = ["debug", "info", "warn", "error"];

/**
 * @typedef {{
 *   name: string,
 *   desktop: { startMinimized: boolean },
 *   server: {
 *     port: number,
 *     share: boolean,
 *     logLevel: "debug" | "info" | "warn" | "error",
 *     tls: { certFile?: string, keyFile?: string, days: number },
 *   },
 *   ide: { port: number, workspaceTrust: boolean, extraArgs: string[], installPath?: string },
 *   projects: { root: string, recent: string[] },
 * }} AppConfig
 */

/** @returns {AppConfig} */
export function defaultConfig() {
  return {
    name: "",
    desktop: { startMinimized: false },
    server: {
      // Shared port: loopback HTTP and paired LAN HTTPS.
      port: 8181,
      // Remember whether LAN sharing should be enabled at launch.
      share: false,
      logLevel: "info",
      tls: { certFile: undefined, keyFile: undefined, days: 397 },
    },
    ide: { port: 8281, workspaceTrust: false, extraArgs: [], installPath: undefined },
    projects: { root: "", recent: [] },
  };
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  if (!isObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isObject(base?.[key]) && isObject(value) ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * Validates and normalizes a config object. Throws with the offending key.
 * @param {any} input
 * @returns {AppConfig}
 */
export function validateConfig(input) {
  const config = merge(defaultConfig(), input);
  const fail = (key, expected) => {
    throw new Error(`Invalid config "${key}": expected ${expected}`);
  };
  const port = (key, value) => {
    if (!Number.isInteger(value) || value < 1 || value > 65535) fail(key, "a port between 1 and 65535");
  };
  const string = (key, value, optional = true) => {
    if (value === undefined && optional) return;
    if (typeof value !== "string") fail(key, "a string");
  };
  const strings = (key, value) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(key, "a list of strings");
  };
  const boolean = (key, value) => {
    if (typeof value !== "boolean") fail(key, "true or false");
  };
  string("name", config.name, false);
  boolean("desktop.startMinimized", config.desktop.startMinimized);
  port("server.port", config.server.port);
  if (config.server.lanPort !== undefined) {
    port("server.lanPort", config.server.lanPort);
    process.emitWarning("server.lanPort is obsolete; HTTP and HTTPS both use server.port.", {
      code: "VCH_LAN_PORT_REMOVED",
    });
    delete config.server.lanPort;
  }
  boolean("server.share", config.server.share);
  if (!LOG_LEVELS.includes(config.server.logLevel)) fail("server.logLevel", LOG_LEVELS.join(", "));
  string("server.tls.certFile", config.server.tls.certFile);
  string("server.tls.keyFile", config.server.tls.keyFile);
  if (!Number.isInteger(config.server.tls.days) || config.server.tls.days < 1 || config.server.tls.days > 397)
    fail("server.tls.days", "an integer between 1 and 397");
  port("ide.port", config.ide.port);
  boolean("ide.workspaceTrust", config.ide.workspaceTrust);
  strings("ide.extraArgs", config.ide.extraArgs);
  string("ide.installPath", config.ide.installPath);
  string("projects.root", config.projects.root, false);
  strings("projects.recent", config.projects.recent);
  if (config.server.port === config.ide.port) fail("ide.port", "a port different from server.port");
  return config;
}

/** @param {string} dataDirectory */
export function readConfigFile(dataDirectory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDirectory, CONFIG_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read ${path.join(dataDirectory, CONFIG_FILE)}: ${error.message}`);
  }
}

/**
 * Loads `config.json`, applies environment overrides and validates the result.
 * @param {string} dataDirectory
 * @returns {AppConfig}
 */
export function loadConfig(dataDirectory, env = process.env) {
  const config = applyEnv(validateConfig(readConfigFile(dataDirectory)), env);
  if (!config.projects.root) config.projects.root = os.homedir();
  if (!config.name) config.name = os.hostname();
  return validateConfig(config);
}

/**
 * Applies a change to `config.json` on disk only, so environment overrides are
 * never persisted. Writes atomically.
 * @param {string} dataDirectory
 * @param {(onDisk: any) => void} change
 */
export function updateConfigFile(dataDirectory, change) {
  const onDisk = readConfigFile(dataDirectory);
  change(onDisk);
  validateConfig(onDisk);
  const file = path.join(dataDirectory, CONFIG_FILE);
  fs.mkdirSync(dataDirectory, { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(onDisk, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

/**
 * @param {AppConfig} base
 * @returns {AppConfig}
 */
export function applyEnv(base, env = process.env) {
  const config = structuredClone(base);
  const number = (value) => (value === undefined || value === "" ? undefined : Number(value));
  if (env.VCH_NAME) config.name = env.VCH_NAME;
  if (env.VCH_SERVER_PORT) config.server.port = number(env.VCH_SERVER_PORT);
  if (env.VCH_LAN_PORT) throw new Error("VCH_LAN_PORT is no longer supported; set VCH_SERVER_PORT for both HTTP and HTTPS.");
  if (env.VCH_SHARE) config.server.share = env.VCH_SHARE === "true";
  if (env.VCH_LOG_LEVEL) config.server.logLevel = /** @type {any} */ (env.VCH_LOG_LEVEL);
  if (env.VCH_TLS_CERT) config.server.tls.certFile = env.VCH_TLS_CERT;
  if (env.VCH_TLS_KEY) config.server.tls.keyFile = env.VCH_TLS_KEY;
  if (env.VCH_IDE_PORT) config.ide.port = number(env.VCH_IDE_PORT);
  if (env.VCH_RUNTIME_DIR) config.ide.installPath = env.VCH_RUNTIME_DIR;
  if (env.VCH_PROJECTS_ROOT) config.projects.root = env.VCH_PROJECTS_ROOT;
  return config;
}
