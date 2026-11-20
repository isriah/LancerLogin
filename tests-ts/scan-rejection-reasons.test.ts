import test from "node:test";
import assert from "node:assert/strict";
import { scanRejectionReasonText } from "../apps/dashboard/src/scan-rejection-reasons.ts";
import { permanentScanRejections, pinScanRefusals } from "../apps/kiosk/src/cloud-client.mjs";

// Kiosks > Debug tools > Rejected scans shows why a kiosk's scan was rejected. Every code a kiosk can upload needs
// plain wording there, never the raw code.

// The kiosk's own reasons: an unverified clock (attendance-clock.mjs) and a refusal with no usable code (file-queue.mjs).
const kioskLocalReasons = ["clock_unverified", "unclassified"];

test("every reason code a kiosk can upload with a rejected scan has plain wording", () => {
  const codes = [...permanentScanRejections, ...pinScanRefusals, ...kioskLocalReasons];
  assert.ok(codes.length >= 15);
  const seen = new Set<string>();
  for (const code of codes) {
    const text = scanRejectionReasonText(code);
    assert.ok(!text.includes(code), `${code} is shown as its raw code: ${text}`);
    assert.doesNotMatch(text, /_|^Other reason/, code);
    assert.match(text, /^[A-Z].*[a-z]$/, code);
    assert.ok(!seen.has(text), `${code} shares its wording with another code`);
    seen.add(text);
  }
  assert.equal(scanRejectionReasonText("pin_required"), "This kiosk requires a PIN, and the scan had none");
  assert.equal(scanRejectionReasonText("clock_unverified"), "The kiosk could not verify its clock, so the scan time is uncertain");
});

test("a reason code the dashboard does not know reads as words, with the code kept for support", () => {
  assert.equal(scanRejectionReasonText("outside_meeting_window"), "Other reason: outside meeting window (code outside_meeting_window)");
  assert.equal(scanRejectionReasonText(""), "No reason was recorded");
  assert.equal(scanRejectionReasonText(undefined), "No reason was recorded");
  // Names on Object.prototype are not codes.
  assert.equal(scanRejectionReasonText("constructor"), "Other reason: constructor (code constructor)");
});
