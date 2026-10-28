import { HttpError } from "./http-error.ts";

/** One message a module sends through the installation's shared email connection. Core supplies the From address. */
export type ModuleEmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly replyTo?: string;
  /** Stable per logical message, so a retry cannot send twice. Core prefixes it with the module ID. */
  readonly idempotencyKey: string;
};

const emailPattern = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const maximumBodyBytes = 200_000;

function address(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 254 || !emailPattern.test(value.trim())) throw new HttpError(400, `${label} must be one email address`);
  return value.trim();
}

/** Validate a module's message before any provider request, so a module cannot send malformed or oversized mail. */
export function moduleEmailMessage(value: unknown): ModuleEmailMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Email message must be an object");
  const input = value as Record<string, unknown>;
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) throw new HttpError(400, "Email subject must be one line of at most 200 characters");
  const body = (key: "html" | "text") => {
    const content = input[key];
    if (content === undefined) return undefined;
    if (typeof content !== "string" || !content.trim() || new TextEncoder().encode(content).byteLength > maximumBodyBytes) throw new HttpError(400, `Email ${key} must be non-empty and at most 200 KB`);
    return content;
  };
  const html = body("html"); const text = body("text");
  if (html === undefined && text === undefined) throw new HttpError(400, "Email needs an html or text body");
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw new HttpError(400, "Email idempotency key must be 1 to 160 letters, digits, dots, colons, underscores or hyphens");
  return Object.freeze({
    to: address(input.to, "Email recipient"), subject, idempotencyKey: key,
    ...html === undefined ? {} : { html }, ...text === undefined ? {} : { text },
    ...input.replyTo === undefined ? {} : { replyTo: address(input.replyTo, "Email reply-to") },
  });
}

/** Resend's request body for a validated module message. */
export function resendModuleEmailPayload(from: string, message: ModuleEmailMessage) {
  return {
    from, to: [message.to], subject: message.subject,
    ...message.html === undefined ? {} : { html: message.html }, ...message.text === undefined ? {} : { text: message.text },
    ...message.replyTo === undefined ? {} : { reply_to: message.replyTo },
  };
}

/** The idempotency key Core sends, namespaced so two modules can never collide. */
export function moduleEmailIdempotencyKey(moduleId: string, key: string): string { return `module-${moduleId}-${key}`; }
