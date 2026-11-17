/**
 * Management API and the trust boundary between HTTP and HTTPS on one port.
 *
 * Trust model:
 * - HTTP loopback: the host machine itself; everyone local is already trusted
 *   (admin included) and needs no tokens.
 * - HTTPS LAN: a paired device — device token (`Authorization: Bearer` or
 *   `?token=` for the API) or the signed IDE session cookie. Host-only actions
 *   stay on loopback HTTP; pairing needs only its short-lived code.
 *
 * All requests are dispatched from one catch-all middleware provided by
 * `startHub`, so responses keep raw header control (proxied IDE traffic must
 * reach the browser untouched) and nothing falls through into framework
 * page/resource handling.
 */
import { X509Certificate } from "node:crypto";
import os from "node:os";
import QRCode from "qrcode";
import { AppError } from "../core/errors.js";
import { certificateHosts, isLoopback, lanAddresses } from "../core/net.js";

export const SESSION_COOKIE = "vchSession";
export const PROOF_HEADER = "x-vch-request";

/** Auth levels used by the route table. */
export const WHO = {
  /** No credential: pairing handshakes, the CA and the extension assets. */
  public: "public",
  /** Any paired device (device token or IDE session cookie). */
  device: "device",
  /** The host machine only (loopback listener, or the admin token remotely). */
  local: "local",
};

/**
 * Local means: on the loopback listener, or holding the admin token remotely.
 * @param {{ isLocal?: boolean, admin?: boolean }} request
 */
export function isLocalRequest(request) {
  return !!request.isLocal || !!request.admin;
}

function forbidden(message = "Only the host can do this") {
  return new AppError(message, 403, "host_only");
}

// -- Credential readers ------------------------------------------------------ //
const BEARER = /^Bearer\s+(.+)$/i;

function adminTokenOf(request) {
  return bearerOf(request.headers?.["x-admin-token"]) ?? request.cookies?.["vchAdmin"];
}

/** Device token from `Authorization: Bearer` or `?token=`. */
function deviceTokenOf(request) {
  return (
    bearerOf(request.headers?.authorization) ??
    (typeof request.params?.token === "string" ? request.params.token : undefined)
  );
}

function bearerOf(header) {
  if (typeof header !== "string") return undefined;
  const match = BEARER.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

function pairingLink(origin, code, fingerprint) {
  const url = new URL("/pair", origin);
  url.searchParams.set("code", code);
  if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
  return url.toString();
}

function browserPairingPage({ host, fingerprint, code = "", error = "" }) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  const content = code
    ? `<h1>Unable to pair</h1><p>${escape(error)}</p><p><a href="/pair">Enter another code</a></p>`
    : `<h1>Pair this browser</h1><p>Enter the six-digit code from <strong>Pair a Device</strong> on ${escape(host)}.</p>
      <form method="get"><label>Pairing code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus required></label><button>Pair and open IDE</button></form>
      ${fingerprint ? `<details><summary>Certificate fingerprint</summary><code>${escape(fingerprint)}</code></details>` : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair a Device — Vistta Code Hub</title><style>body{font:16px system-ui;background:#181818;color:#eee;max-width:32rem;margin:12vh auto;padding:1.5rem}form{display:flex;gap:.75rem;align-items:end;flex-wrap:wrap}input{display:block;width:10rem;margin:.5rem 0;padding:.75rem;font:1.5rem monospace}button{padding:.8rem 1rem;background:#ad6d32;color:white;border:0;border-radius:.3rem}label{display:block}a{color:#d9944f}details{margin-top:2rem}code{word-break:break-all;font-size:.8rem}</style></head><body>${content}</body></html>`;
}

/** Establishes a browser session without exposing its device token. */
function openBrowserSession(devices, request, response, deviceId) {
  const session = devices.signSession(deviceId);
  response.writeHead(302, {
    location: safeRedirectTarget(request.params.target),
    "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    "cache-control": "no-store",
  });
  response.end();
}

function safeRedirectTarget(target) {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") && !target.includes("\\")
    ? target
    : "/";
}

/**
 * @typedef {Object} RouteMatch
 * @property {{ method: string, path: string, who: string, handler: Function }} route
 * @property {Record<string, string>} params
 */

/**
 * @typedef {Object} HubRequest
 * @property {string} [method]
 * @property {Record<string, unknown>} [headers]
 * @property {Record<string, string>} [cookies]
 * @property {Record<string, string>} [params]
 * @property {Record<string, string>} [query]
 * @property {any} [body]
 * @property {boolean} [isLocal] the request arrived on a trusted listener
 * @property {boolean} [remote] listener serves other devices
 * @property {{ id: string, name: string, platform: string } | null} [device] paired device if authenticated
 * @property {boolean} [admin] holds the admin token
 * @property {{ debug: Function, info: Function, warn: Function, error: Function }} [logger]
 * @property {string} [pathname]
 */

/**
 * Marks up the request with trust information. Exported for tests.
 * @param {import("../core/devices.js").DeviceStore} devices
 * @param {{ remote: () => boolean }} context
 */
export function authenticateWith(devices, context) {
  /**
   * @param {HubRequest} request
   */
  return (request) => {
    const remote = context.remote();
    request.isLocal = !remote;
    request.remote = remote;
    request.device = null;
    request.admin = devices.isAdmin(adminTokenOf(request));
    if (!remote) return;
    const token = deviceTokenOf(request);
    request.device = devices.authenticate(token) ?? devices.verifySession(request.cookies?.[SESSION_COOKIE]);
  };
}

/**
 * The hub handle type is imported from index.js (see its typedef). Declared as
 * a type-only import to avoid a runtime cycle.
 * @typedef {import("./index.js").Hub} Hub
 */

/**
 * Builds the route table. Handlers receive `(request, response, hub)`; they may
 * respond themselves or return a value, which is sent as JSON. The `who` level
 * is enforced here per request (authorization travels with the route), and the
 * dispatcher may skip mounting `who: local` routes on remote listeners.
 * @param {Hub} hub
 */
export function createRoutes(hub) {
  const { devices, projects, extensions, launcher, config, logger } = hub;
  const port = config.server.port;
  let settingsRequested = false;
  let pairingRequested = false;

  // IPs first: the pairing link uses the first URL, and phones often can't resolve the host name.
  const lanUrls = () =>
    hub.sharing()
      ? [...new Set([...lanAddresses(), ...certificateHosts()])]
          .filter((host) => !isLoopback(host) && !host.includes(":"))
          .map((host) => `https://${host}:${port}`)
      : [];

  const health = () => ({
    ok: launcher.status().state !== "crashed",
    name: config.name,
    version: hub.version,
    sharing: hub.sharing(),
    uptimeMs: Date.now() - hub.startedAt,
    ide: launcher.status(),
    extensions: extensions.list().map((extension) => ({ id: extension.id, version: extension.version })),
    dataDir: hub.dataDir,
    features: { sharedChatSessions: hub.workbench?.()?.patched ?? false },
    lanUrls: lanUrls(),
  });

  return [
    // --- health & status -------------------------------------------------- //
    { method: "GET", path: "/api/health", who: WHO.public, handler: () => health() },
    {
      method: "GET",
      path: "/api/status",
      who: WHO.device,
      handler: () => ({
        name: config.name,
        ide: launcher.status(),
        projectsRoot: projects.root,
        recentProjects: projects.recent(),
        server: { uptimeMs: Date.now() - hub.startedAt, version: hub.version, sharing: hub.sharing(), lanUrls: lanUrls() },
      }),
    },
    // --- IDE lifecycle (stop/restart end sessions, so host only) ----------- //
    { method: "POST", path: "/api/ide/start", who: WHO.device, handler: () => launcher.start() },
    { method: "POST", path: "/api/ide/stop", who: WHO.local, handler: async () => (await launcher.stop(), { ok: true }) },
    { method: "POST", path: "/api/ide/restart", who: WHO.local, handler: () => launcher.restart() },
    // --- projects --------------------------------------------------------- //
    { method: "GET", path: "/api/projects", who: WHO.device, handler: () => projects.list() },
    {
      method: "POST",
      path: "/api/projects",
      who: WHO.device,
      handler: (request) => {
        const { name, gitInit } = request.body ?? {};
        if (typeof name !== "string" || !name.trim()) throw new AppError("name is required", 400, "invalid_request");
        return projects.create(name.trim(), { gitInit: gitInit === true });
      },
    },
    {
      method: "POST",
      path: "/api/projects/open",
      who: WHO.device,
      handler: (request) => {
        const body = request.body ?? {};
        const absolute = projects.open(typeof body.project === "string" ? body.project : undefined);
        return { ok: true, path: absolute, url: `/?folder=${encodeURIComponent(absolute)}` };
      },
    },
    // --- extensions ------------------------------------------------------- //
    { method: "GET", path: "/api/extensions", who: WHO.device, handler: () => extensions.list() },
    {
      method: "POST",
      path: "/api/extensions/install",
      who: WHO.local,
      handler: (request) => {
        const { id } = request.body ?? {};
        if (typeof id !== "string" || !id) throw new AppError("id is required", 400, "invalid_request");
        return extensions.install(id);
      },
    },
    {
      method: "POST",
      path: "/api/extensions/uninstall",
      who: WHO.local,
      handler: (request) => {
        const { id } = request.body ?? {};
        if (typeof id !== "string" || !id) throw new AppError("id is required", 400, "invalid_request");
        extensions.uninstall(id);
        return { ok: true };
      },
    },
    // --- config ----------------------------------------------------------- //
    { method: "GET", path: "/api/config", who: WHO.device, handler: () => config },
    { method: "PATCH", path: "/api/config", who: WHO.local, handler: (request) => hub.updateConfig(request.body ?? {}) },
    // --- logs ------------------------------------------------------------- //
    {
      method: "GET",
      path: "/api/logs",
      who: WHO.local,
      handler: (request) => logger.tail(Math.min(Math.max(parseInt(request.params.limit, 10) || 200, 1), 1000)),
    },
    // --- devices & pairing ------------------------------------------------ //
    {
      method: "GET",
      path: "/api/devices",
      who: WHO.local,
      handler: () => ({ devices: devices.list(), pairing: devices.pairing }),
    },
    {
      method: "POST",
      path: "/api/devices/pairing",
      who: WHO.local,
      handler: async (request) => {
        const pairing = hub.startPairing();
        request.logger?.info("api", `pairing open until ${pairing.expiresAt}`);
        const addresses = lanUrls();
        const fingerprint = caFingerprint();
        const link = addresses.length ? pairingLink(addresses[0], pairing.code, fingerprint) : null;
        return {
          pairing,
          host: config.name,
          lanUrls: addresses,
          fingerprint,
          link,
          qr: link ? await QRCode.toDataURL(link) : null,
        };
      },
    },
    {
      method: "DELETE",
      path: "/api/devices/pairing",
      who: WHO.local,
      handler: () => (devices.cancelPairing(), { ok: true }),
    },
    {
      method: "DELETE",
      path: "/api/devices/:id",
      who: WHO.local,
      handler: (request) => (devices.revoke(request.params.id), { ok: true }),
    },
    {
      method: "POST",
      path: "/api/devices/revoke",
      who: WHO.local,
      handler: (request) => {
        const { id } = request.body ?? {};
        if (typeof id !== "string" || !id) throw new AppError("id is required", 400, "invalid_request");
        devices.revoke(id);
        return { ok: true };
      },
    },
    // --- pairing handshake: the 6-digit code is the credential ------------ //
    {
      method: "POST",
      path: "/_vch/pair",
      who: WHO.public,
      handler: (request) => {
        const body = request.body ?? {};
        const result = devices.pair(body.code, { name: body.name, platform: body.platform });
        request.logger?.info("api", `paired device "${result.device.name}" (${result.device.platform})`);
        return result;
      },
    },
    // A paired device forgets this host and revokes its own token.
    {
      method: "DELETE",
      path: "/api/device",
      who: WHO.device,
      handler: (request) => {
        if (!request.device) throw new AppError("Only paired devices can unpair themselves", 400, "invalid_request");
        devices.revoke(request.device.id);
        request.logger?.info("api", `device "${request.device.name}" unpaired itself`);
        return { ok: true };
      },
    },
    // --- remote hosts this machine paired with (host only) ----------------- //
    { method: "GET", path: "/api/remotes", who: WHO.local, handler: () => ({ remotes: hub.remotes.list() }) },
    {
      method: "POST",
      path: "/api/remotes/pair",
      who: WHO.local,
      handler: (request) => {
        requireHostProof(request);
        const { address, code, fingerprint } = request.body ?? {};
        return hub.remotes.pair({ address, code, fingerprint: typeof fingerprint === "string" ? fingerprint : undefined });
      },
    },
    {
      method: "GET",
      path: "/api/remotes/:id/status",
      who: WHO.local,
      handler: (request) => hub.remotes.status(request.params.id),
    },
    {
      method: "POST",
      path: "/api/remotes/:id/open",
      who: WHO.local,
      handler: (request) => {
        requireHostProof(request);
        const target = typeof request.body?.target === "string" ? request.body.target : "/";
        return hub.remotes.open(request.params.id, target);
      },
    },
    {
      method: "DELETE",
      path: "/api/remotes/:id",
      who: WHO.local,
      handler: (request) => hub.remotes.remove(request.params.id),
    },
    // --- host state for the IDE extension --------------------------------- //
    { method: "GET", path: "/_vch/state", who: WHO.local, handler: hostStateRoute },
    {
      method: "POST",
      path: "/_vch/settings/claim",
      who: WHO.local,
      handler: (request) => {
        requireHostProof(request);
        const open = settingsRequested;
        settingsRequested = false;
        return { open };
      },
    },
    {
      method: "POST",
      path: "/_vch/pairing/claim",
      who: WHO.local,
      handler: (request) => {
        requireHostProof(request);
        const open = pairingRequested;
        pairingRequested = false;
        return { open };
      },
    },
    { method: "GET", path: "/_vch/startup", who: WHO.local, handler: (request) => startupRoute(request, false) },
    { method: "POST", path: "/_vch/startup", who: WHO.local, handler: (request) => startupRoute(request, true) },
    // --- one-time ticket → IDE session for paired devices ----------------- //
    {
      method: "POST",
      path: "/api/ide/ticket",
      who: WHO.device,
      handler: (request) => {
        const body = request.body ?? {};
        const target = typeof body.target === "string" ? body.target : "/";
        const ticket = devices.issueTicket(request.device.id, target);
        return { ticket, url: `/_vch/open?ticket=${encodeURIComponent(ticket)}` };
      },
    },
    // Browser pairing: a short-lived code grants a revocable, cookie-based session.
    {
      method: "GET",
      path: "/pair",
      who: WHO.public,
      handler: (request, response) => {
        const code = String(request.params.code ?? "").trim();
        const fingerprint = caFingerprint();
        const sendPage = (status, error = "") => {
          const body = browserPairingPage({ host: config.name, fingerprint, code, error });
          response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(body);
        };
        if (!code) return sendPage(200);
        const acceptsJson = String(request.headers.accept ?? "").includes("application/json");
        const suppliedFingerprint = typeof request.params.fingerprint === "string" ? request.params.fingerprint : "";
        if (
          suppliedFingerprint &&
          fingerprint &&
          suppliedFingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase() !==
            fingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase()
        ) {
          if (acceptsJson)
            throw new AppError("The QR code's certificate fingerprint is no longer valid", 403, "fingerprint_mismatch");
          return sendPage(403, "The host certificate has changed. Scan a new pairing QR code.");
        }
        let paired;
        try {
          paired = devices.pair(code, {
            name: request.params.name || os.hostname(),
            platform: acceptsJson ? "android" : "browser",
          });
        } catch (error) {
          if (acceptsJson || !(error instanceof AppError)) throw error;
          return sendPage(error.status, error.message);
        }
        if (acceptsJson) return paired;
        request.logger?.info("api", `paired browser "${paired.device.name}" (${paired.device.id})`);
        openBrowserSession(devices, request, response, paired.device.id);
      },
    },
    // Exchanges the one-time ticket for an IDE session cookie, then forwards to
    // the IDE root (or the target requested at ticket time).
    {
      method: "GET",
      path: "/_vch/open",
      who: WHO.public,
      handler: (request, response) => {
        const redeemed = devices.redeemTicket(request.params.ticket);
        if (!redeemed)
          throw new AppError("Ticket expired or unknown. Request a new one from the app.", 403, "invalid_ticket");
        const maxAge = Math.round(redeemed.maxAge);
        response.writeHead(302, {
          location: redeemed.path || "/",
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(redeemed.session)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
          "cache-control": "no-store",
        });
        response.end();
      },
    },
    // The public CA for new devices (device tokens not needed yet).
    {
      method: "GET",
      path: "/ca.crt",
      who: WHO.public,
      handler: (request, response) => {
        const ca = hub.caCertificate?.();
        if (!ca) throw new AppError("No local CA available", 404, "not_found");
        response.writeHead(200, {
          "content-type": "application/x-pem-file",
          "content-disposition": 'attachment; filename="vistta-code-hub-rootCA.pem"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(ca instanceof Buffer ? ca : Buffer.from(String(ca)));
      },
    },
    // --- host actions from the IDE --------------------------------------- //
    { method: "POST", path: "/_vch/host/:action", who: WHO.local, handler: hostActionRoute },
  ].map((route) => enforce(route));

  /** Authorization travels with the route, so it holds wherever it is called. */
  function enforce(route) {
    if (route.who === WHO.public) return route;
    return {
      ...route,
      async handler(request, response, context) {
        if (route.who === WHO.local && !isLocalRequest(/** @type {HubRequest} */ (request))) throw forbidden();
        if (
          route.who === WHO.device &&
          !isLocalRequest(/** @type {HubRequest} */ (request)) &&
          !(/** @type {HubRequest} */ (request).device)
        )
          throw unauthorized();
        return route.handler(request, response, context);
      },
    };
  }

  /** SHA-256 of the local CA (`AA:BB:…`), once sharing created it. */
  function caFingerprint() {
    const ca = hub.caCertificate?.();
    if (!ca) return null;
    try {
      return new X509Certificate(ca).fingerprint256;
    } catch {
      return null;
    }
  }

  function unauthorized() {
    return new AppError("Pair with the host to continue", 401, "unauthorized");
  }

  function hostStateRoute(request) {
    requireHostProof(request);
    return {
      sharing: hub.sharing(),
      controllable: true,
      desktop: !!hub.desktop,
      ...(settingsRequested ? { settingsRequested: true } : {}),
      ...(pairingRequested ? { pairingRequested: true } : {}),
      lanUrls: lanUrls(),
    };
  }

  function hostActionRoute(request) {
    requireHostProof(request);
    const action = request.params.action;
    const known = [
      "share",
      "stopSharing",
      "openDashboard",
      "openSettings",
      "openInBrowser",
      "openRemote",
      "restartIde",
      "pairDevice",
      "hideWindow",
    ];
    if (!known.includes(action)) throw new AppError("Unknown action", 404, "not_found");
    if (action === "openSettings") {
      settingsRequested = true;
      return { ok: true };
    }
    if (action === "pairDevice") {
      pairingRequested = true;
      return { ok: true };
    }
    const body = action === "openRemote" ? remoteWindow(request.body) : (request.body ?? {});
    // Runs after the reply: sharing and restarts disconnect this very client.
    setImmediate(() => {
      Promise.resolve(hub.hostAction?.(action, body)).catch((error) =>
        request.logger?.error("api", `host action ${action} failed: ${error?.stack || error?.message || error}`),
      );
    });
    return { ok: true };
  }

  async function startupRoute(request, change) {
    requireHostProof(request);
    if (!hub.desktop || !hub.desktopStartup)
      throw new AppError("Login startup is only available in the Windows/Linux desktop app", 409, "desktop_required");
    if (change && typeof request.body?.enabled !== "boolean")
      throw new AppError("enabled must be true or false", 400, "invalid_request");
    const enabled = await hub.desktopStartup(change ? request.body.enabled : undefined);
    return { enabled };
  }

  /** Only a known remote's running relay may be opened. */
  function remoteWindow(body) {
    const remote = hub.remotes.list().find((entry) => entry.id === body?.id);
    const prefix = remote?.relayActive ? `http://127.0.0.1:${remote.relayPort}/` : undefined;
    if (!prefix || typeof body.url !== "string" || !body.url.startsWith(prefix))
      throw new AppError("Open the computer first (POST /api/remotes/:id/open)", 400, "invalid_request");
    return { id: remote.id, name: remote.name, url: body.url };
  }

  /** Custom request header defeats drive-by posts from other websites. */
  function requireHostProof(request) {
    if (!isLocalRequest(request)) throw forbidden();
    if (request.headers?.[PROOF_HEADER] !== "1") throw new AppError("Origin not allowed", 403, "cross_origin");
  }
}

/**
 * Matches a request path against one route pattern with `:param` segments.
 * @param {"GET" | "POST" | "PATCH" | "DELETE"} method
 * @returns {RouteMatch | null}
 */
export function matchRoute(routes, method, path) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternParts = route.path.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = /** @type {Record<string, string>} */ ({});
    let matched = true;
    for (let i = 0; i < patternParts.length; i++) {
      const part = patternParts[i];
      if (part.startsWith(":")) params[part.slice(1)] = safeDecode(pathParts[i]);
      else if (part !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
