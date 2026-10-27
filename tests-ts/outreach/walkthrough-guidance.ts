import test from "node:test";
import assert from "node:assert/strict";
import { pageWalkthroughForPath } from "../../apps/dashboard/src/page-walkthrough-definitions.ts";
import { outreachWalkthrough } from "@lancerlogin-test/outreach/src/dashboard/outreach-walkthrough.ts";

test("walkthrough guidance distinguishes public IDs, filtered acceptance and optional fingerprint storage", () => {
  assert.equal(pageWalkthroughForPath("/hours", "admin"), undefined, "Outreach guidance is contributed only while Outreach is ready");
  const outreach = pageWalkthroughForPath("/hours", "admin", [{ path: "/hours", definition: outreachWalkthrough }])!;
  const submission = outreach.steps.find((step) => step.id === "member-submissions")!;
  assert.match(submission.description, /public ID entry is not a login/);
  assert.match(submission.description, /Admins choose whether/);
  const contests = pageWalkthroughForPath("/meetings/synthetic-meeting", "admin")!.steps.find((step) => step.id === "contests")!;
  assert.match(contests.description, /current filtered list/);
  assert.match(contests.description, /Each decision keeps its own audit history/);
  const fingerprint = pageWalkthroughForPath("/kiosks", "admin")!.steps.find((step) => step.id === "fingerprints")!;
  assert.match(fingerprint.description, /optional encrypted cloud storage/);
  assert.match(fingerprint.description, /even when the other kiosks are offline/);
});
