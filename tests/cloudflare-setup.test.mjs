import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareSetupSteps, previewProvision, renderCloudflareSetup, setupProgress } from "../apps/dashboard/src/cloudflare-setup.mjs";

test("Cloudflare setup is a clear four-step adopter flow", () => {
  assert.deepEqual(cloudflareSetupSteps.map((step) => step.id), ["cloudflare-account", "cloudflare-token", "github-secret", "provision"]);
  assert.equal(setupProgress({ "cloudflare-account": true })[0].complete, true);
  assert.equal(setupProgress({ "cloudflare-account": true })[1].complete, false);
});

test("preflight remains dry-run and rejects invalid installation slugs", () => {
  assert.deepEqual(previewProvision({ installationSlug: "arts-club" }).plannedResources, ["arts-club-api", "arts-club-data", "arts-club-dashboard"]);
  assert.equal(previewProvision({ installationSlug: "BAD" }).ok, false);
});

test("setup rendering never includes an API-token input and has accessible status", () => {
  const html = renderCloudflareSetup({ state: { "cloudflare-account": true }, installationSlug: "arts-club" });
  assert.match(html, /Connect Cloudflare/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /type="password"|name=".*token/i);
  assert.match(html, /rel="noreferrer"/);
});
