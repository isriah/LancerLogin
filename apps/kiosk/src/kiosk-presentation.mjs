// This is the presentation contract shared by the physical kiosk and browser emulator.
// Input adapters choose transitions; renderers only consume this display-safe state.
export const kioskStates = Object.freeze({
  ready: { message: "Place finger on reader", detail: "Attendance kiosk ready", tone: "ready" },
  processing: { message: "Checking scan", detail: "Hold still", tone: "processing" },
  welcome: { message: "Welcome", detail: "Arrival recorded", tone: "success", durationMs: 2400 },
  goodbye: { message: "Goodbye", detail: "Departure recorded", tone: "success", durationMs: 2600 },
  duplicate: { message: "Already recorded", detail: "Attendance was not changed", tone: "notice", durationMs: 2200 },
  rejected: { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800 },
  unknown: { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600 },
  offline: { message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically", tone: "offline", durationMs: 2600 },
  reader_offline: { message: "Reader offline", detail: "The fingerprint reader is not responding", tone: "error" },
  enroll_wait_first: { message: "Place finger", detail: "Enrollment scan 1 of 2", tone: "processing" },
  enroll_scan_accepted: { message: "Scan captured", detail: "Remove finger", tone: "success" },
  enroll_wait_second: { message: "Place same finger", detail: "Enrollment scan 2 of 2", tone: "processing" },
  enroll_success: { message: "Enrollment saved", detail: "Fingerprint slot mapped", tone: "success", durationMs: 2600 },
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
