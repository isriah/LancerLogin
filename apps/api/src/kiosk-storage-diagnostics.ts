// Local state a Raspberry Pi kiosk had to repair (from 2.1.0-beta.11), sent in its heartbeat as `storage` and kept as one
// JSON object in kiosks.storage_diagnostics. Unlike the attention details, the object is read leniently: an unknown key or
// an invalid part is dropped and never refuses the heartbeat, so a later kiosk can add details this Worker ignores.
//
// - networkPin: the kiosk's network settings PIN file could not be read. "restored" from its backup copy (until the
//   kiosk restarts or the PIN is reset), or "unreadable" (both copies; the PIN can only be reset from the dashboard).
// - setAside: per queue, unreadable journal entries the kiosk copied to the queue's `.journal.damaged` file, and when
//   the newest was found. Present while that file exists.
export type KioskSetAside = { count: number; lastAt: string | null };
export type KioskStorageDiagnostics = {
  networkPin?: { state: "restored" | "unreadable"; at: string };
  setAside?: { attendance?: KioskSetAside; enrollmentReports?: KioskSetAside };
};

const setAsideQueues = ["attendance", "enrollmentReports"] as const;

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

export function kioskStorageDiagnostics(value: unknown): KioskStorageDiagnostics | undefined {
  const input = record(value); if (!input) return undefined;
  const result: KioskStorageDiagnostics = {};
  const pin = record(input.networkPin);
  if (pin && (pin.state === "restored" || pin.state === "unreadable") && timestamp(pin.at)) result.networkPin = { state: pin.state, at: pin.at };
  const setAside = record(input.setAside), queues: NonNullable<KioskStorageDiagnostics["setAside"]> = {};
  for (const queue of setAsideQueues) {
    const entry = record(setAside?.[queue]);
    if (entry && Number.isInteger(entry.count) && Number(entry.count) > 0 && Number(entry.count) <= 100_000 && (entry.lastAt === null || timestamp(entry.lastAt))) queues[queue] = { count: Number(entry.count), lastAt: entry.lastAt as string | null };
  }
  if (Object.keys(queues).length) result.setAside = queues;
  return Object.keys(result).length ? result : undefined;
}

/** The column value for a heartbeat: NULL when the kiosk reports nothing to show, including kiosks that send no details. */
export function storageDiagnosticsColumn(value: unknown): string | null {
  const diagnostics = kioskStorageDiagnostics(value);
  return diagnostics ? JSON.stringify(diagnostics) : null;
}

/** The stored column for the dashboard, revalidated so a damaged value shows nothing. */
export function storedStorageDiagnostics(value: unknown): KioskStorageDiagnostics | null {
  if (typeof value !== "string") return null;
  try { return kioskStorageDiagnostics(JSON.parse(value)) ?? null; } catch { return null; }
}
