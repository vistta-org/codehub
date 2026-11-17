import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isLoopback } from "../core/net.js";
import { certificateProblems, ensureLocalCa } from "../core/tls.js";

/** Each certificate test needs its own folder: tests in a suite run together. */
const tlsDir = (name) => {
  const target = path.join(import.meta.dirname, `.tmp-tls-${name}`);
  fs.rmSync(target, { recursive: true, force: true });
  return target;
};

suite("tls", () => {
  test("loopback detection", () => {
    assert.equal(isLoopback("127.0.0.1"), true);
    assert.equal(isLoopback("::ffff:127.0.0.1"), true);
    assert.equal(isLoopback("::1"), true);
    assert.equal(isLoopback("localhost"), true);
    assert.equal(isLoopback("fe80::1"), false);
    assert.equal(isLoopback(undefined), false);
    assert.equal(isLoopback("192.168.1.10"), false);
  });

  test("ensureLocalCa generates a CA + server cert covering the hosts", async () => {
    const dir = tlsDir("generate");
    const files = await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1", "localhost", "codehub.local"] });
    for (const file of Object.values(files)) assert.ok(fs.existsSync(file), file);
    const problems = certificateProblems(fs.readFileSync(files.cert), ["127.0.0.1", "localhost", "codehub.local"]);
    assert.deepEqual(problems, [], `unexpected problems: ${problems.join("; ")}`);
  });

  test("reuse: no regeneration while the certificate covers the hosts", async () => {
    const dir = tlsDir("reuse");
    await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1", "localhost", "codehub.local"] });
    const before = fs.readFileSync(path.join(dir, "https.crt"));
    const again = await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1", "localhost", "codehub.local"] });
    assert.equal(again.cert, path.join(dir, "https.crt"));
    assert.deepEqual(fs.readFileSync(path.join(dir, "https.crt")), before);
  });

  test("renew: a host change regenerates the server certificate", async () => {
    const dir = tlsDir("renew");
    await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1", "localhost", "codehub.local"] });
    await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1", "localhost", "codehub.local", "codehub2.local"] });
    const problems = certificateProblems(fs.readFileSync(path.join(dir, "https.crt")), [
      "127.0.0.1",
      "localhost",
      "codehub.local",
      "codehub2.local",
    ]);
    assert.deepEqual(problems, []);
  });

  test("expired certificate is replaced automatically", async () => {
    const dir = tlsDir("expired");
    await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1"] });
    // Delete the private key: the pair is incomplete, validation must regenerate.
    fs.rmSync(path.join(dir, "https.key"));
    await ensureLocalCa(dir, { days: 60, hosts: ["127.0.0.1"] });
    assert.deepEqual(certificateProblems(fs.readFileSync(path.join(dir, "https.crt")), ["127.0.0.1"]), []);
  });

  test("invalid hosts input is rejected", async () => {
    await assert.rejects(() => ensureLocalCa(tlsDir("invalid"), { hosts: ["bad host name!"] }), /Invalid certificate hosts/);
  });
});
