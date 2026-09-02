import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checklistFor, navigationFor, renderDashboard } from "../apps/dashboard/src/shell.mjs";

const branding = { organizationName: "Example Club", subtitle: "Welcome", primaryColor: "#111111", secondaryColor: "#eeeeee", appearance: "dark" };

test("operator dashboard excludes protected administration", () => {
  const navigation = navigationFor("operator");
  assert.deepEqual(navigation, ["Dashboard", "Meetings", "Attendance", "Reports", "Roster", "Kiosks"]);
});

test("admin dashboard includes protected administration", () => {
  const navigation = navigationFor("admin");
  assert.equal(navigation.includes("Roster"), true);
  assert.deepEqual(navigation.slice(-2), ["Kiosks", "Settings"]);
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

test("live Admin workspace uses the authorized kiosk route and exits completed onboarding", async () => {
  const source = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  const pairing = await readFile("apps/dashboard/src/hardware-pairing-key.ts", "utf8");
  assert.match(source, /api<\{ kiosks: Kiosk\[\] \}>\("\/admin\/kiosks"\)/);
  assert.match(source, /Finish and return to dashboard/);
  assert.doesNotMatch(source, /api<\{ kiosks: Kiosk\[\] \}>\("\/kiosks"\)/);
  assert.match(pairing, /releases\/latest\/download\/install-lancerlogin\.sh/);
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

test("live branding stores an image locally and applies colors with a browser theme preference", async () => {
  const workspace = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  const settings = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  assert.match(workspace, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(workspace, /file\.size > 131_072/);
  assert.match(workspace, /stored in D1/);
  assert.match(entry, /brandTheme\(branding\.primaryColor, branding\.secondaryColor\)/);
  assert.match(entry, /data-theme=\{theme\}/);
  assert.match(entry, /lancerlogin-theme/);
  assert.match(workspace, /Logo contrast/);
  assert.match(settings, /id="organization-title">Organization/);
  assert.match(settings, /Save organization settings/);
  assert.match(settings, /Late scan allowance/);
  assert.match(settings, /individual meetings cannot override it/);
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
  assert.match(meetings, /\/meetings\/\$\{encodeURIComponent\(editing\.id\)\}/);
  assert.match(meetings, /method: "DELETE"/);
  assert.match(meetings, /Sync all to Discord/);
  assert.match(meetings, /addMinutes\(value\.date, startTime, 150\)/);
  assert.match(source, /Kiosk meeting ID/);
  assert.match(source, /Copy ID/);
  assert.match(meetings, /Notes <span>\(optional\)<\/span>/);
  assert.match(meetings, /Attendance required/);
  assert.match(meetings, /Create recurring series/);
  assert.doesNotMatch(meetings, /Test meeting/);
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
  const importer = await readFile("apps/dashboard/src/roster-import-panel.tsx", "utf8");
  const users = await readFile("apps/dashboard/src/user-settings.tsx", "utf8");
  for (const route of ["/dashboard", "/meetings", "/attendance", "/reports", "/roster", "/kiosks", "/settings/data", "/settings/updates"]) {
    assert.match(shell, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(users, /Dashboard access/);
  assert.match(importer, /id="roster-import-errors" className="inline-messages error" role="alert"/);
  assert.match(importer, /requestAnimationFrame/);
  assert.match(importer, /Preview roster/);
  assert.match(importer, /Replace the active roster/);
  assert.match(roster, /Add roster member/);
  assert.match(roster, /roster-summary-card/);
  assert.match(roster, /open=\{importOpen\}/);
  assert.match(users, /Roster link <span>\(optional\)<\/span>/);
  assert.match(users, /Non-rostered Admin or Operator/);
  assert.doesNotMatch(shell, /\["\/setup", "Setup"\]/);
  assert.match(shell, /setupStepIds\.every/);
});

test("home shows a five-week rolling calendar, live attendance, and contest review", async () => {
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  assert.match(home, /length: 35/);
  assert.match(home, /previousMonth/);
  assert.match(home, /previous-month/);
  assert.doesNotMatch(home, /Last week through the next three weeks/);
  assert.match(home, /Meetings in progress/);
  assert.match(home, /active\.length > 0.*live-pill/);
  assert.match(home, /Date\.parse\(meeting\.endsAt\) >= now/);
  assert.match(home, /Active · not checked out/);
  assert.match(home, /Attendance contests/);
  assert.match(home, /reviewNote/);
});

test("update assistant backs up before opening GitHub and cannot deploy automatically", async () => {
  const source = await readFile("apps/dashboard/src/updates-page.tsx", "utf8");
  const indicator = await readFile("apps/dashboard/src/update-indicator.tsx", "utf8");
  assert.match(source, /\/admin\/data\/backup\?scope=installation/);
  assert.match(source, /\/admin\/update-info/);
  assert.match(indicator, /formatVersion/);
  assert.match(source, /private GitHub deployment repository/);
  assert.match(source, /authorize Upgrade manually/);
  assert.match(source, /Update kiosk to latest stable/);
  assert.match(source, /command: "install_latest"/);
  assert.match(source, /Updates use Latest stable/);
  assert.doesNotMatch(source, /workflow_dispatch|api\.github\.com\/repos\/.*\/actions\/workflows/);
});

test("kiosk lifecycle is managed on the Kiosks page without reopening onboarding", async () => {
  const source = await readFile("apps/dashboard/src/kiosks-page.tsx", "utf8");
  assert.match(source, /\/admin\/pairing-codes/);
  assert.match(source, /Replace kiosk/);
  assert.match(source, /Retire kiosk/);
  assert.match(source, /Update to latest stable/);
  assert.match(source, /Device history/);
  assert.match(source, /Reload display/);
  assert.match(source, /Restart software/);
  assert.match(source, /Reboot Pi/);
  assert.match(source, /Reset network PIN/);
  assert.match(source, /\/admin\/kiosks\/\$\{encodeURIComponent\(active\.id\)\}\/commands/);
  assert.doesNotMatch(source, /openSetup/);
});

test("integration setup distinguishes saved credentials from verified connections", async () => {
  const source = await readFile("apps/dashboard/src/integration-settings.tsx", "utf8");
  assert.match(source, /Verification required/);
  assert.match(source, /result\.created \?/);
  assert.match(source, /credentials saved\. Complete verification below/);
  assert.match(source, /resend\/verify\/start/);
  assert.match(source, /resend\/verify\/complete/);
  assert.match(source, /discord\/verify\/start/);
  assert.match(source, /Verify with Google/);
  assert.match(source, /<details className="integration-card"/);
  assert.doesNotMatch(source, /Previous credentials were replaced|\/test"/);
});

test("dashboard styling uses self-hosted typography and themed organization controls", async () => {
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const organization = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  assert.match(entry, /@fontsource\/bebas-neue\/latin-400\.css/);
  assert.match(entry, /@fontsource\/roboto\/latin-700\.css/);
  assert.match(styles, /font-family: "Bebas Neue"/);
  assert.match(styles, /--bg: #111315/);
  assert.match(organization, /<ColorEditor label="Primary color"/);
  assert.match(organization, /logo-backdrop-options/);
});

test("roster dialogs trap keyboard focus and restore it when closed", async () => {
  const helper = await readFile("apps/dashboard/src/modal-focus.ts", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const importer = await readFile("apps/dashboard/src/roster-import-panel.tsx", "utf8");
  assert.match(helper, /event\.key !== "Tab"/);
  assert.match(helper, /previouslyFocused\?\.focus\(\)/);
  assert.match(roster, /useModalFocus\(dialog, open/);
  assert.match(importer, /useModalFocus\(dialog, modal && visible/);
});
