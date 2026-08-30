import test from "node:test";
import assert from "node:assert/strict";
import { createTelemetry } from "../apps/api/src/telemetry.mjs";

test("telemetry cannot send before explicit consent", async () => {
  const telemetry = createTelemetry();
  assert.deepEqual(await telemetry.report({ installId: "random", releaseVersion: "1.0" }), { sent: false, reason: "consent-required" });
});

test("telemetry payload strictly removes sensitive inputs", async () => {
  const sent = []; const telemetry = createTelemetry({ accepted: true, send: async (payload) => sent.push(payload) });
  const result = await telemetry.report({ installId: "random", releaseVersion: "1.0", activeKioskCount: 1, errorCategory: "network", metro: "Example Metro", roster: ["Ada"], attendance: "present", rawIp: "192.0.2.1", fingerprint: "no" });
  assert.equal(result.sent, true);
  assert.deepEqual(sent[0], { installId: "random", releaseVersion: "1.0", activeKioskCount: 1, errorCategory: "network", metro: "Example Metro" });
});
