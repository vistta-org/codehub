/**
 * Reverse proxy to the loopback code-server, for HTTP (including HTTP/2
 * requests from the LAN listener) and WebSocket upgrades. Hop-by-hop headers
 * are dropped so responses are valid on both HTTP/1.1 and HTTP/2.
 */
import fs from "node:fs";
import http from "node:http";
import { extensionManifest, extensionScript } from "./extension.js";
import { EXTENSION_PATH } from "./workbench.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "http2-settings",
]);
const WORKBENCH = /^\/[^/]+\/static\/out\/vs\/code\/browser\/workbench\/workbench\.js$/;
const CODE_ICON = /^\/[^/]+\/static\/out\/(?:.+\/)?code-icon\.svg$/;
export const TITLEBAR_PATH = "/_vch/titlebar.js";
const titlebarScript = fs.readFileSync(new URL("./titlebar.js", import.meta.url), "utf8");
const MEDIA = "/_static/src/browser/media";
const ICON_FILES = new Set(
  [
    "favicon-dark-support.svg",
    "favicon.svg",
    "favicon.ico",
    "pwa-icon-192.png",
    "pwa-icon-512.png",
    "pwa-icon-maskable-192.png",
    "pwa-icon-maskable-512.png",
  ].map((name) => `${MEDIA}/${name}`),
);

/**
 * Branding assets browsers fetch without credentials (PWA manifest, icons).
 * @param {string} pathname
 */
export function isPublicAsset(pathname) {
  return (
    pathname === "/manifest.json" ||
    pathname === "/vscode/manifest.json" ||
    ICON_FILES.has(pathname) ||
    CODE_ICON.test(pathname)
  );
}

/**
 * Adds the desktop title-bar script to the workbench page (other HTML is left
 * alone). The script does nothing outside the desktop app's IDE windows.
 * @param {Buffer} html
 */
export function injectTitlebar(html) {
  const text = html.toString("utf8");
  if (!text.includes("vscode-workbench-web-configuration") || text.includes(TITLEBAR_PATH)) return html;
  const index = text.indexOf("</head>");
  if (index < 0) return html;
  return Buffer.from(`${text.slice(0, index)}<script src="${TITLEBAR_PATH}" defer></script>\n${text.slice(index)}`);
}

/**
 * @param {Record<string, any>} source
 * @param {{ host: string, protocol: string, keepUpgrade?: boolean }} options
 */
export function forwardHeaders(source, { host, protocol, keepUpgrade = false }) {
  /** @type {Record<string, any>} */
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(":") || value === undefined) continue;
    if (HOP_BY_HOP.has(key) && !(keepUpgrade && (key === "connection" || key === "upgrade"))) continue;
    headers[key] = value;
  }
  headers.host = host;
  headers["x-forwarded-host"] = host;
  headers["x-forwarded-proto"] = protocol;
  return headers;
}

/** @param {import("node:http").IncomingHttpHeaders} source */
export function responseHeaders(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !HOP_BY_HOP.has(key)));
}

export class IdeProxy {
  /** @type {Set<{ socket: import("node:net").Socket, remote: boolean }>} */
  #sockets = new Set();

  /**
   * @param {{
   *   port: () => number,
   *   workbench: () => { body: Buffer, etag: string } | undefined,
   *   iconFile?: string,
   *   logger: import("../core/logger.js").Logger,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.icon = options.iconFile && fs.existsSync(options.iconFile) ? fs.readFileSync(options.iconFile) : undefined;
  }

  /** Answers paths the hub replaces; returns false for everything else. */
  #serveOwn(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-cache", ...headers });
      response.end(body);
      return true;
    };
    if (WORKBENCH.test(pathname)) {
      const workbench = this.options.workbench();
      if (!workbench) return false;
      if (request.headers["if-none-match"] === workbench.etag) {
        response.writeHead(304, { etag: workbench.etag, "cache-control": "no-cache" });
        response.end();
        return true;
      }
      return send(200, "text/javascript; charset=utf-8", workbench.body, { etag: workbench.etag });
    }
    if (this.icon && (CODE_ICON.test(pathname) || ICON_FILES.has(pathname))) return send(200, "image/png", this.icon);
    if (pathname === "/manifest.json" || pathname === "/vscode/manifest.json")
      return send(200, "application/manifest+json", JSON.stringify(this.#manifest()));
    if (pathname === `${EXTENSION_PATH}/package.json`)
      return send(200, "application/json", JSON.stringify(extensionManifest));
    if (pathname === `${EXTENSION_PATH}/extension.js`) return send(200, "text/javascript; charset=utf-8", extensionScript);
    if (pathname === TITLEBAR_PATH) return send(200, "text/javascript; charset=utf-8", titlebarScript);
    return false;
  }

  #manifest() {
    const icons = this.icon
      ? [
          {
            src: `${MEDIA}/pwa-icon-512.png`,
            type: "image/png",
            // PNG IHDR: width and height at bytes 16-23.
            sizes: `${this.icon.readUInt32BE(16)}x${this.icon.readUInt32BE(20)}`,
            purpose: "any",
          },
        ]
      : [192, 512].flatMap((size) =>
          ["any", "maskable"].map((purpose) => ({
            src: `${MEDIA}/pwa-icon-${purpose === "any" ? "" : "maskable-"}${size}.png`,
            type: "image/png",
            sizes: `${size}x${size}`,
            purpose,
          })),
        );
    return {
      id: "/",
      name: "Vistta Code Hub",
      short_name: "Code Hub",
      description: "Your projects and IDE, anywhere on your network.",
      start_url: ".",
      display: "standalone",
      display_override: ["window-controls-overlay"],
      background_color: "#1f1f1f",
      theme_color: "#1f1f1f",
      icons,
    };
  }

  /**
   * @param {import("node:http").IncomingMessage & { protocol?: string }} request
   * @param {import("node:http").ServerResponse} response
   */
  web(request, response) {
    if (this.#serveOwn(request, response)) return;
    const host = request.headers.host ?? request.headers[":authority"] ?? "localhost";
    // Pages are rewritten (title-bar script), so ask for them uncompressed.
    const page = request.method === "GET" && String(request.headers.accept ?? "").includes("text/html");
    const headers = forwardHeaders(request.headers, { host: String(host), protocol: request.protocol ?? "http" });
    if (page) headers["accept-encoding"] = "identity";
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: this.options.port(),
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        const html = String(upstreamResponse.headers["content-type"] ?? "").startsWith("text/html");
        if (page && html && !upstreamResponse.headers["content-encoding"]) {
          const chunks = [];
          upstreamResponse.on("data", (chunk) => chunks.push(chunk));
          upstreamResponse.on("error", () => response.destroy());
          upstreamResponse.on("end", () => {
            const body = injectTitlebar(Buffer.concat(chunks));
            const out = responseHeaders(upstreamResponse.headers);
            delete out.etag;
            out["content-length"] = String(body.length);
            response.writeHead(upstreamResponse.statusCode ?? 502, out);
            response.end(body);
          });
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (response.headersSent) return response.destroy();
      this.options.logger.debug("api", `IDE proxy error: ${error.message}`);
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2" });
      response.end("The IDE is not running yet. It starts automatically; reload in a moment.");
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  }

  /**
   * @param {import("node:http").IncomingMessage & { protocol?: string }} request
   * @param {import("node:net").Socket} socket
   * @param {Buffer} head
   * @param {{ remote: boolean, protocol: string }} context
   */
  ws(request, socket, head, context) {
    const entry = { socket, remote: context.remote };
    this.#sockets.add(entry);
    socket.once("close", () => this.#sockets.delete(entry));
    const upstream = http.request({
      host: "127.0.0.1",
      port: this.options.port(),
      method: request.method ?? "GET",
      path: request.url,
      headers: forwardHeaders(request.headers, {
        host: String(request.headers.host ?? "localhost"),
        protocol: context.protocol,
        keepUpgrade: true,
      }),
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
  }

  /** Disconnects WebSockets opened from other devices. */
  closeRemote() {
    for (const entry of this.#sockets) if (entry.remote) entry.socket.destroy();
  }

  closeAll() {
    for (const entry of this.#sockets) entry.socket.destroy();
  }
}
