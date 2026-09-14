import { kioskStates as presentationStates, kioskState } from "./kiosk-presentation.mjs";

const leds = {
  ready: { color: 2, mode: 1, speed: 128, cycles: 0 }, processing: { color: 3, mode: 3, speed: 64, cycles: 0 }, welcome: { color: 2, mode: 2, speed: 48, cycles: 2 }, goodbye: { color: 2, mode: 2, speed: 48, cycles: 3 }, duplicate: { color: 3, mode: 2, speed: 56, cycles: 2 }, rejected: { color: 1, mode: 2, speed: 48, cycles: 3 }, unknown: { color: 1, mode: 2, speed: 48, cycles: 2 }, offline: { color: 1, mode: 2, speed: 64, cycles: 1 }, reader_offline: { color: 1, mode: 1, speed: 128, cycles: 0 }, enroll_wait_first: { color: 3, mode: 1, speed: 96, cycles: 0 }, enroll_scan_accepted: { color: 2, mode: 2, speed: 48, cycles: 2 }, enroll_wait_second: { color: 3, mode: 1, speed: 96, cycles: 0 }, enroll_success: { color: 2, mode: 2, speed: 48, cycles: 3 }, enroll_failure: { color: 1, mode: 2, speed: 48, cycles: 3 }, unpaired: undefined,
};

export { kioskState };
export const kioskStates = Object.freeze(Object.fromEntries(Object.entries(presentationStates).map(([id, state]) => [id, { ...state, led: leds[id] }])));
