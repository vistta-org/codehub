/**
 * Loopback API client for the bundled hub backend (`server.js` runs beside the
 * desktop app; see `app/lifecycle.js`). Plain `fetch` with an Origin the hub
 * CORS gate accepts; `x-vch-request: 1` proves host actions are first-party.
 */

/** Port of the loopback hub; the dev entry passes VCH_PORT for a custom boot. */
const PORT = Number((typeof process !== "undefined" && process?.env?.VCH_PORT) || globalThis.location?.port || 8181);
export const BASE = `http://127.0.0.1:${PORT}`;

/**
 * @typedef {{ ok: boolean, status: number, data: any }} ApiResult
 */

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, context?: "default" | "host" }} [options]
 * @returns {Promise<ApiResult>}
 */
export async function api(path, { method = "GET", body, context = "default" } = {}) {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(context === "host" ? { "x-vch-request": "1" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: { code: "offline", message: String(error?.message ?? error) } } };
  }
}
