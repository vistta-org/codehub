/**
 * Android client helpers: pairing input, QR payloads and fingerprints. The
 * QR test uses the hub's own pairing route, so a format change on either side
 * breaks it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectionProblem,
  deviceName,
  hostOrigin,
  idePath,
  pairingCode,
  parsePairingQr,
  sameFingerprint,
} from "../client/hosts.js";
import { defaultConfig } from "../core/config.js";
import { DeviceStore } from "../core/devices.js";
import { Logger } from "../core/logger.js";
import { lanAddresses } from "../core/net.js";
import { ensureLocalCa } from "../core/tls.js";
import { createRoutes, matchRoute } from "../hub/api.js";
import { remoteOrigin } from "../hub/remotes.js";

const FINGERPRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");

suite("android client", () => {
  test("addresses normalize to the hub's HTTPS LAN origin", () => {
    assert.equal(hostOrigin("192.168.1.20"), "https://192.168.1.20:8181");
    assert.equal(remoteOrigin("192.168.1.20"), hostOrigin("192.168.1.20"));
    assert.equal(hostOrigin(" laptop.local:9443 "), "https://laptop.local:9443");
    assert.equal(hostOrigin("https://10.0.0.2:8182/some/path"), "https://10.0.0.2:8182");
    assert.throws(() => hostOrigin("http://10.0.0.2:8182"), /HTTPS/);
    assert.throws(() => hostOrigin(""), /address/);
  });

  test("pairing codes are six digits", () => {
    assert.equal(pairingCode(" 012345 "), "012345");
    assert.throws(() => pairingCode("12345"), /6-digit/);
    assert.throws(() => pairingCode("abcdef"), /6-digit/);
  });

  test("fingerprints compare without separators or case, and must be complete", () => {
    assert.ok(sameFingerprint(FINGERPRINT, FINGERPRINT.replaceAll(":", "").toLowerCase()));
    assert.equal(sameFingerprint(FINGERPRINT, FINGERPRINT.replace(/^00/, "FF")), false);
    assert.equal(sameFingerprint("", ""), false, "an empty fingerprint never matches");
  });

  test("the QR the hub generates is the QR the client reads", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vch-client-qr-"));
    try {
      const devices = new DeviceStore(directory);
      const config = structuredClone(defaultConfig());
      await ensureLocalCa(path.join(directory, "tls"), { days: 30, hosts: ["127.0.0.1"] });
      const ca = fs.readFileSync(path.join(directory, "tls", "rootCA.pem"), "utf8");
      const hub = /** @type {any} */ ({
        config,
        devices,
        logger: new Logger({ console: false }),
        sharing: () => true,
        caCertificate: () => Buffer.from(ca),
        startPairing: () => devices.startPairing(),
        projects: {},
        extensions: { list: () => [] },
        launcher: { status: () => ({ state: "running" }) },
      });
      const route = matchRoute(createRoutes(hub), "POST", "/api/devices/pairing");
      const result = await route.route.handler({ isLocal: true, headers: {}, params: {}, logger: hub.logger }, {}, hub);
      const parsed = parsePairingQr(result.link);
      assert.equal(parsed.code, result.pairing.code);
      assert.match(parsed.origin, /^https:\/\/.+:\d+$/);
      assert.equal(new URL(parsed.origin).port, String(config.server.port));
      assert.ok(sameFingerprint(parsed.fingerprint, result.fingerprint));
      assert.equal(new URL(result.link).pathname, "/pair");
      const firstAddress = lanAddresses()[0];
      if (firstAddress) assert.equal(new URL(result.link).hostname, firstAddress, "the QR uses an IP, not the host name");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("foreign QR codes are rejected and legacy payloads remain supported", () => {
    assert.throws(() => parsePairingQr("https://example.com"), /not a Vistta Code Hub/);
    assert.throws(() => parsePairingQr("https://example.com/pair?code=123456&fingerprint=invalid"), /invalid fingerprint/);
    assert.throws(() => parsePairingQr(JSON.stringify({ host: "https://a:8182", code: "12" })), /6-digit/);
    assert.throws(
      () => parsePairingQr(JSON.stringify({ host: "https://a:8182", code: "123456", fingerprint: "AB" })),
      /invalid fingerprint/,
    );
    assert.equal(parsePairingQr(JSON.stringify({ host: "https://a:8182", code: "123456" })).fingerprint, undefined);
    assert.equal(parsePairingQr(`https://a:8182/pair?code=123456&fingerprint=${FINGERPRINT}`).origin, "https://a:8182");
  });

  test("device names come from the WebView user agent", () => {
    assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A) AppleWebKit"), "Pixel 7");
    assert.equal(deviceName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit"), "Android device", "reduced user agents");
    assert.equal(deviceName(""), "Android device");
  });

  test("native network and TLS failures get actionable messages", () => {
    const origin = "https://192.168.1.20:8181";
    assert.match(
      connectionProblem("failed to connect to /192.168.1.20 (port 8181) after 10000ms", origin) ?? "",
      /192\.168\.1\.20:8181.*Share on LAN/,
    );
    assert.match(
      connectionProblem("unexpected end of stream on https://192.168.1.20:8181/...", origin) ?? "",
      /Share on LAN/,
    );
    assert.match(
      connectionProblem(
        "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.",
        origin,
      ) ?? "",
      /pair again/,
    );
    assert.equal(connectionProblem("Invalid or expired pairing code", origin), null);
  });

  test("IDE targets stay on the computer's origin", () => {
    assert.equal(idePath("/?folder=%2Fhome"), "/?folder=%2Fhome");
    assert.equal(idePath("//evil.example/"), "/");
    assert.equal(idePath("https://evil.example/"), "/");
    assert.equal(idePath(undefined), "/");
  });
});
