export const kioskStates = Object.freeze({
  ready: { message: "Place finger on reader", detail: "Attendance kiosk ready", tone: "ready", led: { color: 2, mode: 1, speed: 128, cycles: 0 } },
  processing: { message: "Checking scan", detail: "Hold still", tone: "processing", led: { color: 3, mode: 3, speed: 64, cycles: 0 } },
  welcome: { message: "Welcome", detail: "Arrival recorded", tone: "success", durationMs: 2400, led: { color: 2, mode: 2, speed: 48, cycles: 2 } },
  goodbye: { message: "Goodbye", detail: "Departure recorded", tone: "success", durationMs: 2600, led: { color: 2, mode: 2, speed: 48, cycles: 3 } },
  duplicate: { message: "Already recorded", detail: "Attendance was not changed", tone: "notice", durationMs: 2200, led: { color: 3, mode: 2, speed: 56, cycles: 2 } },
  rejected: { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800, led: { color: 1, mode: 2, speed: 48, cycles: 3 } },
  unknown: { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600, led: { color: 1, mode: 2, speed: 48, cycles: 2 } },
  offline: { message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically", tone: "offline", durationMs: 2600, led: { color: 1, mode: 2, speed: 64, cycles: 1 } },
  reader_offline: { message: "Reader offline", detail: "The fingerprint reader is not responding", tone: "error", led: { color: 1, mode: 1, speed: 128, cycles: 0 } },
  unpaired: { message: "Setup required", detail: "Pair this kiosk from the LancerLogin dashboard", tone: "notice" },
});

export function kioskState(id, overrides = {}) {
  const state = kioskStates[id] ?? kioskStates.rejected;
  return { id, message: state.message, detail: state.detail, tone: state.tone, durationMs: state.durationMs, ...overrides, updatedAt: new Date().toISOString() };
}
