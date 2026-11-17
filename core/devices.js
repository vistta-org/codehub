/**
 * Device access: the host admin token, pairing codes, revocable device tokens,
 * one-time IDE tickets and signed IDE session cookies.
 *
 * Tokens are stored only as SHA-256 hashes. Session cookies are HMAC-signed
 * with a per-host secret and rechecked against the device list, so revoking a
 * device ends its sessions too.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";

const PAIRING_TTL = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const TICKET_TTL = 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000;
const SEEN_INTERVAL = 60_000;
const PLATFORMS = ["android", "windows", "linux", "browser", "other"];

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Copies a device record without its token hash (never leaves the host). */
function withoutTokenHash(device) {
  const { ...visible } = device;
  delete visible.tokenHash;
  return visible;
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: protect the data folder with user-only ACLs */
  }
}

/**
 * Reads or creates a random secret file.
 * @param {string} file
 */
function secretFile(file, bytes = 32) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value) return value;
  } catch {
    /* create below */
  }
  const value = randomBytes(bytes).toString("base64url");
  writePrivate(file, value);
  return value;
}

/**
 * @typedef {{ id: string, name: string, platform: string, tokenHash: string, createdAt: string, lastSeenAt?: string }} Device
 */

export class DeviceStore {
  /** @type {Device[]} */
  #devices = [];
  /** @type {{ code: string, expiresAt: number, attempts: number } | undefined} */
  #pairing;
  /** @type {Map<string, { deviceId: string, expiresAt: number, path: string }>} */
  #tickets = new Map();
  #secret;
  #file;

  /**
   * @param {string} dir data directory
   * @param {{ adminToken?: string, onChange?: () => void }} [options]
   */
  constructor(dir, options = {}) {
    this.#file = path.join(dir, "devices.json");
    this.#secret = secretFile(path.join(dir, "session.key"));
    this.adminTokenFile = path.join(dir, "admin.token");
    this.adminToken = options.adminToken || secretFile(this.adminTokenFile);
    this.onChange = options.onChange;
    try {
      const stored = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      if (Array.isArray(stored?.devices)) this.#devices = stored.devices;
    } catch {
      /* no devices yet */
    }
  }

  #save() {
    writePrivate(this.#file, JSON.stringify({ devices: this.#devices }, null, 2));
    this.onChange?.();
  }

  /** @param {string | undefined} token */
  isAdmin(token) {
    return safeEqual(token, this.adminToken);
  }

  list() {
    return this.#devices.map(withoutTokenHash);
  }

  get pairing() {
    if (this.#pairing && this.#pairing.expiresAt <= Date.now()) this.#pairing = undefined;
    return this.#pairing ? { code: this.#pairing.code, expiresAt: new Date(this.#pairing.expiresAt).toISOString() } : null;
  }

  /** Opens a pairing window with a fresh six-digit code. */
  startPairing(ttl = PAIRING_TTL) {
    this.#pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + ttl, attempts: 0 };
    this.onChange?.();
    return this.pairing;
  }

  cancelPairing() {
    if (!this.#pairing) return;
    this.#pairing = undefined;
    this.onChange?.();
  }

  /**
   * Exchanges the current pairing code for a device token. The code is single
   * use and closes after too many wrong attempts.
   * @param {string} code
   * @param {{ name?: string, platform?: string }} info
   */
  pair(code, info = {}) {
    const pairing = this.#pairing;
    if (!pairing || pairing.expiresAt <= Date.now()) {
      this.#pairing = undefined;
      throw new AppError("Pairing is not open on the host. Start pairing there and try again.", 403, "pairing_closed");
    }
    if (!safeEqual(String(code ?? "").trim(), pairing.code)) {
      if (++pairing.attempts >= MAX_ATTEMPTS) {
        this.#pairing = undefined;
        this.onChange?.();
        throw new AppError("Too many wrong codes. Start pairing again on the host.", 403, "pairing_closed");
      }
      throw new AppError("Wrong pairing code", 403, "invalid_code");
    }
    this.#pairing = undefined;
    const name =
      String(info.name ?? "")
        .trim()
        .slice(0, 80) || "Device";
    const platform = PLATFORMS.includes(info.platform ?? "") ? info.platform : "other";
    const token = randomBytes(32).toString("base64url");
    /** @type {Device} */
    const device = { id: randomUUID(), name, platform, tokenHash: hash(token), createdAt: new Date().toISOString() };
    this.#devices.push(device);
    this.#save();
    return { token, device: withoutTokenHash(device) };
  }

  /**
   * @param {string | undefined} token
   * @returns {Omit<Device, "tokenHash"> | null}
   */
  authenticate(token) {
    if (typeof token !== "string" || !token) return null;
    const tokenHash = hash(token);
    const device = this.#devices.find((entry) => safeEqual(entry.tokenHash, tokenHash));
    if (!device) return null;
    this.#seen(device);
    return withoutTokenHash(device);
  }

  #seen(device) {
    const now = Date.now();
    if (device.lastSeenAt && now - Date.parse(device.lastSeenAt) < SEEN_INTERVAL) return;
    device.lastSeenAt = new Date(now).toISOString();
    try {
      this.#save();
    } catch {
      /* best effort */
    }
  }

  /** @param {string} id */
  revoke(id) {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter((device) => device.id !== id);
    if (this.#devices.length === before) throw new AppError("Device not found", 404, "not_found");
    for (const [ticket, entry] of this.#tickets) if (entry.deviceId === id) this.#tickets.delete(ticket);
    this.#save();
  }

  /**
   * One-time, short-lived ticket that turns into an IDE session cookie.
   * @param {string} deviceId
   * @param {string} [target] path to open after sign-in
   */
  issueTicket(deviceId, target = "/") {
    const now = Date.now();
    for (const [ticket, entry] of this.#tickets) if (entry.expiresAt <= now) this.#tickets.delete(ticket);
    const ticket = randomBytes(24).toString("base64url");
    this.#tickets.set(ticket, { deviceId, expiresAt: now + TICKET_TTL, path: safePath(target) });
    return ticket;
  }

  /** @param {string} ticket */
  redeemTicket(ticket) {
    const entry = typeof ticket === "string" ? this.#tickets.get(ticket) : undefined;
    if (!entry) return null;
    this.#tickets.delete(ticket);
    if (entry.expiresAt <= Date.now() || !this.#devices.some((device) => device.id === entry.deviceId)) return null;
    return { session: this.signSession(entry.deviceId), path: entry.path, maxAge: SESSION_TTL / 1000 };
  }

  /** @param {string} deviceId */
  signSession(deviceId, ttl = SESSION_TTL) {
    const payload = `${deviceId}.${Date.now() + ttl}`;
    return `${payload}.${createHmac("sha256", this.#secret).update(payload).digest("base64url")}`;
  }

  /**
   * @param {string | undefined} value
   * @returns {Omit<Device, "tokenHash"> | null}
   */
  verifySession(value) {
    if (typeof value !== "string") return null;
    const parts = decodeURIComponent(value).split(".");
    if (parts.length !== 3) return null;
    const [deviceId, expires, signature] = parts;
    const expected = createHmac("sha256", this.#secret).update(`${deviceId}.${expires}`).digest("base64url");
    if (!safeEqual(signature, expected) || !(Number(expires) > Date.now())) return null;
    const device = this.#devices.find((entry) => entry.id === deviceId);
    if (!device) return null;
    this.#seen(device);
    return withoutTokenHash(device);
  }
}

/** Keeps redirects on this origin. */
export function safePath(target) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return "/";
  return target;
}
