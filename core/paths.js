import path from "node:path";

/** Code Hub source root (the folder containing server.js). */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

/** Persistent host data: config, logs, IDE data, devices and certificates. */
export function dataDir(env = process.env) {
  return path.resolve(env.VCH_DATA_DIR || path.join(PROJECT_ROOT, "data"));
}

/** Folder holding the downloaded code-server runtime and bundled IDE extensions. */
export function runtimeRoot(env = process.env) {
  return path.resolve(env.VCH_RUNTIME_ROOT || path.join(PROJECT_ROOT, "runtime"));
}

/**
 * code-server installation used by the launcher.
 * @param {{ ide: { installPath?: string } }} config
 */
export function runtimeDir(config, env = process.env) {
  if (config.ide.installPath) return path.resolve(PROJECT_ROOT, config.ide.installPath);
  return path.join(runtimeRoot(env), "code-server");
}

/** Bundled VSIX files installed once into the IDE. */
export function bundledExtensionsDir(runtimeDirectory) {
  return path.join(path.dirname(runtimeDirectory), "extensions");
}
