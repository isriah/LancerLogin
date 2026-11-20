import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clearPinRequestCounts, countPinRequests, pinRequestCounts, pinRequestCountText, readPinRequestCounts, setKioskPinRequestCount, setPinRequestCounts } from "../apps/dashboard/src/pin-request-counts.ts";

// The shared counts of waiting PIN requests behind the top bar's count and the Kiosks list's row counts.

test("the counts in a module refresh are read strictly, and an answer without them is not an answer of zero", () => {
  assert.deepEqual(readPinRequestCounts({ total: 3, kiosks: [{ kioskId: "kiosk-a", count: 2 }, { kioskId: "kiosk-b", count: 1 }] }), { total: 3, kiosks: { "kiosk-a": 2, "kiosk-b": 1 } });
  // The total is the sum of the kiosks, whatever the answer claims, and a kiosk at zero is left out.
  assert.deepEqual(readPinRequestCounts({ total: 99, kiosks: [{ kioskId: "kiosk-a", count: 1 }, { kioskId: "kiosk-b", count: 0 }] }), { total: 1, kiosks: { "kiosk-a": 1 } });
  assert.deepEqual(readPinRequestCounts({ total: 0, kiosks: [] }), { total: 0, kiosks: {} });
  // A Worker from before the counts, or a malformed answer: nothing to apply.
  for (const value of [undefined, null, 3, "3", {}, { total: 1 }, { kiosks: {} }, { kiosks: [{ kioskId: "", count: 1 }] }, { kiosks: [{ kioskId: "kiosk-a", count: -1 }] }, { kiosks: [{ kioskId: "kiosk-a", count: 1.5 }] }, { kiosks: [{ kioskId: "kiosk-a", count: "2" }] }, { kiosks: [null] }, { kiosks: [{ kioskId: 7, count: 1 }] }]) {
    assert.equal(readPinRequestCounts(value), undefined, JSON.stringify(value));
  }
});

test("a list of waiting requests counts by kiosk", () => {
  assert.deepEqual(countPinRequests([]), { total: 0, kiosks: {} });
  assert.deepEqual(countPinRequests([{ kioskId: "kiosk-a" }, { kioskId: "kiosk-b" }, { kioskId: "kiosk-a" }]), { total: 3, kiosks: { "kiosk-a": 2, "kiosk-b": 1 } });
});

test("every reader sees one answer, told only when it changes, and a count that reaches 0 is gone", async () => {
  clearPinRequestCounts();
  // The hook subscribes through React; the store itself is plain, so its listeners are reached the same way here.
  const source = await readFile("apps/dashboard/src/pin-request-counts.ts", "utf8");
  assert.match(source, /useSyncExternalStore\(subscribe, pinRequestCounts\)/);
  assert.deepEqual(pinRequestCounts(), { total: 0, kiosks: {} });
  setPinRequestCounts(countPinRequests([{ kioskId: "kiosk-a" }, { kioskId: "kiosk-a" }, { kioskId: "kiosk-b" }]));
  const first = pinRequestCounts();
  assert.deepEqual(first, { total: 3, kiosks: { "kiosk-a": 2, "kiosk-b": 1 } });
  // The same counts again keep the same object, so nothing re-renders every 30 seconds.
  setPinRequestCounts(countPinRequests([{ kioskId: "kiosk-b" }, { kioskId: "kiosk-a" }, { kioskId: "kiosk-a" }]));
  assert.equal(pinRequestCounts(), first);
  // Manage kiosk reports what it just read for its own kiosk; the others keep theirs.
  setKioskPinRequestCount("kiosk-a", 1);
  assert.deepEqual(pinRequestCounts(), { total: 2, kiosks: { "kiosk-a": 1, "kiosk-b": 1 } });
  setKioskPinRequestCount("kiosk-a", 0);
  assert.deepEqual(pinRequestCounts(), { total: 1, kiosks: { "kiosk-b": 1 } });
  setKioskPinRequestCount("kiosk-c", 4);
  assert.deepEqual(pinRequestCounts(), { total: 5, kiosks: { "kiosk-b": 1, "kiosk-c": 4 } });
  setKioskPinRequestCount("kiosk-b", 0); setKioskPinRequestCount("kiosk-c", 0);
  assert.deepEqual(pinRequestCounts(), { total: 0, kiosks: {} });
  setPinRequestCounts(countPinRequests([{ kioskId: "kiosk-a" }]));
  clearPinRequestCounts();
  assert.equal(pinRequestCounts().total, 0);
});

test("the count reads as a singular or plural", () => {
  assert.equal(pinRequestCountText(1), "1 PIN request");
  assert.equal(pinRequestCountText(2), "2 PIN requests");
});

test("the shell learns the count from its module refresh and adds no request of its own", async () => {
  const read = (file: string) => readFile(`apps/dashboard/src/${file}`, "utf8");
  const [navigation, indicator, shell, kiosks, manage] = await Promise.all([read("module-navigation.ts"), read("pin-request-indicator.tsx"), read("app-shell.tsx"), read("kiosks-page.tsx"), read("kiosk-pin-requests.tsx")]);
  assert.match(navigation, /api<unknown>\("\/platform\/modules"\)/);
  assert.match(navigation, /setPinRequestCounts\(pinRequests\)/);
  assert.match(navigation, /if \(reason === "signed-out"\) clearPinRequestCounts\(\)/);
  // The indicator reads the requests only while its dialog is open; the Kiosks list reads none.
  assert.match(indicator, /if \(!open \|\| !enabled\) return;/);
  assert.equal([...indicator.matchAll(/api</g)].length, 1);
  assert.match(indicator, /visiblePoll\(/);
  assert.doesNotMatch(kiosks, /\/pin-requests/);
  // Operators and Admins with Attendance, beside the Reviews count.
  assert.match(shell, /<PinRequestIndicator enabled=\{attendanceReady && \(role === "admin" \|\| role === "operator"\)\} \/><ContestIndicator/);
  // Both places answer through the one hook and show the one list.
  for (const source of [indicator, manage]) { assert.match(source, /usePinRequestAnswers</); assert.match(source, /<PinRequestList /); }
  assert.match(manage, /api\(`\/admin\/pin-requests\//);
  assert.doesNotMatch(indicator, /\/admin\/pin-requests\//);
});
