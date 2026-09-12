import test from "node:test";
import assert from "node:assert/strict";
import { validateProvisionPlan } from "../scripts/provision-plan.mjs";

test("provision plan requires a fresh adopter installation and explicit operation confirmation", () => {
  const plan = validateProvisionPlan({ installationSlug: "example-club", operation: "create", confirmation: "CREATE example-club" });
  assert.deepEqual(plan.plannedResources, ["example-club-api", "example-club-data", "example-club-dashboard"]);
  assert.deepEqual(plan.requiredSecretNames, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", operation: "create", confirmation: "CREATE something-else" }), /Confirmation/);
  assert.throws(() => validateProvisionPlan({ installationSlug: "example", operation: "resume", confirmation: "RESUME example", existingDatabaseId: "anything" }), /Existing installation/);
  assert.equal(validateProvisionPlan({ installationSlug: "example", operation: "upgrade", confirmation: "UPGRADE example" }).operation, "upgrade");
});
