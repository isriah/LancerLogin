import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checklistFor, navigationFor, renderDashboard } from "../apps/dashboard/src/shell.mjs";

const branding = { organizationName: "Example Club", subtitle: "Welcome", primaryColor: "#111111", secondaryColor: "#eeeeee", appearance: "dark" };

test("operator dashboard excludes protected administration", () => {
  const navigation = navigationFor("operator");
  assert.deepEqual(navigation, ["Dashboard", "Meetings", "Attendance", "Reports", "Roster", "Kiosk"]);
});

test("admin dashboard includes protected administration", () => {
  const navigation = navigationFor("admin");
  assert.equal(navigation.includes("Roster"), true);
  assert.deepEqual(navigation.slice(-2), ["Setup", "Settings"]);
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
  assert.match(source, /setShowChecklist\(completedSet\.size < steps\.length\)/);
  assert.doesNotMatch(source, /api<\{ kiosks: Kiosk\[\] \}>\("\/kiosks"\)/);
  assert.match(source, /releases\/latest\/download\/install-lancerlogin\.sh/);
  assert.match(source, /Download guided Pi installer/);
  assert.match(source, /aria-label="Core setup steps"/);
  assert.match(source, /Browser simulator/);
  assert.match(source, /inline-messages error/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /Go to dashboard home/);
  assert.doesNotMatch(source, /<details className="admin-tools"/);
});

test("first-Admin Google setup collects encrypted OAuth bootstrap credentials", async () => {
  const source = await readFile("apps/dashboard/src/main.tsx", "utf8");
  assert.match(source, /Google OAuth guided setup/);
  assert.match(source, /googleClientId: usesGoogle/);
  assert.match(source, /googleClientSecret: usesGoogle/);
  assert.match(source, /\/api\/auth\/google\/callback/);
  assert.match(source, /console\.cloud\.google\.com\/auth\/clients\/create/);
  assert.match(source, /Confirm Admin password/);
  assert.match(source, /localPassword !== localPasswordConfirmation/);
  assert.match(source, /Allow anonymous usage reporting/);
});

test("live branding stores an image locally and applies organization colors and appearance", async () => {
  const workspace = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  const settings = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  assert.match(workspace, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(workspace, /file\.size > 131_072/);
  assert.match(workspace, /stored in D1/);
  assert.match(entry, /"--primary": branding\.primaryColor/);
  assert.match(entry, /"--secondary": branding\.secondaryColor/);
  assert.match(entry, /appearance === "themed"/);
  assert.match(entry, /data-theme=\{appearance\}/);
  assert.match(workspace, /value="themed">Organization colors/);
  assert.match(settings, /Organization and appearance/);
  assert.match(settings, /Save organization settings/);
});

test("Operator workspace exposes kiosk monitoring and the complete Discord attendance workflow", async () => {
  const source = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  assert.match(source, /\/admin\/kiosks/);
  assert.match(source, /Status refreshes every 30 seconds/);
  assert.match(source, /Reader \$\{activeKiosk\.readerOnline/);
  assert.match(source, /Release \$\{activeKiosk\.releaseVersion/);
  assert.match(source, /\/discord\/link/);
  assert.match(source, /\/discord\/contests\?meetingId=/);
  assert.match(source, /\/discord\/contests\/resolve/);
  assert.match(meetings, /\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}/);
  assert.match(source, /Kiosk meeting ID/);
  assert.match(source, /Copy ID/);
  assert.match(meetings, /Meeting notes \(optional, up to 2,000 characters\)/);
  assert.match(meetings, /Require attendance\? Enter yes or no/);
});

test("data controls expose separate backup, restore, and deletion per category", async () => {
  const source = await readFile("apps/dashboard/src/data-settings.tsx", "utf8");
  for (const scope of ["meetings", "roster", "installation"]) {
    assert.match(source, new RegExp(`${scope}: \\{ title:`));
  }
  assert.match(source, /\/admin\/data\/backup\?scope=\$\{scope\}/);
  assert.match(source, /\/admin\/data\/restore/);
  assert.match(source, /\/admin\/setup\/reset/);
  assert.match(source, /RESTORE \$\{scope\.toUpperCase\(\)\}/);
  assert.match(source, /Sensitive backup/);
  assert.match(source, /id=\{`data-error-\$\{scope\}`\} className="inline-messages error" role="alert"/);
});

test("dashboard uses distinct routes and keeps roster accounts together", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const users = await readFile("apps/dashboard/src/user-settings.tsx", "utf8");
  for (const route of ["/dashboard", "/meetings", "/attendance", "/reports", "/roster", "/settings/data", "/settings/updates"]) {
    assert.match(shell, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(roster, /Dashboard access/);
  assert.match(roster, /id="roster-import-errors" className="inline-messages error" role="alert"/);
  assert.match(roster, /requestAnimationFrame/);
  assert.match(users, /Roster link <span>\(optional\)<\/span>/);
  assert.match(users, /Non-rostered Admin or Operator/);
});

test("update assistant backs up before opening GitHub and cannot deploy automatically", async () => {
  const source = await readFile("apps/dashboard/src/updates-page.tsx", "utf8");
  assert.match(source, /\/admin\/data\/backup\?scope=installation/);
  assert.match(source, /github\.com\/isriah\/LancerLogin\/actions\/workflows\/provision-template\.yml/);
  assert.match(source, /run Upgrade manually/);
  assert.doesNotMatch(source, /workflow_dispatch|api\.github\.com\/repos\/.*\/actions\/workflows/);
});
