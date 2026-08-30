import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("live Admin workspace uses the authorized kiosk route and hides a completed checklist", async () => {
  const source = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  assert.match(source, /api<\{ kiosks: Kiosk\[\] \}>\("\/admin\/kiosks"\)/);
  assert.match(source, /setShowChecklist\(setup\.completedSteps\.length < steps\.length\)/);
  assert.doesNotMatch(source, /api<\{ kiosks: Kiosk\[\] \}>\("\/kiosks"\)/);
  assert.match(source, /releases\/latest\/download\/install-lancerlogin\.sh/);
  assert.match(source, /Download guided Pi installer/);
});

test("first-Admin Google setup collects encrypted OAuth bootstrap credentials", async () => {
  const source = await readFile("apps/dashboard/src/main.tsx", "utf8");
  assert.match(source, /Google OAuth bootstrap/);
  assert.match(source, /googleClientId: usesGoogle/);
  assert.match(source, /googleClientSecret: usesGoogle/);
  assert.match(source, /\/api\/auth\/google\/callback/);
});

test("live branding stores an image locally and applies organization colors and appearance", async () => {
  const workspace = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  assert.match(workspace, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(workspace, /file\.size > 131_072/);
  assert.match(workspace, /stored in D1/);
  assert.match(entry, /"--primary": branding\.primaryColor/);
  assert.match(entry, /"--secondary": branding\.secondaryColor/);
  assert.match(entry, /data-theme=\{appearance\}/);
});

test("Operator workspace exposes kiosk monitoring and the complete Discord attendance workflow", async () => {
  const source = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  assert.match(source, /\/admin\/kiosks/);
  assert.match(source, /Status refreshes every 30 seconds/);
  assert.match(source, /\/discord\/link/);
  assert.match(source, /\/discord\/contests\?meetingId=/);
  assert.match(source, /\/discord\/contests\/resolve/);
  assert.match(source, /\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}/);
  assert.match(source, /Kiosk meeting ID/);
  assert.match(source, /Copy ID/);
  assert.match(source, /Meeting notes \(optional, up to 2,000 characters\)/);
  assert.match(source, /Require attendance\? Enter yes or no/);
});

test("destructive data controls require backup acknowledgement before typed confirmation", async () => {
  const source = await readFile("apps/dashboard/src/data-settings.tsx", "utf8");
  const backupPrompt = source.indexOf("Have you exported the data you need");
  const typedPrompt = source.indexOf("Type ${details[scope].confirmation} exactly");
  assert.ok(backupPrompt >= 0 && typedPrompt > backupPrompt);
  assert.match(source, /Exporting creates a copy and does not remove/);
});
