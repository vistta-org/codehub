/**
 * Pure helpers for the Android client: pairing input, host addresses and
 * fingerprints. No platform APIs here, so the logic is unit-tested in Node.
 */

export const DEFAULT_LAN_PORT = 8181;
const CODE = /^\d{6}$/;

/**
 * Normalizes what the user typed (`192.168.1.5`, `host:8181`, `https://…`)
 * into the hub's HTTPS origin; the shared hub port defaults to 8181. Mirrors
 * `remoteOrigin` in hub/remotes.js.
 * @param {unknown} address
 */
export function hostOrigin(address) {
  const text = String(address ?? "").trim();
  if (!text) throw new Error("Enter the computer's address");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That is not a valid address");
  }
  if (url.protocol !== "https:") throw new Error("Computers are reached over HTTPS");
  if (!url.port) url.port = String(DEFAULT_LAN_PORT);
  return url.origin;
}

/** @param {unknown} code */
export function pairingCode(code) {
  const value = String(code ?? "").trim();
  if (!CODE.test(value)) throw new Error("Enter the 6-digit pairing code shown on the computer");
  return value;
}

/** SHA-256 fingerprints compare without separators or case. @param {unknown} value */
export function normalizeFingerprint(value) {
  return String(value ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
}

/** @param {unknown} a @param {unknown} b */
export function sameFingerprint(a, b) {
  const left = normalizeFingerprint(a);
  return left.length === 64 && left === normalizeFingerprint(b);
}

/**
 * Reads a pairing QR (`https://…:8181/pair?code=…&fingerprint=…`) or the legacy JSON payload.
 * @param {string} text
 * @returns {{ origin: string, code: string, fingerprint: string | undefined }}
 */
export function parsePairingQr(text) {
  const value = String(text ?? "").trim();
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("This QR code is not a Vistta Code Hub pairing code");
    }
    if (url.protocol !== "https:" || url.pathname !== "/pair")
      throw new Error("This QR code is not a Vistta Code Hub pairing code");
    const query = url.searchParams;
    const fingerprint = query.get("fingerprint");
    if (fingerprint !== null && normalizeFingerprint(fingerprint).length !== 64)
      throw new Error("The QR code has an invalid fingerprint");
    data = { host: url.origin, code: query.get("code"), fingerprint };
  }
  if (!data || typeof data !== "object" || typeof data.host !== "string")
    throw new Error("This QR code is not a Vistta Code Hub pairing code");
  const fingerprint = typeof data.fingerprint === "string" && data.fingerprint ? data.fingerprint : undefined;
  if (fingerprint && normalizeFingerprint(fingerprint).length !== 64)
    throw new Error("The QR code has an invalid fingerprint");
  return { origin: hostOrigin(data.host), code: pairingCode(data.code), fingerprint };
}

/**
 * A readable device name from the WebView user agent (`Android 14; Pixel 7` → "Pixel 7").
 * @param {string} [userAgent]
 */
export function deviceName(userAgent = "") {
  const model = /Android [\d.]+;\s*(?:[a-z]{2}[-_][a-z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/i
    .exec(userAgent)?.[1]
    ?.trim();
  return model && model !== "K" ? model : "Android device";
}

const UNREACHABLE =
  /failed to connect|connection refused|econnrefused|timed? ?out|timeout|unreachable|no route to host|unable to resolve host|end of stream|closed by peer|terminated the handshake|connection reset|socket closed/i;
const UNTRUSTED = /trust anchor|certpath|certificate|sslhandshake|ssl handshake|peer not authenticated/i;

/**
 * Plain-language reason for a failed native request, or null when the
 * message is already meant for people (hub errors).
 * @param {unknown} message native error message
 * @param {string} origin
 */
export function connectionProblem(message, origin) {
  const text = String(message ?? "");
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    /* keep as given */
  }
  if (UNREACHABLE.test(text))
    return `Can't reach ${host}. On that computer turn on Share on LAN, and check that this phone is on the same network.`;
  if (UNTRUSTED.test(text))
    return `${host} presented a certificate this phone doesn't trust. If the computer was reinstalled, forget it and pair again.`;
  return null;
}

/**
 * Path the IDE should open after the ticket is redeemed; only same-origin paths.
 * @param {unknown} target
 */
export function idePath(target) {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : "/";
}
