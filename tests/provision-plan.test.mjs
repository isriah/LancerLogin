import test from "node:test";
import assert from "node:assert/strict";
import { validateProvisionPlan } from "../scripts/provision-plan.mjs";

test("provision plan accepts only a fresh dry-run adopter installation", () => {
  assert.deepEqual(validateProvisionPlan({ installationSlug: "example-club", dryRun: true }).plannedResources, ["example-club-api", "example-club-data", "example-club-dashboard"]);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", dryRun: false }), /mock-only/);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", dryRun: true, existingDatabaseId: "anything" }), /Existing installation/);
});
