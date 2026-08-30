import test from "node:test";
import assert from "node:assert/strict";
import { checklistFor, navigationFor, renderDashboard } from "../apps/dashboard/src/shell.mjs";

const branding = { organizationName: "Example Club", subtitle: "Welcome", primaryColor: "#111111", secondaryColor: "#eeeeee", appearance: "dark" };

test("operator dashboard excludes protected administration", () => {
  const navigation = navigationFor("operator");
  assert.deepEqual(navigation, ["Dashboard", "Meetings", "Attendance", "Reports", "Kiosk"]);
});

test("admin dashboard includes protected administration", () => {
  assert.deepEqual(navigationFor("admin").slice(-4), ["People", "Branding", "Integrations", "Security"]);
});

test("checklist is shared, resumable, and hides after completion", () => {
  const all = checklistFor(["branding"]);
  assert.equal(all.find((step) => step.id === "branding").complete, true);
  const html = renderDashboard({ role: "admin", branding, completedSteps: all.map((step) => step.id), checklistVisible: false });
  assert.match(html, /Setup and help/);
  assert.doesNotMatch(html, /<ol>/);
});

test("dashboard shell includes baseline accessibility and escapes branding", () => {
  const html = renderDashboard({ role: "operator", branding: { ...branding, organizationName: "A < B" } });
  assert.match(html, /lang="en"/);
  assert.match(html, /Skip to main content/);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /A &lt; B/);
  assert.doesNotMatch(html, /People/);
});
