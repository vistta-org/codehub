/**
 * Workbench patch: verifies anchors exist (or fail cleanly) and the proxy
 * serves the patched file with an ETag. Needs the installed runtime; skipped
 * elsewhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { forwardHeaders, injectTitlebar, TITLEBAR_PATH } from "../hub/proxy.js";
import { patchWorkbench } from "../hub/workbench.js";

const runtimeRoot = process.env.VCH_RUNTIME_ROOT_TEST
  ? path.resolve(process.env.VCH_RUNTIME_ROOT_TEST)
  : path.resolve(import.meta.dirname, "..", "..", "..", "code-server", "runtime");
const workbenchFile = path.join(
  runtimeRoot,
  "code-server",
  "lib",
  "vscode",
  "out",
  "vs",
  "code",
  "browser",
  "workbench",
  "workbench.js",
);
const hasRuntime = fs.existsSync(workbenchFile);
// The runtime the app bundles (`npm run install-runtime`) may be newer than the sibling one.
const runtimes = [runtimeRoot, path.resolve(import.meta.dirname, "..", "runtime")]
  .map((root) =>
    path.join(root, "code-server", "lib", "vscode", "out", "vs", "code", "browser", "workbench", "workbench.js"),
  )
  .filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);

suite("workbench patch", () => {
  test("session sharing applies to every installed runtime; missing chat-UI tweaks are only skipped", () => {
    if (!runtimes.length) return "skipped: no code-server runtime installed";
    for (const file of runtimes) {
      const skipped = [];
      const patched = patchWorkbench(fs.readFileSync(file, "utf8"), { onSkip: (label) => skipped.push(label) });
      for (const marker of ["vchSync", "vchOwns", "/_vch/extension", "__vchLocalAuthority", "remoteStorageEnabled:!0"])
        assert.ok(patched.includes(marker), `${marker} in ${file}`);
      assert.ok(
        skipped.every((label) => !/index|session|storage|configuration/.test(label)),
        skipped.join(", "),
      );
    }
  });

  test("anchors apply to the installed runtime", () => {
    if (!hasRuntime) return "skipped: no code-server runtime installed";
    const source = fs.readFileSync(workbenchFile, "utf8");
    const patched = patchWorkbench(source);
    assert.notEqual(patched, source);
    // The patch is deterministic.
    assert.equal(patchWorkbench(source), patched);
    // The patch injected our marker identifiers.
    assert.ok(patched.includes("vchIndexUri"));
    assert.ok(patched.includes("vchSync"));
    assert.ok(patched.includes("vchSharedIndex") || patched.includes("/_vch/extension"));
    // Re-applying to the patched output must fail loudly (anchors become ambiguous/missing).
    assert.throws(() => patchWorkbench(patched));
  });

  test("SCM generation calls the commit command without GitHub setup and preserves its arguments", async () => {
    if (!runtimes.length) return "skipped: no code-server runtime installed";
    for (const file of runtimes) {
      const skipped = [];
      const patched = patchWorkbench(fs.readFileSync(file, "utf8"), { onSkip: (label) => skipped.push(label) });
      assert.equal(skipped.includes("SCM commit generation setup"), false, file);
      const run = patched.match(
        /async run\(([\w$]+),\.\.\.([\w$]+)\)\{let ([\w$]+)=\1\.get\(([\w$]+)\);let ([\w$]+)=([\w$]+)\.defaultChatAgent\?\.generateCommitMessageCommand;\5&&await \3\.executeCommand\(\5,\.\.\.\2\)\}/,
      );
      assert.ok(run, `SCM generation handler in ${file}`);
      const calls = [];
      const command = "github.copilot.git.generateCommitMessage";
      const product = { defaultChatAgent: { generateCommitMessageCommand: command } };
      const handler = vm.runInNewContext(`({${run[0]}})`, {
        [run[4]]: "commandService",
        [run[6]]: product,
      });
      const services = {
        get: (id) => {
          assert.equal(id, "commandService");
          return { executeCommand: async (...args) => calls.push(args) };
        },
      };
      const repository = { rootUri: "file:///repo" };
      const token = { isCancellationRequested: false };
      await handler.run(services, repository, undefined, token);
      assert.deepEqual(calls, [[command, repository, undefined, token]]);

      product.defaultChatAgent = undefined;
      await handler.run(services, repository);
      assert.equal(calls.length, 1, "no command or setup is invoked without a configured chat agent");
    }
  });

  test("title-bar script goes into the workbench page only, once", () => {
    const page = Buffer.from('<html><head><meta id="vscode-workbench-web-configuration"></head><body></body></html>');
    const injected = injectTitlebar(page).toString();
    assert.equal(injected.match(/\/_vch\/titlebar\.js/g)?.length, 1);
    assert.ok(injected.indexOf(TITLEBAR_PATH) < injected.indexOf("</head>"));
    assert.equal(injectTitlebar(Buffer.from(injected)).toString(), injected, "idempotent");
    const other = Buffer.from("<html><head></head><body>webview</body></html>");
    assert.equal(injectTitlebar(other), other, "other HTML is untouched");
  });

  test("title-bar controls sit above VS Code's drag overlay and opt out of dragging", () => {
    // WebView2 honours app-region and `.titlebar-drag-region` covers the whole title bar;
    // without these, real clicks on the buttons start a window drag instead.
    const script = fs.readFileSync(path.join(import.meta.dirname, "..", "hub", "titlebar.js"), "utf8");
    const rule = script.match(/\.vch-window-controls \{[^}]*\}/)?.[0] ?? "";
    for (const declaration of ["position: relative", "z-index: 2500", "-webkit-app-region: no-drag", "app-region: no-drag"])
      assert.ok(rule.includes(declaration), declaration);
  });

  test("proxy header rewriting drops hop-by-hop fields", () => {
    const headers = forwardHeaders(
      { connection: "keep-alive", "keep-alive": "timeout=5", host: "lan:8182", accept: "*/*", te: "trailers" },
      { host: "host:8181", protocol: "http" },
    );
    assert.equal(headers.connection, undefined);
    assert.equal(headers["keep-alive"], undefined);
    assert.equal(headers.te, undefined);
    assert.equal(headers.host, "host:8181");
    assert.equal(headers["x-forwarded-host"], "host:8181");
    assert.equal(headers["x-forwarded-proto"], "http");
    assert.equal(headers.accept, "*/*");
    // WebSocket upgrades must keep the upgrade pair.
    const upgrade = forwardHeaders(
      { connection: "Upgrade", upgrade: "websocket", host: "lan:8182" },
      { host: "host:8181", protocol: "https", keepUpgrade: true },
    );
    assert.equal(upgrade.connection, "Upgrade");
    assert.equal(upgrade.upgrade, "websocket");
  });
});
