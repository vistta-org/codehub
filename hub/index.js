/**
 * startHub — wires config, logger, supervisor, IDE launcher, stores, TLS, the
 * shared TCP listener and the IDE proxy into one process.
 *
 * One port dispatches loopback HTTP and, while sharing, paired LAN HTTPS.
 * Plain HTTP from non-loopback peers is rejected before reaching the API.
 *
 * Toggling sharing gates TLS connections and destroys its remote sockets;
 * the backend itself never restarts.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { loadConfig, updateConfigFile, validateConfig } from "../core/config.js";
import { DeviceStore } from "../core/devices.js";
import { ExtensionManager } from "../core/extensions.js";
import { Logger } from "../core/logger.js";
import { findFreePort, isLoopback, isPortFree, lanAddresses } from "../core/net.js";
import { bundledExtensionsDir, dataDir as defaultDataDir, runtimeDir as runtimeDirOf } from "../core/paths.js";
import { ProjectStore } from "../core/projects.js";
import { CodeServerLauncher } from "../core/runtime.js";
import { Supervisor } from "../core/supervisor.js";
import { resolveCertificate } from "../core/tls.js";
import { authenticateWith, createRoutes, isLocalRequest, matchRoute } from "./api.js";
import { extensionManifest, extensionScript } from "./extension.js";
import { IdeProxy, isPublicAsset } from "./proxy.js";
import { RemoteHosts } from "./remotes.js";
import { createWorkbenchLoader } from "./workbench.js";

const HOST = "127.0.0.1";
const APP_ICON = path.resolve(import.meta.dirname, "..", "assets", "icon.png");

/**
 * @typedef {Object} StartOptions
 * @property {string} [dataDir] persistent data folder (default `<project>/data`)
 * @property {string} [runtimeRoot] code-server runtime base folder
 * @property {import("../core/config.js").AppConfig} [config] use this config instead of loading one
 * @property {(action: string, body: Record<string, unknown>) => boolean | void | Promise<boolean | void>} [hostAction]
 *   desktop-only host actions; return false to fall back to openExternal for openInBrowser
 * @property {(url: string) => void} [openExternal] open a URL outside the hub (browser/app)
 * @property {boolean} [startIde=true] start code-server right away
 * @property {boolean} [startShare] override `config.server.share`
 * @property {boolean} [desktop=false] native desktop host actions are available
 * @property {(enabled?: boolean) => Promise<boolean>} [desktopStartup] read/change native OS login startup
 * @property {number} [port] override `server.port`
 * @property {number} [idePort] override `ide.port`
 */

/**
 * @typedef {Object} Hub
 * @property {import("../core/config.js").AppConfig} config
 * @property {import("../core/logger.js").Logger} logger
 * @property {import("../core/supervisor.js").Supervisor} supervisor
 * @property {CodeServerLauncher} launcher
 * @property {ProjectStore} projects
 * @property {ExtensionManager} extensions
 * @property {DeviceStore} devices
 * @property {RemoteHosts} remotes
 * @property {() => { body: Buffer, etag: string, patched: boolean } | undefined} workbench
 * @property {IdeProxy} proxy
 * @property {string} dataDir
 * @property {string} runtimeDir
 * @property {number} startedAt
 * @property {string} version
 * @property {boolean} desktop
 * @property {(enabled?: boolean) => Promise<boolean>} [desktopStartup]
 * @property {() => boolean} sharing
 * @property {() => string[]} lanUrls
 * @property {(patch: Record<string, unknown>) => Promise<import("../core/config.js").AppConfig>} updateConfig
 * @property {(enabled: boolean) => Promise<boolean>} share
 * @property {() => Promise<ReturnType<import("../core/runtime.js").CodeServerLauncher["status"]>>} startIde
 * @property {() => Promise<void>} stopIde
 * @property {() => Promise<ReturnType<import("../core/runtime.js").CodeServerLauncher["status"]>>} restartIde
 * @property {() => ReturnType<DeviceStore["startPairing"]>} startPairing
 * @property {(action: string, body?: Record<string, unknown>) => boolean | void | Promise<boolean | void | ReturnType<CodeServerLauncher["status"]>>} hostAction
 * @property {() => Buffer | undefined} caCertificate
 * @property {() => Promise<void>} stop
 */

/**
 * Starts the hub and returns a handle for the desktop app, tests and `server.js`.
 * @param {StartOptions} [options]
 */
export async function startHub(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir());
  fs.mkdirSync(dataDir, { recursive: true });

  if ("lanPort" in options) throw new Error("Use port for both HTTP and HTTPS; lanPort is no longer supported.");
  const config = options.config ?? loadConfig(dataDir);
  if (options.startShare !== undefined) config.server.share = options.startShare;
  if (options.port !== undefined) config.server.port = options.port;
  if (options.idePort !== undefined) config.ide.port = options.idePort;
  Object.assign(config, validateConfig(config));
  const port = config.server.port;

  // The IDE must start on a free loopback port; busy ports are common on dev machines.
  let idePort = (await isPortFree(config.ide.port, HOST)) ? config.ide.port : await findFreePort(config.ide.port, HOST);
  if (idePort === port) idePort = await findFreePort(port + 1, HOST);
  const portChanged = idePort !== config.ide.port;
  if (portChanged) config.ide.port = idePort;
  const runtimeDir =
    options.runtimeRoot === undefined
      ? runtimeDirOf(config)
      : runtimeDirOf(config, { VCH_RUNTIME_ROOT: options.runtimeRoot });

  const logger = new Logger({
    file: path.join(dataDir, "logs", "app.jsonl"),
    level: config.server.logLevel,
  });
  if (portChanged) logger.warn("app", `IDE port was busy; using ${idePort} instead`);

  const supervisor = new Supervisor();
  const launcher = new CodeServerLauncher({ config, logger, supervisor, dataDir, runtimeDir });

  const persistRecent = (recent) => {
    config.projects.recent = recent;
    try {
      updateConfigFile(dataDir, (onDisk) => {
        onDisk.projects ??= {};
        onDisk.projects.recent = recent;
      });
    } catch (error) {
      logger.warn("app", `Could not persist recent projects: ${error?.message ?? error}`);
    }
  };
  const projects = new ProjectStore(config, persistRecent);
  const extensions = new ExtensionManager({
    runtimeDir,
    get extensionsDir() {
      return path.join(dataDir, "ide", "extensions");
    },
    logger,
  });
  extensions.installBuiltIn(extensionManifest, extensionScript);

  const devices = new DeviceStore(dataDir, { onChange: () => undefined });
  const remotes = new RemoteHosts(dataDir, { logger });

  // LAN clients see a different host:port; the workbench hashes all of them as
  // the loopback one so workspace storage and chat sessions are shared.
  const workbench = createWorkbenchLoader(runtimeDir, `${HOST}:${config.ide.port}`, logger);
  const proxy = new IdeProxy({
    port: () => config.ide.port,
    workbench,
    // A custom icon in the data folder wins over the bundled app icon.
    iconFile: [path.join(dataDir, "icon.png"), APP_ICON].find((file) => fs.existsSync(file)),
    logger,
  });

  /** @type {Hub} */
  const hub = {
    config,
    logger,
    supervisor,
    launcher,
    projects,
    extensions,
    devices,
    remotes,
    workbench,
    proxy,
    dataDir,
    runtimeDir,
    startedAt: Date.now(),
    version: "0.1.0",
    desktop: !!options.desktop,
    desktopStartup: options.desktopStartup,
    sharing: () => httpsState.active,
    lanUrls: () => (httpsState.active ? lanAddresses().map((address) => `https://${address}:${port}`) : []),
    updateConfig,
    share,
    startIde,
    stopIde: () => launcher.stop(),
    restartIde: () => launcher.restart(),
    startPairing: () => devices.startPairing(),
    hostAction,
    caCertificate: () => tlsFiles?.ca?.pem,
    stop,
  };

  const routes = createRoutes(hub);

  function authenticate(request) {
    authenticateWith(devices, { remote: () => request.remote === true })(/** @type {any} */ (request));
    request.logger = logger;
  }

  /**
   * One request pipeline for both listeners.
   * @param {any} request
   * @param {http.ServerResponse} response
   */
  async function dispatch(request, response) {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${port}`}`);
      request.pathname = url.pathname;
      request.params = Object.fromEntries(url.searchParams.entries());
      request.query = request.params;
      request.cookies = parseCookies(request.headers.cookie);
      request.logger = logger;
      const origin = request.headers.origin;
      // The bundled desktop app loads from tauri://localhost (or http://tauri.localhost
      // on Windows); CORS headers let its dashboard fetch the loopback API.
      const cors =
        !request.remote && typeof origin === "string" && /^tauri:\/\/|^https?:\/\/(tauri\.)?localhost$/i.test(origin);
      if (cors) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
        response.setHeader("access-control-allow-credentials", "true");
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "access-control-allow-methods": "GET, POST, PATCH, DELETE",
            "access-control-allow-headers": "content-type, authorization, x-admin-token, x-vch-request",
            "access-control-max-age": "600",
          });
          response.end();
          return;
        }
      }
      authenticate(request);
      const body = await readJsonBody(request);
      request.body = body;
      const found = matchRoute(routes, request.method.toUpperCase(), request.pathname);
      if (found) {
        request.params = { ...request.params, ...found.params };
        logger.debug(
          "api",
          `${request.method} ${request.pathname} (${request.device?.name ?? (request.admin ? "admin" : request.isLocal ? "local" : "anon")})`,
        );
        const value = await found.route.handler(request, response, hub);
        if (!response.writableEnded && !response.headersSent)
          sendJson(response, 200, value === undefined ? { ok: true } : value);
        return;
      }
      // API misses never reach the IDE: they are structured JSON errors.
      if (request.pathname.startsWith("/api/")) {
        sendJson(response, 404, {
          error: { code: "not_found", message: `No API route for ${request.method} ${request.pathname}` },
        });
        return;
      }
      // The IDE has no auth of its own: LAN callers need a device credential.
      if (request.remote && !isLocalRequest(request) && !request.device && !isPublicAsset(request.pathname)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Pair with the host to continue" } });
        return;
      }
      proxyWeb(request, response);
    } catch (error) {
      respondError(request, response, error);
    }
  }

  function proxyWeb(request, response) {
    try {
      proxy.web(request, response);
    } catch (error) {
      logger.error("api", `IDE proxy failed: ${error?.stack || error?.message || error}`);
      if (!response.headersSent)
        sendJson(response, 503, {
          error: {
            code: "ide_unavailable",
            message: "The IDE is not running. Start it on the host or POST /api/ide/start.",
          },
        });
      else response.destroy();
    }
  }

  // --- HTTP helpers --------------------------------------------------------- //

  function readJsonBody(request) {
    return new Promise((resolve) => {
      if (request.readableEnded || request.complete === true) return resolve(undefined);
      const chunks = [];
      let size = 0;
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_048_576) {
          request.destroy(new Error("Body too large"));
          return done(undefined);
        }
        chunks.push(chunk);
      });
      request.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return done(undefined);
        try {
          done(JSON.parse(text));
        } catch {
          done(text);
        }
      });
      request.once("error", () => done(undefined));
    });
  }

  function parseCookies(header) {
    const cookies = {};
    for (const part of String(header ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return cookies;
  }

  function sendJson(response, status, value) {
    const body = Buffer.from(JSON.stringify(value ?? null));
    if (response.writableEnded || response.headersSent) return response.end();
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.length),
    });
    response.end(body);
  }

  function respondError(request, response, error) {
    const status = error?.status ?? 500;
    const code = error?.code ?? "internal_error";
    const message = error?.message ?? "Internal Server Error";
    if (status >= 500)
      logger.error("api", `${request.method} ${request.pathname || request.url}: ${error?.stack || message}`);
    else logger.debug("api", `${request.method} ${request.pathname || request.url}: ${message}`);
    if (response.writableEnded || response.headersSent) return;
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (status === 401) headers["www-authenticate"] = 'Bearer realm="codehub"';
    const body = Buffer.from(JSON.stringify({ error: { code, message } }));
    response.writeHead(status, headers);
    response.end(body);
  }

  // --- IDE launch ------------------------------------------------------------ //

  let bundledDone;
  function installBundled() {
    bundledDone ??= extensions.installBundled(bundledExtensionsDir(runtimeDir));
    return bundledDone;
  }

  async function startIde() {
    await installBundled();
    return launcher.start();
  }

  // --- sharing ---------------------------------------------------------------- //

  /** @type {{ server: import("node:https").Server | undefined, active: boolean, sockets: Set<import("node:net").Socket> }} */
  const httpsState = { server: undefined, active: false, sockets: new Set() };
  let tlsFiles;
  let sharingChange = Promise.resolve();

  function share(enabled, persist = true) {
    const result = sharingChange.then(() => setSharing(enabled, persist));
    sharingChange = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function setSharing(enabled, persist) {
    const current = httpsState.active;
    if (enabled && !current) {
      tlsFiles ??= await resolveCertificate(config.server.tls, path.join(dataDir, "tls"), dataDir);
      for (const problem of tlsFiles.problems)
        logger.warn("app", `HTTPS certificate ${problem}; devices may see a warning until "npm run cert" renews it`);
      if (!httpsState.server) {
        const server = https.createServer(
          { key: fs.readFileSync(tlsFiles.key), cert: fs.readFileSync(tlsFiles.cert), handshakeTimeout: 10_000 },
          (request, response) => {
            /** @type {any} */ (request).remote = true;
            dispatch(request, response);
          },
        );
        server.on("upgrade", upgradeRemote);
        server.on("tlsClientError", (error) => logger.debug("api", `TLS handshake failed: ${error?.message ?? error}`));
        const sockets = httpsState.sockets;
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        httpsState.server = server;
      }
    }
    if (persist) {
      updateConfigFile(dataDir, (onDisk) => {
        onDisk.server ??= {};
        onDisk.server.share = enabled;
      });
      config.server.share = enabled;
    }
    if (enabled === current) return current;
    if (enabled) {
      httpsState.active = true;
      logger.info("app", `sharing: ${hub.lanUrls().join(", ")}`);
    } else {
      httpsState.active = false;
      for (const socket of httpsState.sockets) socket.destroy();
      httpsState.sockets.clear();
      logger.info("app", "sharing stopped");
    }
    // LAN IDE sessions must end immediately, without disconnecting local HTTP.
    proxy.closeRemote();
    return httpsState.active;
  }

  // --- config changes ---------------------------------------------------------- //

  async function updateConfig(patch) {
    const ideBefore = { port: config.ide.port, extraArgs: config.ide.extraArgs, installPath: config.ide.installPath };
    const next = validateConfig({ ...structuredClone(config), ...(patch ?? {}) });
    Object.assign(config, next);
    updateConfigFile(dataDir, (onDisk) => {
      // Persist everything changed in memory; env overrides are reapplied from
      // the environment on the next launch, so this still stays honest.
      const saved = structuredClone(config);
      onDisk.name = saved.name;
      onDisk.desktop = saved.desktop;
      onDisk.server = saved.server;
      onDisk.ide = saved.ide;
      onDisk.projects = saved.projects;
    });
    logger.setLevel(config.server.logLevel);
    const ideChanged =
      ideBefore.port !== config.ide.port ||
      ideBefore.extraArgs.join?.("\u0000") !== config.ide.extraArgs.join?.("\u0000") ||
      ideBefore.installPath !== config.ide.installPath;
    if (ideChanged && launcher.status().state === "running") {
      logger.info("app", "IDE config changed; restarting the IDE");
      await launcher.restart().catch((error) => logger.error("app", `IDE restart failed: ${error?.message ?? error}`));
    }
    return config;
  }

  // --- host actions from the IDE ------------------------------------------------ //

  function hostAction(action, body = {}) {
    switch (action) {
      case "share":
        return share(true);
      case "stopSharing":
        return share(false);
      case "restartIde":
        return launcher.restart();
      case "openInBrowser":
        if (options.hostAction?.(action, body)) return;
        return options.openExternal?.(`http://${HOST}:${port}`);
      case "openRemote":
        // Validated by the route: a running relay of a paired computer.
        if (options.hostAction?.(action, body)) return;
        return options.openExternal?.(String(body.url));
      default:
        // openDashboard, pairDevice, hideWindow — the desktop host implements these.
        return options.hostAction?.(action, body);
    }
  }

  // --- WebSocket upgrades --------------------------------------------------------- //

  /** @param {any} request */
  function upgradeLocal(request, socket, head) {
    request.remote = false;
    upgrade(request, socket, head);
  }

  /** @param {any} request */
  function upgradeRemote(request, socket, head) {
    request.remote = true;
    upgrade(request, socket, head);
  }

  function upgrade(request, socket, head) {
    try {
      if (!request.url || request.url.startsWith("/socket.io/")) return socket.end();
      const url = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${port}`}`);
      request.pathname = url.pathname;
      request.cookies = parseCookies(request.headers.cookie);
      authenticate(request);
      const path = url.pathname;
      const hostOnly = path.startsWith("/api/") || path.startsWith("/_vch/host/");
      if (hostOnly && !isLocalRequest(request)) return socket.end();
      if (request.remote && !isLocalRequest(request) && !request.device) return socket.end();
      proxy.ws(request, socket, head, { remote: !!request.remote, protocol: request.remote ? "https" : "http" });
    } catch (error) {
      logger.debug("api", `upgrade rejected: ${error?.message ?? error}`);
      socket.end();
    }
  }

  // --- listeners ------------------------------------------------------------------- //

  const httpServer = http.createServer((request, response) => dispatch(request, response));
  httpServer.on("upgrade", upgradeLocal);
  httpServer.on("clientError", (error, socket) => {
    if ("writable" in socket && socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  const sockets = new Set();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => logger.debug("api", `Connection failed: ${error.message}`));
    const timeout = () => {
      logger.debug("api", "Connection timed out before sending HTTP or TLS");
      socket.destroy();
    };
    socket.setTimeout(10_000, timeout);
    socket.once("data", (data) => {
      socket.pause();
      socket.setTimeout(0);
      socket.off("timeout", timeout);
      // A TLS ClientHello starts with handshake record type 22.
      const tls = data[0] === 22;
      const server = tls
        ? httpsState.active
          ? httpsState.server
          : undefined
        : isLoopback(socket.remoteAddress)
          ? httpServer
          : undefined;
      if (!server) {
        logger.debug("api", `Rejected ${tls ? "TLS while sharing is off" : "non-loopback HTTP"} connection`);
        socket.destroy();
        return;
      }
      socket.unshift(data);
      server.emit("connection", socket);
      // TLS drains the raw socket's buffered ClientHello on its next tick.
      if (!tls) socket.resume();
    });
  });
  await listen(listener, port);
  logger.info("app", `hub ready on http://${HOST}:${port} (shared HTTP/HTTPS port; data: ${dataDir})`);

  if (options.startIde !== false)
    await startIde().catch((error) => logger.error("app", `IDE start failed: ${error?.stack || error?.message || error}`));
  if (config.server.share)
    await share(true, false).catch((error) =>
      logger.error("app", `initial share failed: ${error?.stack || error?.message || error}`),
    );

  // --- shutdown ---------------------------------------------------------------------- //

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    logger.info("app", "hub stopping");
    /** @type {[string, () => any][]} */
    const steps = [
      ["sharing", () => share(false, false)],
      ["remotes", () => remotes.stop()],
      ["ide", () => launcher.stop()],
      ["children", () => supervisor.stopAll()],
      [
        "listeners",
        async () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await close(listener);
        },
      ],
      ["logs", () => (logger.close(), undefined)],
    ];
    for (const [name, task] of steps) {
      try {
        await task();
      } catch (error) {
        logger.error("app", `stop step "${name}" failed: ${error?.stack || error?.message || error}`);
      }
    }
  }

  return hub;
}

// -- small listen/close helpers ------------------------------------------------- //

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}
