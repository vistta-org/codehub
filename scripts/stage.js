/**
 * stage.js — copies the hub backend + runtime into `build/app` so the
 * Tauri desktop app (`npm run build:*`) bundles a self-contained payload:
 *
 *   build/app/
 *     hub/…           the hub backend (core/, hub/, scripts/, server.js)
 *     node_modules/…  production dependencies of the backend (TLS + QR)
 *     runtime/…        code-server + bundled extensions (if installed)
 *     icon.png
 *
 * The desktop app runs the backend with the Node bundled in the code-server
 * runtime (`runtime/code-server/lib/node[.exe]`). Pass `--no-runtime` to skip
 * the (large) runtime copy, e.g. for fast UI-only builds. Pass `--target=<dir>`
 * to stage somewhere else (the Docker host uses `build/docker`).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? path.resolve(ROOT, targetArg.slice("--target=".length)) : path.join(ROOT, "build", "app");
const noRuntime = process.argv.includes("--no-runtime");

const entries = ["core", "hub", "scripts", "assets", "server.js", "package.json", "LICENSE"];
// build/app is also the Tauri project (`target/` holds the Rust cache and `npm run dev`'s
// running app), so only the payload this script owns is replaced.
for (const entry of [...entries, "node_modules", ...(noRuntime ? [] : ["runtime"])])
  fs.rmSync(path.join(target, entry), { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

for (const entry of entries) {
  const source = path.join(ROOT, entry);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(target, entry), { recursive: true });
}

// The backend runs with plain Node, so its production dependencies must travel
// with it: the TLS stack is needed the first time sharing turns on, and qrcode
// powers the pairing QR. Inside the Vistta workspace npm hoists them to the
// workspace root, so each one is found by walking up like Node does. The
// @vistta/* packages are for the desktop shell and tooling, not the backend.
/** @param {string} name @param {string} from */
function packageDir(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(directory) === directory) return undefined;
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
/** @type {[string, string, boolean][]} */
const queue = Object.keys(manifest.dependencies ?? {})
  .filter((name) => !name.startsWith("@vistta/"))
  .map((name) => [name, ROOT, false]);
/** @type {Map<string, string>} */
const runtimeDeps = new Map();
while (queue.length) {
  const [name, from, optional] = /** @type {[string, string, boolean]} */ (queue.shift());
  const source = packageDir(name, from);
  if (!source) {
    if (optional) continue;
    throw new Error(`Backend dependency "${name}" is not installed; run npm install first`);
  }
  if ([...runtimeDeps.values()].includes(source)) continue;
  // A nested copy (version conflict) travels inside its parent package's folder.
  const nested = [...runtimeDeps.values()].some((parent) => source.startsWith(parent + path.sep));
  if (!nested) {
    const previous = runtimeDeps.get(name);
    if (previous) {
      console.warn(`stage: ${name} resolves to both ${previous} and ${source}; bundling the first`);
      continue;
    }
    runtimeDeps.set(name, source);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) queue.push([dependency, source, false]);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) queue.push([dependency, source, true]);
}
for (const [name, source] of runtimeDeps)
  fs.cpSync(source, path.join(target, "node_modules", name), { recursive: true, dereference: true });
console.log(`staged ${runtimeDeps.size} backend dependencies`);

if (noRuntime) {
  console.log("staged app payload (no runtime) →", target);
} else {
  // Runtime: reuse what install-runtime.js downloaded (large; copy once).
  const runtime = process.env.VCH_RUNTIME_ROOT ? path.resolve(process.env.VCH_RUNTIME_ROOT) : path.join(ROOT, "runtime");
  if (fs.existsSync(path.join(runtime, "code-server"))) {
    console.log(`copying runtime from ${runtime} (this can take a minute)…`);
    fs.cpSync(runtime, path.join(target, "runtime"), { recursive: true, verbatimSymlinks: false });
  } else {
    console.warn("No code-server runtime found — run `npm run install-runtime` first;     the staged app still bundles.");
  }
  console.log(`staged app payload → ${target}`);
}
