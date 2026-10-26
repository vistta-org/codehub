import net from "node:net";
import os from "node:os";

/** @param {string | undefined} address */
export function isLoopback(address) {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/i, "");
  return normalized === "localhost" || normalized === "::1" || /^127\./.test(normalized);
}

/** Non-internal IPv4 addresses of this machine. */
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flatMap((interfaces) =>
    (interfaces ?? []).filter((entry) => !entry.internal && entry.family === "IPv4").map((entry) => entry.address),
  );
}

/** Names and addresses a host certificate must cover. */
export function certificateHosts() {
  return [...new Set(["localhost", os.hostname(), "127.0.0.1", "::1", ...lanAddresses()])];
}

/**
 * Whether `port` can be bound on `host`.
 * @param {number} port
 */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/**
 * The preferred port, or the next free one. There is an inherent race between
 * this check and the real bind; prefer explicit ports on busy hosts.
 * @param {number} preferred
 */
export async function findFreePort(preferred, host = "127.0.0.1", attempts = 50) {
  for (let port = preferred; port < preferred + attempts && port <= 65535; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free port found near ${preferred}`);
}
