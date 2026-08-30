import test from "node:test";
import assert from "node:assert/strict";
import { validateProvisionPlan } from "../scripts/provision-plan.mjs";

test("provision plan requires a fresh adopter installation and explicit operation confirmation", () => {
  assert.deepEqual(validateProvisionPlan({ installationSlug: "example-club", operation: "create", confirmation: "CREATE example-club" }).plannedResources, ["example-club-api", "example-club-data", "example-club-dashboard"]);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", operation: "create", confirmation: "CREATE something-else" }), /Confirmation/);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", operation: "resume", confirmation: "RESUME example", existingDatabaseId: "anything" }), /Existing installation/);
});
