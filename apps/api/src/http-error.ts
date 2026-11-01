export class HttpError extends Error {
  readonly status: number;
  readonly details?: string[];
  /** Optional stable machine-readable reason, for clients that must not parse messages. */
  readonly code?: string;
  /** Optional extra fields for the JSON error body, such as the id a client can act on. */
  readonly extra?: Record<string, string | number | boolean | null>;

  constructor(status: number, message: string, details?: string[], code?: string, extra?: Record<string, string | number | boolean | null>) {
    super(message);
    this.status = status;
    this.details = details;
    if (code !== undefined) this.code = code;
    if (extra !== undefined) this.extra = extra;
  }
}
