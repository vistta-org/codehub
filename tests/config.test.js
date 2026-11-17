import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEnv, defaultConfig, loadConfig, readConfigFile, updateConfigFile, validateConfig } from "../core/config.js";

const temporary = path.join(os.tmpdir(), `vch-config-${randomUUID()}`);

suite("config", () => {
  test("defaults are complete and valid", () => {
    const config = validateConfig(defaultConfig());
    assert.equal(config.server.port, 8181);
    assert.equal("lanPort" in config.server, false);
    assert.equal(config.server.share, false);
    assert.equal(config.ide.port, 8281);
    assert.ok(config.ide.extraArgs.length === 0);
  });

  test("invalid values name the offending key", () => {
    assert.throws(() => validateConfig({ server: { port: "8181" } }), /server\.port/);
    assert.throws(() => validateConfig({ server: { share: "yes" } }), /server\.share/);
    assert.throws(() => validateConfig({ desktop: { startMinimized: "yes" } }), /desktop\.startMinimized/);
    assert.throws(() => validateConfig({ server: { logLevel: "loud" } }), /server\.logLevel/);
    assert.throws(() => validateConfig({ ide: { port: 0 } }), /ide\.port/);
    assert.throws(() => validateConfig({ server: { tls: { days: 5000 } } }), /server\.tls\.days/);
    assert.throws(() => validateConfig({ projects: { root: 42 } }), /projects\.root/);
  });

  test("legacy LAN ports migrate to one shared server port", () => {
    const config = validateConfig({ server: { port: 9000, lanPort: 9001 } });
    assert.equal(config.server.port, 9000);
    assert.equal("lanPort" in config.server, false);
    assert.throws(() => validateConfig({ server: { lanPort: "9001" } }), /server\.lanPort/);
  });

  test("the internal IDE cannot use the shared hub port", () => {
    assert.throws(() => validateConfig({ server: { port: 8281 } }), /ide\.port/);
  });

  test("obsolete LAN port environment overrides fail explicitly", () => {
    assert.throws(() => applyEnv(defaultConfig(), { VCH_LAN_PORT: "8182" }), /VCH_SERVER_PORT/);
  });

  test("unknown top-level sections survive validation through deep merge", () => {
    const config = validateConfig({ something: { unrelated: true } });
    assert.equal(config.server.port, 8181);
  });

  test("file round-trip: read defaults, write, re-read", () => {
    try {
      fs.mkdirSync(temporary, { recursive: true });
      assert.deepEqual(readConfigFile(temporary), {});
      updateConfigFile(temporary, (onDisk) => {
        onDisk.server ??= {};
        onDisk.server.port = 8191;
      });
      assert.equal(readConfigFile(temporary).server.port, 8191);
      // updateConfigFile refuses to persist invalid values
      assert.throws(() =>
        updateConfigFile(temporary, (onDisk) => {
          onDisk.server.port = 100000;
        }),
      );
      assert.equal(readConfigFile(temporary).server.port, 8191);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("loadConfig applies VCH_* env overrides and fills defaults", () => {
    const config = loadConfig(path.join(temporary, "nothing"), {
      VCH_NAME: "Desk",
      VCH_SERVER_PORT: "9000",
      VCH_SHARE: "true",
      VCH_IDE_PORT: "8383",
      VCH_PROJECTS_ROOT: "C:\\tmp\\projects",
    });
    assert.equal(config.name, "Desk");
    assert.equal(config.server.port, 9000);
    assert.equal(config.server.share, true);
    assert.equal(config.ide.port, 8383);
    assert.equal(config.projects.root, "C:\\tmp\\projects");
  });

  test("applyEnv ignores empty strings but keeps booleans strict", () => {
    const base = validateConfig(defaultConfig());
    assert.equal(applyEnv(base, { VCH_SHARE: "" }).server.share, false);
    assert.equal(applyEnv(base, { VCH_SHARE: "false" }).server.share, false);
    assert.equal(applyEnv(base, { VCH_SERVER_PORT: "" }).server.port, base.server.port);
  });
});
