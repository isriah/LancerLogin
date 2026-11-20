// This is the presentation contract shared by the physical kiosk and browser emulator.
// Input adapters choose transitions; renderers only consume this display-safe state.
export const kioskStates = Object.freeze({
  ready: { message: "Place finger on reader", detail: "Attendance kiosk ready", tone: "ready" },
  clock_required: { message: "Confirm date and time", detail: "Open maintenance and enter the local PIN to confirm the clock", tone: "notice" },
  processing: { message: "Checking scan", detail: "Hold still", tone: "processing" },
  welcome: { message: "Welcome", detail: "Arrival recorded", tone: "success", durationMs: 2400 },
  goodbye: { message: "Goodbye", detail: "Departure recorded", tone: "success", durationMs: 2600 },
  duplicate: { message: "Already recorded", detail: "Attendance was not changed", tone: "notice", durationMs: 2200 },
  rejected: { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800 },
  unknown: { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600 },
  // The scan itself was fine, but there is nothing to record: no meeting is open for it, or the member's attendance for
  // the meeting is settled. kioskDisplayForRefusal fills in which; it stays up longer so the reason can be read.
  scan_notice: { message: "No meeting today", detail: "Nothing to scan in for right now", tone: "notice", durationMs: 5000 },
  // A possible wrong match: the member scanned on another kiosk moments apart, so nothing was recorded.
  rescan: { message: "Scan again", detail: "Place your finger flat on the reader and hold it still.", tone: "notice", durationMs: 2600 },
  offline: { message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically", tone: "offline", durationMs: 2600 },
  reader_offline: { message: "Reader offline", detail: "The fingerprint reader is not responding", tone: "error" },
  enroll_wait_first: { message: "Place finger", detail: "Enrollment scan 1 of 2", tone: "processing" },
  enroll_scan_accepted: { message: "Lift your finger", detail: "First scan captured. Lift before the second scan.", tone: "success" },
  enroll_wait_second: { message: "Place same finger", detail: "Enrollment scan 2 of 2", tone: "processing" },
  enroll_success: { message: "Enrollment saved", detail: "Fingerprint slot mapped", tone: "success", durationMs: 2600 },
  finger_removal: { message: "Lift your finger", detail: "Lift, then place your finger again to record attendance", tone: "notice" },
  operator_paused: { message: "Attendance paused", detail: "Return from operator settings to resume attendance", tone: "notice" },
  enroll_failure: { message: "Enrollment failed", detail: "Try again", tone: "error", durationMs: 2800 },
  unpaired: { message: "Setup required", detail: "Pair this kiosk from the LancerLogin dashboard", tone: "notice" },
});

export function kioskState(id, overrides = {}) {
  const state = kioskStates[id] ?? kioskStates.rejected;
  return { id, message: state.message, detail: state.detail, tone: state.tone, durationMs: state.durationMs, ...overrides, updatedAt: new Date().toISOString() };
}

export function kioskDisplayForAttendance(result) {
  if (result?.duplicate) return kioskState("duplicate");
  return kioskState(result?.action === "check_out" ? "goodbye" : "welcome");
}

const refusalText = (value, limit) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;

/**
 * The Worker's reason for refusing a scan that has nothing wrong with it, read from its refusal body: `reason` with the
 * meeting title, the time ("5:45 PM", already in the installation's time zone) or the date ("Dec 1, 2026") the wording
 * needs. Undefined for a Worker that sends no reason, a reason this kiosk does not know, or one missing its details.
 */
export function scanRefusalFrom(body) {
  if (!body || typeof body !== "object") return undefined;
  const meetingTitle = refusalText(body.meetingTitle, 120), time = refusalText(body.time, 20), date = refusalText(body.date, 40);
  switch (body.reason) {
    case "too_early": case "meeting_ended": return meetingTitle && time ? { reason: body.reason, meetingTitle, time } : undefined;
    case "no_meeting_today": case "already_done": return { reason: body.reason };
    case "not_started_yet": return date ? { reason: body.reason, date } : undefined;
    default: return undefined;
  }
}

/** The notice screen for a refusal scanRefusalFrom understood, or undefined: the caller then shows its generic screen. */
export function kioskDisplayForRefusal(refusal) {
  switch (refusal?.reason) {
    case "too_early": return kioskState("scan_notice", { message: "Too early", detail: `${refusal.meetingTitle} opens for scans at ${refusal.time}` });
    case "meeting_ended": return kioskState("scan_notice", { message: "Meeting ended", detail: `Scans for ${refusal.meetingTitle} closed at ${refusal.time}` });
    case "no_meeting_today": return kioskState("scan_notice", { message: "No meeting today", detail: "Nothing to scan in for right now" });
    case "already_done": return kioskState("scan_notice", { message: "Already done", detail: "You've already checked in and out of this meeting" });
    case "not_started_yet": return kioskState("scan_notice", { message: "Not started yet", detail: `Your attendance begins on ${refusal.date}` });
    default: return undefined;
  }
}

// Pending events are the only local direction history. Replay/removal resets that
// history conservatively; the estimate never becomes part of an attendance event.
export function kioskDisplayForQueuedScan(memberId, pending) {
  const count = pending.filter((event) => event.memberId === memberId).length;
  const headline = count % 2 === 0 ? "Welcome" : "Goodbye";
  return kioskState(headline === "Welcome" ? "welcome" : "goodbye", { detail: `Saved for sync | ${headline}` });
}
