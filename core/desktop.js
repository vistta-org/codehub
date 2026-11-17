import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

/** Request/reply over the bundled hub's existing stdout/stdin pipe. */
export class DesktopBridge {
  /** @type {Map<string, { resolve: (value: boolean) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  pending = new Map();
  closed = false;

  constructor(input, send, timeoutMs = 15_000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.lines = createInterface({ input });
    this.lines.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        console.error("[desktop] Invalid reply:", error.message);
        return;
      }
      if (response?.vch !== "desktop-response") {
        console.error("[desktop] Unexpected reply");
        return;
      }
      const request = this.pending.get(response.id);
      if (!request) {
        console.error("[desktop] Reply has no pending request:", response.id);
        return;
      }
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      if (typeof response.error === "string") request.reject(new Error(response.error));
      else if (typeof response.value === "boolean") request.resolve(response.value);
      else request.reject(new Error("Desktop returned an invalid startup state"));
    });
    this.lines.on("close", () => this.fail(new Error("Desktop connection closed")));
    this.lines.on("error", (error) => this.fail(error));
  }

  /**
   * @param {boolean} [enabled]
   * @returns {Promise<boolean>}
   */
  startup(enabled) {
    if (this.closed) return Promise.reject(new Error("Desktop connection is closed"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Desktop login startup request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ vch: "desktop-request", id, action: "startup", body: { enabled } });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  fail(error) {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.lines.close();
  }
}
