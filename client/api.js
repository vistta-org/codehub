/**
 * Paired computers and the calls the Android client makes to their hubs.
 * Every request goes through `Pinned` (js-native): HTTPS that trusts only the
 * hub's own CA, pinned at pairing time. Device tokens stay in app storage.
 */
import { Context } from "@vistta/js";
import { chatPath, connectionProblem, deviceName, hostOrigin, idePath, pairingCode, sameFingerprint } from "./hosts.js";

/**
 * @typedef {{ id: string, name: string, origin: string, ca: string, fingerprint: string, token: string, pairedAt: string }} Computer
 */

export const computers = new Context("vch.computers", /** @type {{ list: Computer[] }} */ ({ list: [] }), {
  cache: "local",
  actions: {
    /** Adds or replaces (same origin) a paired computer. @param {Computer} computer */
    save: (state, computer) => ({ list: [...state.list.filter((entry) => entry.origin !== computer.origin), computer] }),
    /** @param {string} id */
    remove: (state, id) => ({ list: state.list.filter((entry) => entry.id !== id) }),
  },
});

async function pinned() {
  const { Pinned } = await import("@vistta/js-native/plugins");
  if (!Pinned.isSupported())
    throw new Error("This build has no pinned HTTPS bridge. Reinstall the Vistta Code Hub Android app.");
  return Pinned;
}

/**
 * Runs a native request; network and TLS failures become actionable messages
 * that keep the native one as `detail`.
 * @template T @param {string} origin @param {() => Promise<T>} task @returns {Promise<T>}
 */
async function native(origin, task) {
  try {
    return await task();
  } catch (error) {
    const detail = /** @type {Error} */ (error)?.message ?? String(error);
    const reason = connectionProblem(detail, origin);
    throw reason ? Object.assign(new Error(reason), { detail }) : error;
  }
}

/**
 * Calls a hub API route as this device.
 * @param {Computer} computer
 * @param {string} path
 * @param {{ method?: string, body?: any }} [options]
 */
async function call(computer, path, { method = "GET", body } = {}) {
  const Pinned = await pinned();
  const response = await native(computer.origin, () =>
    Pinned.request(new URL(path, computer.origin).toString(), {
      ca: computer.ca,
      method,
      headers: {
        authorization: `Bearer ${computer.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  let data = null;
  try {
    data = response.json();
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const error = /** @type {Error & { status?: number }} */ (
      new Error(data?.error?.message ?? `${computer.name} answered HTTP ${response.status}`)
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Pairs with a computer that is sharing on the LAN.
 * Without a fingerprint (manual entry) `confirm` must approve the one the
 * computer presented; the user compares it with the one shown there.
 * @param {{ address: unknown, code: unknown, fingerprint?: string, confirm?: (fingerprint: string) => Promise<boolean> }} input
 * @returns {Promise<Computer | null>} null when the user declines the fingerprint
 */
export async function pair({ address, code, fingerprint, confirm }) {
  const origin = hostOrigin(address);
  const pin = pairingCode(code);
  const Pinned = await pinned();
  const certificate = await native(origin, () => Pinned.fetchCertificate(origin));
  if (fingerprint) {
    if (!sameFingerprint(fingerprint, certificate.fingerprint))
      throw new Error("The computer's certificate does not match the QR code. Pairing stopped.");
  } else if (!(await confirm?.(certificate.fingerprint))) return null;

  const endpoint = fingerprint
    ? new URL(
        `/pair?code=${encodeURIComponent(pin)}&fingerprint=${encodeURIComponent(fingerprint)}&name=${encodeURIComponent(deviceName(navigator.userAgent))}`,
        origin,
      )
    : null;
  const response = await native(origin, () =>
    Pinned.request(endpoint?.toString() ?? new URL("/_vch/pair", origin).toString(), {
      ca: certificate.pem,
      method: endpoint ? "GET" : "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: endpoint ? undefined : JSON.stringify({ code: pin, name: deviceName(navigator.userAgent), platform: "android" }),
    }),
  );
  let granted = null;
  try {
    granted = response.json();
  } catch {
    /* not JSON */
  }
  if (!response.ok || !granted?.token)
    throw new Error(granted?.error?.message ?? `Pairing failed (HTTP ${response.status})`);

  /** @type {Computer} */
  const computer = {
    id: granted.device?.id ?? crypto.randomUUID(),
    name: new URL(origin).hostname,
    origin,
    ca: certificate.pem,
    fingerprint: certificate.fingerprint,
    token: granted.token,
    pairedAt: new Date().toISOString(),
  };
  try {
    const health = await call(computer, "/api/health");
    if (typeof health?.name === "string" && health.name) computer.name = health.name;
  } catch {
    /* keep the host name */
  }
  await computers.save(computer);
  return computer;
}

/**
 * IDE state, or why the computer cannot be used right now.
 * @param {Computer} computer
 * @returns {Promise<{ online: boolean, paired: boolean, ide?: string, error?: string }>}
 */
export async function status(computer) {
  try {
    const data = await call(computer, "/api/status");
    return { online: true, paired: true, ide: data?.ide?.state ?? "unknown" };
  } catch (error) {
    const status = /** @type {any} */ (error).status;
    if (status === 401)
      return { online: true, paired: false, error: "This phone is no longer paired with it. Forget it and pair again." };
    return { online: false, paired: true, error: /** @type {Error} */ (error).message };
  }
}

/** @param {Computer} computer @returns {Promise<{ name: string, path: string }[]>} */
export async function projects(computer) {
  const list = await call(computer, "/api/projects");
  return Array.isArray(list) ? list : [];
}

/**
 * Starts the IDE if needed and opens it in the pinned full-screen WebView,
 * signed in through a one-time ticket.
 * @param {Computer} computer
 * @param {string} [target] e.g. `/?folder=…`
 */
export async function openIde(computer, target = "/") {
  await call(computer, "/api/ide/start", { method: "POST" });
  const ticket = await call(computer, "/api/ide/ticket", { method: "POST", body: { target: idePath(target) } });
  const Pinned = await pinned();
  Pinned.openWeb(new URL(ticket.url, computer.origin).toString(), { ca: computer.ca, title: computer.name });
}

/** @param {Computer} computer @param {{ path: string }} project */
export async function openProject(computer, project) {
  const opened = await call(computer, "/api/projects/open", { method: "POST", body: { project: project.path } });
  await openIde(computer, opened?.url);
}

/**
 * Opens only the IDE's Chat, in a project or (without one) the last folder the IDE opened.
 * @param {Computer} computer @param {{ path: string }} [project]
 */
export async function openChat(computer, project) {
  const opened = project
    ? await call(computer, "/api/projects/open", { method: "POST", body: { project: project.path } })
    : undefined;
  await openIde(computer, chatPath(opened?.url ?? "/"));
}

/**
 * Unpairs: the computer revokes this device (best effort), then the token is deleted here.
 * @param {Computer} computer
 */
export async function forget(computer) {
  await call(computer, "/api/device", { method: "DELETE" }).catch(() => undefined);
  await computers.remove(computer.id);
}
