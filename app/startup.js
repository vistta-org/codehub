/** Only the hidden controller can reach native startup commands. */
/** @param {{ enabled?: boolean }} [body] */
export async function desktopStartup(System, body = {}) {
  if (window.platform !== "desktop" || !/Windows|Linux/.test(navigator.userAgent))
    throw new Error("Login startup is only supported on Windows/Linux desktop");
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("enabled must be true or false");
    if (body.enabled) await System.enableAutostart();
    else await System.disableAutostart();
  }
  const enabled = await System.isAutostartEnabled();
  if (body.enabled !== undefined && enabled !== body.enabled)
    throw new Error("The operating system did not apply the login startup setting");
  return enabled;
}
