import test from "node:test";
import assert from "node:assert/strict";
import { createSetupProgress } from "../apps/api/src/setup-progress.mjs";

test("setup completion is cross-admin and required steps control primary visibility", () => {
  const setup = createSetupProgress();
  for (const step of ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"]) setup.complete({ step, actorUserId: step === "branding" ? "admin-a" : "admin-b", completedAt: "2026-08-30T00:00:00Z" });
  const summary = setup.summary();
  assert.equal(summary.complete, true);
  assert.equal(summary.showPrimaryChecklist, false);
  assert.equal(summary.setupHelpAvailable, true);
  assert.equal(summary.requiredSteps[0].completion.actorUserId, "admin-a");
});

test("optional integrations never block setup completion", () => {
  const setup = createSetupProgress();
  setup.complete({ step: "discord", actorUserId: "admin-a", completedAt: "2026-08-30T00:00:00Z" });
  assert.equal(setup.summary().complete, false);
  assert.equal(setup.summary().optionalSteps.find((step) => step.step === "discord").completion.actorUserId, "admin-a");
});
