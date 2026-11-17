import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DeviceStore, safeEqual, safePath } from "../core/devices.js";

let counter = 0;
const freshDir = () => {
  counter += 1;
  const dir = path.join(import.meta.dirname, `.tmp-devices-${counter}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
};

/** One fresh store per test, so tests never share state. */
const makeStore = () => {
  const dir = freshDir();
  return { dir, store: new DeviceStore(dir) };
};

suite("devices", () => {
  test("store initialises admin token and secret files, reload reuses them", () => {
    const { dir, store } = makeStore();
    assert.ok(fs.existsSync(path.join(dir, "session.key")));
    assert.ok(fs.existsSync(path.join(dir, "admin.token")));
    assert.ok(store.adminToken.length >= 30);
    assert.equal(store.list().length, 0);
    const again = new DeviceStore(dir);
    assert.equal(again.adminToken, store.adminToken);
  });

  test("isAdmin accepts the token and rejects everything else", () => {
    const { store } = makeStore();
    assert.equal(store.isAdmin(store.adminToken), true);
    assert.equal(store.isAdmin(undefined), false);
    assert.equal(store.isAdmin("wrong"), false);
    assert.equal(safeEqual("a", "a"), true);
    assert.equal(safeEqual("a", "ab"), false);
    assert.equal(safeEqual(1, "1"), false);
  });

  test("pairing lifecycle: start, exchange, single use", () => {
    const { store } = makeStore();
    const opened = store.startPairing();
    assert.match(opened.code, /^\d{6}$/);
    assert.equal(store.pairing?.code, opened.code);
    const result = store.pair(opened.code, { name: "Pixel", platform: "android" });
    assert.ok(result.token.length >= 30);
    assert.equal(result.device.name, "Pixel");
    assert.equal(result.device.platform, "android");
    assert.equal(store.pairing, null);
    const devices = store.list();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, result.device.id);
    assert.equal(/** @type {any} */ (devices[0]).tokenHash, undefined, "token hashes are never exposed");
    assert.throws(() => store.pair(opened.code, {}), /Pairing is not open/);
  });

  test("wrong code closes pairing after 5 attempts", () => {
    const { store } = makeStore();
    const opened = store.startPairing();
    assert.throws(() => store.pair("000000", {}), /Wrong pairing code/);
    assert.throws(() => store.pair("000001", {}), /Wrong pairing code/);
    assert.throws(() => store.pair("000002", {}), /Wrong pairing code/);
    assert.throws(() => store.pair("000003", {}), /Wrong pairing code/);
    assert.throws(() => store.pair("000004", {}), /Too many wrong codes/);
    assert.equal(store.pairing, null);
    assert.throws(() => store.pair(opened.code, {}), /Pairing is not open/);
  });

  test("unknown platform falls back to other", () => {
    const { store } = makeStore();
    store.startPairing();
    store.pair(store.pairing.code, { platform: "toaster" });
    assert.equal(store.list().at(-1).platform, "other");
  });

  test("device tokens authenticate and persist across reloads", () => {
    const { dir, store } = makeStore();
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Laptop", platform: "linux" });
    const seen = store.authenticate(created.token);
    assert.equal(seen.id, created.device.id);
    const store2 = new DeviceStore(dir);
    assert.equal(store2.authenticate(created.token)?.name, "Laptop");
    assert.equal(store2.authenticate("garbage"), null);
    assert.equal(store2.authenticate(undefined), null);
  });

  test("revoking a device kills its token, session and tickets", () => {
    const { store } = makeStore();
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Phone", platform: "android" });
    assert.ok(store.authenticate(created.token));
    const session = store.signSession(created.device.id);
    assert.equal(store.verifySession(session)?.id, created.device.id);
    const request = store.issueTicket(created.device.id, "/somewhere");
    assert.ok(request);
    store.revoke(created.device.id);
    assert.equal(store.authenticate(created.token), null);
    assert.equal(store.verifySession(session), null);
    assert.equal(store.redeemTicket(request), null);
    assert.throws(() => store.revoke(created.device.id), /Device not found/);
    assert.equal(
      store.list().find((device) => device.id === created.device.id),
      undefined,
    );
  });

  test("sessions carry device id, expiry and HMAC; tampering is rejected", () => {
    const { store } = makeStore();
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Tab", platform: "windows" });
    const session = store.signSession(created.device.id);
    const parts = session.split(".");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], created.device.id);
    assert.ok(Number(parts[1]) > Date.now());
    assert.equal(store.verifySession(`${created.device.id}.123.`), null, "expired sessions are refused");
    assert.equal(store.verifySession(`${parts[0]}.${Date.now() + 60_000}.AAAA`), null, "wrong signature is refused");
    assert.equal(store.verifySession(undefined), null);
  });

  test("tickets are one-time and carry the requested target; safePath blocks off-site paths", () => {
    const { store } = makeStore();
    store.startPairing();
    const created = store.pair(store.pairing.code, { name: "Workstation", platform: "windows" });
    const request = store.issueTicket(created.device.id, "/?folder=C:/work");
    const redeemed = store.redeemTicket(request);
    assert.equal(redeemed.path, "/?folder=C:/work");
    assert.ok(redeemed.session.includes(created.device.id));
    assert.equal(store.redeemTicket(request), null, "one-time");
    assert.equal(store.redeemTicket("missing"), null);
    assert.equal(safePath("//evil.example.com"), "/");
    assert.equal(safePath("https://evil"), "/");
    assert.equal(safePath("/ok?folder=x"), "/ok?folder=x");
    assert.equal(safePath("\\\\server"), "/");
  });
});
