/**
 * Remote hosts this machine has paired with (the desktop app's client side).
 *
 * The desktop webview never talks to another host directly. Pairing, status
 * and IDE traffic go through this process, which pins the remote's local CA
 * (trust on first use, fingerprint shown to the user) and keeps the device
 * token on disk. Each remote IDE is served from its own loopback relay port:
 * a separate browser origin that never sees the token and needs no TLS trust.
 */
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { safePath, writePrivate } from "../core/devices.js";
import { AppError } from "../core/errors.js";
import { findFreePort, isPortFree } from "../core/net.js";
import { forwardHeaders, responseHeaders } from "./proxy.js";

const HOST = "127.0.0.1";
const DEFAULT_LAN_PORT = 8181;
const RELAY_BASE_PORT = 8300;
const TIMEOUT_MS = 10_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * @typedef {{
 *   id: string, name: string, url: string, ca: string | null, fingerprint: string | null,
 *   token: string, deviceId: string, pairedAt: string, relayPort?: number,
 * }} Remote
 */

/**
 * Normalizes what the user typed (`192.168.1.5`, `host:8181`, `https://…`)
 * into an HTTPS origin; the shared hub port defaults to 8181.
 * @param {unknown} address
 */
export function remoteOrigin(address) {
  const text = String(address ?? "").trim();
  if (!text) throw new AppError("Enter the host address", 400, "invalid_request");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new AppError("That is not a valid host address", 400, "invalid_request");
  }
  if (url.protocol !== "https:") throw new AppError("Hosts are reached over HTTPS", 400, "invalid_request");
  if (!url.port) url.port = String(DEFAULT_LAN_PORT);
  return url.origin;
}

/** @param {string | undefined} value */
const normalizeFingerprint = (value) =>
  String(value ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();

/** TLS options: pin the remote's CA (any host name), or fall back to system trust. */
function tlsOptions(ca) {
  return ca ? { ca, checkServerIdentity: () => undefined } : {};
}

function devicePlatform() {
  return { win32: "windows", linux: "linux", android: "android" }[os.platform()] ?? "other";
}

/** Copy without the secrets that must never leave this process. */
function visible(remote) {
  const rest = { ...remote };
  delete rest.token;
  delete rest.ca;
  return rest;
}

/**
 * One HTTPS request to a remote hub; resolves with the status and parsed body.
 * @param {string} origin
 * @param {string} method
 * @param {string} pathname
 * @param {{ ca?: string | null, token?: string, body?: any, insecure?: boolean, agent?: https.Agent }} [options]
 * @returns {Promise<{ status: number, data: any, raw: Buffer }>}
 */
function call(origin, method, pathname, { ca, token, body, insecure = false, agent } = {}) {
  const url = new URL(pathname, origin);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: url.pathname + url.search,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: TIMEOUT_MS,
        // `insecure` is only used to download the public CA (no credential is sent).
        ...(insecure ? { rejectUnauthorized: false } : tlsOptions(ca)),
        ...(agent ? { agent } : {}),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          let data = null;
          try {
            data = raw.length ? JSON.parse(raw.toString("utf8")) : null;
          } catch {
            data = null;
          }
          resolve({ status: response.statusCode ?? 0, data, raw });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("The host did not answer in time")));
    request.on("error", (error) =>
      reject(new AppError(`Could not reach ${url.host}: ${error?.message ?? error}`, 502, "remote_unreachable")),
    );
    request.end(payload);
  });
}

/** Turns a remote error reply into an AppError with the remote's message. */
function remoteError(result, fallback) {
  const status = result.status >= 500 || result.status === 0 ? 502 : result.status;
  return new AppError(
    result.data?.error?.message ?? `${fallback} (HTTP ${result.status})`,
    status,
    result.data?.error?.code ?? "remote_error",
  );
}

export class RemoteHosts {
  /** @type {Remote[]} */
  #remotes = [];
  /** @type {Map<string, { server: http.Server, port: number, sockets: Set<import("node:net").Socket> }>} */
  #relays = new Map();
  /** @type {Map<string, https.Agent>} */
  #agents = new Map();
  #file;
  #logger;

  /**
   * @param {string} dir data directory
   * @param {{ logger?: { info: Function, warn: Function, debug: Function } }} [options]
   */
  constructor(dir, options = {}) {
    this.#file = path.join(dir, "remotes.json");
    this.#logger = options.logger;
    try {
      const stored = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      if (Array.isArray(stored?.remotes)) this.#remotes = stored.remotes;
    } catch {
      /* none yet */
    }
  }

  #save() {
    writePrivate(this.#file, JSON.stringify({ remotes: this.#remotes }, null, 2));
  }

  /** @param {string} id */
  #get(id) {
    const remote = this.#remotes.find((entry) => entry.id === id);
    if (!remote) throw new AppError("Unknown host", 404, "not_found");
    return remote;
  }

  /** @param {Remote} remote */
  #agent(remote) {
    let agent = this.#agents.get(remote.id);
    if (!agent) {
      agent = new https.Agent({ keepAlive: true, ...tlsOptions(remote.ca) });
      this.#agents.set(remote.id, agent);
    }
    return agent;
  }

  list() {
    return this.#remotes.map((remote) => ({ ...visible(remote), relayActive: this.#relays.has(remote.id) }));
  }

  /**
   * Pairs with a sharing host using its 6-digit code. The host's CA is pinned
   * from then on; `fingerprint` (from a QR code) is checked when given.
   * @param {{ address: unknown, code: unknown, fingerprint?: string, name?: string }} input
   */
  async pair({ address, code, fingerprint, name }) {
    const origin = remoteOrigin(address);
    if (!/^\d{6}$/.test(String(code ?? "").trim()))
      throw new AppError("Enter the 6-digit pairing code shown on the host", 400, "invalid_request");

    const download = await call(origin, "GET", "/ca.crt", { insecure: true });
    /** @type {string | null} */
    let ca = null;
    /** @type {string | null} */
    let pinned = null;
    if (download.status === 200) {
      let certificate;
      try {
        certificate = new X509Certificate(download.raw);
      } catch {
        throw new AppError("The host sent an invalid CA certificate", 502, "invalid_certificate");
      }
      if (!certificate.ca) throw new AppError("The host sent a certificate that is not a CA", 502, "invalid_certificate");
      ca = download.raw.toString("utf8");
      pinned = certificate.fingerprint256;
    }
    // Without a local CA (custom certificate) the host must be trusted by the system.
    if (fingerprint && normalizeFingerprint(fingerprint) !== normalizeFingerprint(pinned ?? ""))
      throw new AppError("The host certificate does not match the scanned fingerprint", 400, "fingerprint_mismatch");

    const paired = await call(origin, "POST", "/_vch/pair", {
      ca,
      body: { code: String(code).trim(), name: String(name ?? "").trim() || os.hostname(), platform: devicePlatform() },
    });
    if (paired.status !== 200 || !paired.data?.token) throw remoteError(paired, "Pairing failed");

    const health = await call(origin, "GET", "/api/health", { ca }).catch(() => null);
    const existing = this.#remotes.find((entry) => entry.url === origin);
    if (existing) await this.#closeRelay(existing.id);
    /** @type {Remote} */
    const remote = {
      id: existing?.id ?? randomUUID(),
      name:
        (health?.status === 200 && typeof health.data?.name === "string" && health.data.name) || new URL(origin).hostname,
      url: origin,
      ca,
      fingerprint: pinned,
      token: paired.data.token,
      deviceId: paired.data.device?.id ?? "",
      pairedAt: new Date().toISOString(),
      relayPort: existing?.relayPort,
    };
    this.#remotes = [...this.#remotes.filter((entry) => entry.url !== origin), remote];
    this.#save();
    this.#logger?.info("remotes", `paired with ${remote.name} (${origin})`);
    return visible(remote);
  }

  /** Remote health with this device's credentials; never throws. @param {string} id */
  async status(id) {
    const remote = this.#get(id);
    try {
      const result = await call(remote.url, "GET", "/api/status", {
        ca: remote.ca,
        token: remote.token,
        agent: this.#agent(remote),
      });
      if (result.status === 401)
        return { online: true, paired: false, error: "This device is no longer paired with the host" };
      if (result.status !== 200) return { online: true, paired: true, error: remoteError(result, "Status failed").message };
      return { online: true, paired: true, status: result.data };
    } catch (error) {
      return { online: false, paired: true, error: error?.message ?? String(error) };
    }
  }

  /**
   * Starts the remote IDE when needed and returns the local relay URL.
   * @param {string} id
   * @param {string} [target] path to open, e.g. `/?folder=…`
   */
  async open(id, target = "/") {
    const remote = this.#get(id);
    const started = await call(remote.url, "POST", "/api/ide/start", {
      ca: remote.ca,
      token: remote.token,
      agent: this.#agent(remote),
    });
    if (started.status !== 200) throw remoteError(started, "The remote IDE could not start");
    const port = await this.relay(id);
    return { url: `http://${HOST}:${port}${safePath(target)}` };
  }

  /**
   * Starts (once) the loopback relay for a remote and returns its port. The
   * relay adds the device token, so it only accepts requests addressed to
   * itself (DNS rebinding) and same-origin writes and WebSockets (CSRF).
   * @param {string} id
   */
  async relay(id) {
    const remote = this.#get(id);
    const running = this.#relays.get(id);
    if (running) return running.port;

    const port =
      remote.relayPort && (await isPortFree(remote.relayPort, HOST))
        ? remote.relayPort
        : await findFreePort(RELAY_BASE_PORT, HOST, 200);
    const origin = `http://${HOST}:${port}`;
    const hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
    const target = new URL(remote.url);
    const sockets = new Set();
    const credentials = (headers) => {
      delete headers["x-admin-token"];
      headers.authorization = `Bearer ${remote.token}`;
      return headers;
    };
    const allowed = (request, write) => {
      const host = String(request.headers.host ?? "");
      const from = request.headers.origin;
      if (!hosts.has(host)) return false;
      return !(from && from !== origin && (write || !SAFE_METHODS.has(String(request.method).toUpperCase())));
    };

    const server = http.createServer((request, response) => {
      if (!allowed(request, false)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        return void response.end("Forbidden");
      }
      const upstream = https.request(
        {
          host: target.hostname,
          port: target.port,
          method: request.method,
          path: request.url,
          headers: credentials(forwardHeaders(request.headers, { host: String(request.headers.host), protocol: "http" })),
          agent: this.#agent(remote),
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        this.#logger?.debug("remotes", `relay to ${remote.url} failed: ${error?.message ?? error}`);
        if (response.headersSent) return void response.destroy();
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "retry-after": "2" });
        response.end(`${remote.name} is unreachable. Check that it is sharing on the network, then reload.`);
      });
      response.on("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });

    server.on("upgrade", (request, socket, head) => {
      if (!allowed(request, true)) return void socket.destroy();
      const upstream = https.request({
        host: target.hostname,
        port: target.port,
        method: request.method ?? "GET",
        path: request.url,
        headers: credentials(
          forwardHeaders(request.headers, { host: String(request.headers.host), protocol: "http", keepUpgrade: true }),
        ),
        ...tlsOptions(remote.ca),
      });
      upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        const lines = ["HTTP/1.1 101 Switching Protocols"];
        for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2)
          lines.push(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upstreamHead?.length) socket.write(upstreamHead);
        if (head?.length) upstreamSocket.write(head);
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
        socket.once("close", () => upstreamSocket.destroy());
        upstreamSocket.once("close", () => socket.destroy());
        upstreamSocket.pipe(socket).pipe(upstreamSocket);
      });
      upstream.on("response", (upstreamResponse) => {
        socket.write(`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n\r\n`);
        socket.destroy();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.end();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
    this.#relays.set(id, { server, port, sockets });
    if (remote.relayPort !== port) {
      remote.relayPort = port;
      this.#save();
    }
    this.#logger?.info("remotes", `relay for ${remote.name} on ${origin}`);
    return port;
  }

  /** @param {string} id */
  async #closeRelay(id) {
    const relay = this.#relays.get(id);
    this.#relays.delete(id);
    this.#agents.get(id)?.destroy();
    this.#agents.delete(id);
    if (!relay) return;
    for (const socket of relay.sockets) socket.destroy();
    await new Promise((resolve) => relay.server.close(() => resolve(undefined)));
  }

  /**
   * Forgets a host: asks it to revoke this device (best effort), closes the
   * relay and deletes the token.
   * @param {string} id
   */
  async remove(id) {
    const remote = this.#get(id);
    await call(remote.url, "DELETE", "/api/device", {
      ca: remote.ca,
      token: remote.token,
      agent: this.#agent(remote),
    }).catch(() => undefined);
    await this.#closeRelay(id);
    this.#remotes = this.#remotes.filter((entry) => entry.id !== id);
    this.#save();
    this.#logger?.info("remotes", `forgot ${remote.name}`);
    return { ok: true };
  }

  async stop() {
    await Promise.all([...this.#relays.keys()].map((id) => this.#closeRelay(id)));
  }
}
