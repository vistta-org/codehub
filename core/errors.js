/** Errors thrown by Code Hub, carrying an HTTP status for the API layer. */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   * @param {string} [code]
   */
  constructor(message, status = 500, code = "internal_error") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
