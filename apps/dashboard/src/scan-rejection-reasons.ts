// Plain wording for the reason code a kiosk uploads with a rejected scan (Kiosks > Debug tools > Rejected scans).
// The codes come from the Worker's scan refusals that a kiosk settles as a rejection (`permanentScanRejections` and
// `pinScanRefusals` in apps/kiosk/src/cloud-client.mjs) and from the kiosk's own checks (`clock_unverified` in
// attendance-clock.mjs, `unclassified` in file-queue.mjs and the web kiosk's kiosk-sync.ts).

const reasonText: Record<string, string> = {
  roster_inactive: "The member is not on the active roster",
  no_eligible_meeting: "No meeting was accepting scans at that time",
  scan_window_closed: "The meeting was not accepting scans at that time",
  attendance_complete: "The member's attendance for the meeting was already complete",
  participation_not_started: "The meeting was before the member's attendance start date",
  pairing_mismatch: "The scan was made under an earlier pairing of this kiosk",
  invalid_scan: "The scan was missing its ID, member or time",
  clock_unverified: "The kiosk could not verify its clock, so the scan time is uncertain",
  pin_required: "This kiosk requires a PIN, and the scan had none",
  invalid_pin: "The PIN sent with the scan was not 4 to 6 digits",
  pin_not_set: "This kiosk requires a PIN, and the member has none yet",
  pin_locked: "The member's PIN was locked after too many wrong tries",
  pin_incorrect: "The PIN sent with the scan was wrong",
  pin_throttled: "Too many wrong PIN tries, so the scan was refused",
  unclassified: "The scan was refused without a stated reason",
};

/** The reason in plain words. A code this dashboard does not know is shown as readable words with the code beside it. */
export function scanRejectionReasonText(code: string | null | undefined): string {
  const value = typeof code === "string" ? code.trim() : "";
  if (!value) return "No reason was recorded";
  if (Object.hasOwn(reasonText, value)) return reasonText[value]!;
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? `Other reason: ${words} (code ${value})` : `Other reason (code ${value})`;
}
