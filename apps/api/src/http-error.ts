export class HttpError extends Error {
  readonly status: number;
  readonly details?: string[];
  /** Optional stable machine-readable reason, for clients that must not parse messages. */
  readonly code?: string;

  constructor(status: number, message: string, details?: string[], code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    if (code !== undefined) this.code = code;
  }
}
