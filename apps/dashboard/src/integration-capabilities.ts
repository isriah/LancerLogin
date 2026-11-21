// The app shell's one shared read of /integrations/capabilities, which gates Discord features such as the Reviews
// indicator. A failed read is not an answer: it keeps the last capabilities that were read, or nothing yet, and reads
// again (retrying-read.ts) while the shell is open. Treating a failure as "every integration is off" hid Reviews
// whenever one request failed.
//
// This file has no React import, so tests-ts can load it; app-shell.tsx wires it to the shell's state.
import { createRetryingRead, type RetryingReadOptions } from "./retrying-read.ts";

export type IntegrationCapability = { enabled: boolean; configured: boolean };
export type IntegrationCapabilities = Record<"google" | "resend" | "discord", IntegrationCapability> & { google_calendar?: IntegrationCapability };

/** What the shell shows before the first successful read: no integration, so no integration feature appears early. */
export const disabledCapabilities: IntegrationCapabilities = { google: { enabled: false, configured: false }, resend: { enabled: false, configured: false }, discord: { enabled: false, configured: false } };

/** The shell's capabilities reader; a failed read resolves to the last known capabilities, or `disabledCapabilities`. */
export const createCapabilitiesReader = (options: Omit<RetryingReadOptions<IntegrationCapabilities>, "empty">) => createRetryingRead({ ...options, empty: disabledCapabilities });
