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

test("browser emulator uses the shared kiosk display contract and labels its input boundary", async () => {
  const simulator = await readFile("apps/dashboard/src/simulator-page.tsx", "utf8");
  const contract = await readFile("apps/kiosk/src/kiosk-presentation.mjs", "utf8");
  assert.match(simulator, /kioskDisplayForAttendance/);
  assert.match(simulator, /BrowserMemberInput/);
  assert.match(simulator, /SIMULATED · BROWSER INPUT/);
  assert.match(simulator, /Not a physical kiosk/);
  assert.match(contract, /kioskDisplayForAttendance/);
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

test("guided setup keeps branding local and makes its compact progress accessible", async () => {
  const workspace = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  const settings = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  const configuration = await readFile("apps/dashboard/src/configuration-settings.tsx", "utf8");
  assert.match(workspace, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(workspace, /file\.size > 131_072/);
  assert.doesNotMatch(workspace, /stored in D1/);
  assert.doesNotMatch(workspace, /Light or dark mode is a personal browser preference/);
  assert.match(workspace, /className="setup-progress" role="progressbar"/);
  assert.match(workspace, /aria-label="Guided setup progress"/);
  assert.match(styles, /\.setup-logo-file input\[type="file"\]::file-selector-button/);
  assert.match(styles, /\.wizard-panel \.logo-backdrop-options \+ \.color-grid/);
  assert.match(styles, /\.wizard-panel \.setup-branding-save \{ margin-top: \.45rem/);
  assert.match(entry, /brandTheme\(branding\.primaryColor, branding\.secondaryColor\)/);
  assert.match(entry, /data-theme=\{theme\}/);
  assert.match(entry, /lancerlogin-theme/);
  assert.match(workspace, /Logo contrast/);
  assert.match(settings, /id="organization-title">Organization/);
  assert.match(settings, /Save organization settings/);
  assert.match(configuration, /Late scan allowance/);
  assert.doesNotMatch(configuration, /Changes apply to every meeting/);
});

test("Operator workspace exposes kiosk monitoring without an Attendance contest-audit panel", async () => {
  const source = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(source, /\/admin\/kiosks/);
  assert.match(source, /Status refreshes every 30 seconds/);
  assert.match(source, /Reader \$\{activeKiosk\.readerOnline/);
  assert.match(source, /Release \$\{activeKiosk\.releaseVersion/);
  assert.doesNotMatch(source, /\/discord\/link|Email missed|Email report/);
  assert.doesNotMatch(source, /\/discord\/contests/);
  assert.doesNotMatch(source, /Missing-member contests/);
  assert.match(meetings, /\/meetings\/\$\{encodeURIComponent\(editing\.id\)\}/);
  assert.match(meetings, /method: "DELETE"/);
  assert.match(meetings, /\/restore/);
  assert.match(meetings, /Delete this and future meetings/);
  assert.match(meetings, /<th>Date<\/th><th>Start<\/th><th>End<\/th>/);
  assert.match(meetings, /Sync all to Discord/);
  assert.match(meetings, /calendarOutcomes/);
  assert.match(meetings, /addMinutes\(value\.date, startTime, 150\)/);
  assert.doesNotMatch(source, /Kiosk meeting ID/);
  assert.doesNotMatch(source, /Copy ID/);
  assert.match(meetings, /Notes <span>\(optional\)<\/span>/);
  assert.match(meetings, /Attendance required/);
  assert.doesNotMatch(meetings, /Optional meeting/);
  assert.match(meetings, /Search Meetings/);
  assert.match(styles, /\.meeting-create-form input\[type="checkbox"\]/);
  assert.match(styles, /\.meeting-directory input\[type="checkbox"\]:checked/);
  assert.match(meetings, /Create recurring series/);
  assert.match(meetings, /Duplicate an existing meeting/);
  assert.doesNotMatch(meetings, /template/i);
  assert.doesNotMatch(meetings, /Test meeting/);
});

test("data controls expose separate backup, restore, and deletion per category", async () => {
  const source = await readFile("apps/dashboard/src/data-settings.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  for (const scope of ["meetings", "roster", "installation"]) {
    assert.match(source, new RegExp(`${scope}: \\{ title:`));
  }
  assert.match(source, /\/admin\/data\/backup\?scope=\$\{scope\}/);
  assert.match(source, /\/admin\/data\/restore/);
  assert.match(source, /RESTORE \$\{scope\.toUpperCase\(\)\}/);
  assert.match(source, /Sensitive backup/);
  assert.match(source, /Restore file/);
  assert.match(source, /data-action-dialog/);
  assert.match(source, /useModalFocus/);
  assert.doesNotMatch(source, /\/admin\/setup\/reset|Restart onboarding|window\.confirm|window\.prompt/);
  assert.match(styles, /\.data-category \{[^}]*align-items: center/);
  assert.match(styles, /\.data-actions \{ display: flex/);
  assert.match(styles, /\.file-picker input\[type="file"\]::file-selector-button/);
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
  assert.match(roster, /Import CSV instead/);
  assert.match(roster, /RosterImportPanel members=\{members\}/);
  assert.doesNotMatch(roster, /importOpen/);
  assert.match(users, /Roster link <span>\(optional\)<\/span>/);
  assert.match(users, /Non-rostered Admin or Operator/);
  assert.doesNotMatch(shell, /\["\/setup", "Setup"\]/);
  assert.match(shell, /setupStepIds\.every/);
});

test("Settings separates operational configuration, access, and kiosk update comparisons", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const organization = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  const configuration = await readFile("apps/dashboard/src/configuration-settings.tsx", "utf8");
  const updates = await readFile("apps/dashboard/src/updates-page.tsx", "utf8");
  assert.match(shell, /\["\/settings\/configuration", "Configuration"\]/);
  assert.match(shell, /\["\/settings\/access", "Access"\]/);
  assert.match(shell, /\["\/settings\/updates", "Updates"\]/);
  assert.match(shell, /role === "admin" && path === "\/settings\/access"/);
  assert.match(configuration, /Late scan allowance \(minutes\)/);
  assert.match(configuration, /Discord contest window \(hours\)/);
  assert.doesNotMatch(organization, /Late scan allowance|Discord contest window/);
  assert.match(updates, /<h2>Physical kiosk<\/h2>/);
  assert.match(updates, /<span>Installed<\/span>/);
  assert.match(updates, /<span>Latest compatible<\/span>/);
  assert.match(updates, /className="version-grid"/);
});

test("settings subpages preserve the parent navigation bubble without duplicating the current-page label", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const router = await readFile("apps/dashboard/src/router.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const organization = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  const configuration = await readFile("apps/dashboard/src/configuration-settings.tsx", "utf8");
  const integrations = await readFile("apps/dashboard/src/integration-settings.tsx", "utf8");
  assert.ok(shell.includes('const viewingSettings = path.startsWith("/settings/")'));
  assert.ok(shell.includes('label === "Settings" && viewingSettings && path !== href ? "active" : ""'));
  assert.ok(shell.includes('path === "/settings/configuration"'));
  assert.match(router, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(styles, /\.primary-navigation a\.active,\.settings-navigation a\.active/);
  assert.match(styles, /\.settings-navigation \{ width: 100%; display: grid/);
  for (const source of [organization, configuration, integrations]) assert.doesNotMatch(source, /Changes apply after you save them|Changes apply to every meeting after you save them|Saved secret values are encrypted and never displayed/);
});

test("home shows a five-week rolling calendar, live attendance, and contest review", async () => {
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  const attendance = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const router = await readFile("apps/dashboard/src/router.tsx", "utf8");
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
  assert.match(home, /navigate\(`\/attendance\?meetingId=\$\{encodeURIComponent\(meeting\.id\)\}`\)/);
  assert.match(attendance, /selectedMeetingId/);
  assert.match(attendance, /const ordered = \[\.\.\.result\.meetings\]\.sort\(\(left, right\) => Date\.parse\(left\.startsAt\) - Date\.parse\(right\.startsAt\)\)/);
  assert.match(shell, /new URLSearchParams\(search\)\.get\("meetingId"\)/);
  assert.match(router, /search: window\.location\.search/);
});

test("update assistant backs up before opening GitHub and cannot deploy automatically", async () => {
  const source = await readFile("apps/dashboard/src/updates-page.tsx", "utf8");
  const indicator = await readFile("apps/dashboard/src/update-indicator.tsx", "utf8");
  assert.match(source, /\/admin\/data\/backup\?scope=installation/);
  assert.match(source, /\/admin\/update-info/);
  assert.match(indicator, /formatVersion/);
  assert.match(source, /private GitHub deployment repository/);
  assert.match(source, /authorize Upgrade manually/);
  assert.match(source, /window\.open\(workflowUrl, "_blank", "noopener,noreferrer"\)/);
  assert.match(source, /<div className="panel-heading"><h2>Dashboard<\/h2><button className="primary-button"/);
  assert.match(source, /Opens the guarded workflow in your private deployment repository in a new tab/);
  assert.match(source, /Update to latest stable/);
  assert.match(source, /command: "install_latest"/);
  assert.match(source, /Waiting for the kiosk to receive the request/);
  assert.match(source, /\/commands`\); setCommands/);
  assert.doesNotMatch(source, /about:blank|window\.location\.href/);
  assert.doesNotMatch(source, /workflow_dispatch|api\.github\.com\/repos\/.*\/actions\/workflows/);
});

test("attendance actions preserve their layout and mute unavailable choices", async () => {
  const attendance = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(attendance, /const latestCompleted = ordered\.filter\(\(meeting\) => Date\.parse\(meeting\.endsAt \?\? meeting\.startsAt\) <= Date\.now\(\)\)\.at\(-1\)/);
  assert.match(attendance, /disabled=\{row\.disposition === "present"\}/);
  assert.match(attendance, /Optional note for marking \$\{row\.firstName\} present/);
  assert.match(attendance, /disposition !== "present" && !reason\.trim\(\)/);
  assert.match(attendance, /memberNotices\[row\.memberId\]/);
  assert.match(attendance, /window\.setTimeout/);
  assert.doesNotMatch(attendance, /Kiosk meeting ID|Copy ID|meeting data is current/i);
  assert.match(attendance, /Send Discord absence notice/);
  assert.match(attendance, /className="primary-button" type="button" disabled=\{!selected\}/);
  assert.match(attendance, /toLocaleDateString\(\).*meeting\.title/);
  assert.doesNotMatch(attendance, /row\.disposition === "absent" && <button/);
  assert.match(styles, /grid-template-columns: minmax\(10rem,1fr\) 7rem 30rem/);
  assert.match(styles, /\.correction-actions button:disabled/);
  assert.match(styles, /min-width: 4\.8rem/);
});

test("reports are an operational workspace with filters, trend, saved views, and direct contest review", async () => {
  const reports = await readFile("apps/dashboard/src/reports-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(reports, /includeInactive=1/);
  assert.match(reports, /From<input type="date"/);
  assert.match(reports, /Meeting type<select/);
  assert.match(reports, /Active roster/);
  assert.match(reports, /Team attendance trend/);
  assert.match(reports, /role="img" aria-label=\{`Team attendance trend/);
  assert.match(reports, /Review contest/);
  assert.match(reports, /Approve and mark present/);
  assert.match(reports, /\/discord\/contests\/resolve/);
  assert.match(reports, /lancerlogin-reports-view/);
  assert.match(reports, /attendanceReportingStartsOn/);
  assert.match(reports, /Operational baseline/);
  assert.match(reports, /All preserved history/);
  assert.match(styles, /\.report-filters/);
});

test("contest review requires a reason and keeps failures beside the unresolved contest", async () => {
  const reports = await readFile("apps/dashboard/src/reports-page.tsx", "utf8");
  assert.match(reports, /const \[reviewError, setReviewError\] = useState\(""\)/);
  assert.match(reports, /A review reason is required before resolving this contest\./);
  assert.match(reports, /reviewNote: trimmedReviewNote/);
  assert.match(reports, /Contest resolution failed: \$\{message\}/);
  assert.match(reports, /Review reason<textarea[^>]+required aria-invalid=\{Boolean\(reviewError\)\}/);
  assert.match(reports, /id="contest-review-reason-error"[^>]+role="alert"/);
});

test("dashboard cards keep their spacing and operational actions aligned", async () => {
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const setup = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  assert.match(styles, /--card-padding: 1\.35rem/);
  assert.match(styles, /\.kiosk-monitor[^\n]*padding: var\(--card-padding\)/);
  assert.match(styles, /\.attendance-layout \{[^}]*margin-top: 1rem/);
  assert.match(styles, /\.attendance-card \.panel-heading \{ padding: var\(--card-padding\)/);
  assert.match(styles, /\.report-grid \{ display: grid; grid-template-columns: minmax\(0,1\.5fr\) minmax\(18rem,1fr\)/);
  assert.match(styles, /\.leaderboard-card \{ grid-row: span 2; \}/);
  assert.match(styles, /\.roster-row-actions \{ display: flex/);
  assert.match(styles, /\.roster-row \{[^}]*minmax\(15rem,max-content\)/);
  assert.match(styles, /\.roster-actions \{[^}]*align-items: center/);
  assert.match(styles, /\.roster-directory \.panel-heading \{ align-items: start; flex-direction: column/);
  assert.match(styles, /\.roster-directory \.roster-actions \{ width: 100%; justify-content: space-between/);
  assert.match(styles, /\.roster-row-actions button \{ min-height: 2\.25rem/);
  assert.match(roster, /className="roster-row-actions"/);
  assert.match(styles, /\.panel-heading \{[^}]*align-items: center/);
  assert.match(styles, /\.roster-directory h2 \{ margin-bottom: 0/);
  assert.match(styles, /\.wizard-steps \.setup-finish-button \{[^}]*background: var\(--primary\)/);
  assert.match(setup, /className="primary-button setup-finish-button"/);
  assert.match(roster, /<span>Actions<\/span>/);
  assert.doesNotMatch(roster, /current\.active \? "Active" : "Inactive"/);
});

test("roster discovery searches every requested member field and scopes active members", async () => {
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(roster, /const \[query, setQuery\] = useState\(""\)/);
  assert.match(roster, /const \[scope, setScope\] = useState<"active" \| "all">\("active"\)/);
  assert.match(roster, /\$\{member\.firstName\} \$\{member\.lastName\} \$\{member\.email \?\? ""\} \$\{member\.memberId\}/);
  assert.match(roster, /scope === "all" \|\| member\.active/);
  assert.match(roster, /placeholder="Name, email, or member ID"/);
  assert.match(roster, /<option value="active">Active members<\/option>/);
  assert.match(roster, /<option value="all">All members<\/option>/);
  assert.match(styles, /\.roster-filters/);
});

test("member detail routes preserve deep links, history, and role-limited actions", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const reports = await readFile("apps/dashboard/src/reports-page.tsx", "utf8");
  const detail = await readFile("apps/dashboard/src/member-detail-page.tsx", "utf8");
  assert.match(shell, /path\.startsWith\("\/roster\/"\)/);
  assert.match(roster, /RouteLink href=\{`\/roster\/\$\{encodeURIComponent\(current\.memberId\)/);
  assert.match(reports, /href=\{`\/roster\/\$\{encodeURIComponent\(member\.externalId\)/);
  assert.match(detail, /\/admin\/members\/\$\{encodeURIComponent\(memberId\)\}\/history/);
  assert.match(detail, /Complete attendance history/);
  assert.match(detail, /Check-in/);
  assert.match(detail, /Check-out/);
  assert.match(roster, /attendanceRequiredFrom/);
  assert.match(detail, /Attendance required from/);
  assert.match(detail, /role === "admin"/);
});

test("numeric organization settings can be cleared before they are normalized on save", async () => {
  const source = await readFile("apps/dashboard/src/configuration-settings.tsx", "utf8");
  const colors = await readFile("apps/dashboard/src/color-editor.tsx", "utf8");
  assert.match(source, /useState\(String\(initialBranding\.lateScanMinutes\)\)/);
  assert.match(source, /lateScanMinutes\.trim\(\) === "" \? 0/);
  assert.match(source, /placeholder="0"/);
  assert.match(source, /discordContestWindowHours\.trim\(\) === "" \? 24/);
  assert.match(source, /Attendance reporting baseline/);
  assert.match(source, /attendanceReportingStartsOn: attendanceReportingStartsOn \|\| null/);
  assert.match(colors, /type="number"[^>]+placeholder="0"/);
});

test("kiosk lifecycle is managed on the Kiosks page without reopening onboarding", async () => {
  const source = await readFile("apps/dashboard/src/kiosks-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
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
  assert.match(source, /Last Wi-Fi scan/);
  assert.match(source, /const healthy = Boolean\(active && online && active\.readerOnline/);
  assert.match(source, /healthy \? "Healthy" : online \? "Online"/);
  assert.match(source, /kiosk-state\$\{healthy \? " kiosk-state-healthy"/);
  assert.match(source, /kiosk-health-pill/);
  assert.doesNotMatch(source, /Recovery guidance|recoveryGuidance/);
  assert.match(styles, /\.kiosk-state-healthy \{[^}]*justify-content: center[^}]*min-height: 3\.1rem/);
  assert.match(styles, /\.kiosk-health-pill \{[^}]*display: inline-flex[^}]*align-items: center/);
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

test("dashboard loading stays in an accessible overlay and the brand gradient is viewport-stable", async () => {
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const overlay = await readFile("apps/dashboard/src/loading-overlay.tsx", "utf8");
  const pages = await Promise.all(["home-page.tsx", "meetings-page.tsx", "attendance-workspace.tsx", "reports-page.tsx", "roster-page.tsx", "kiosks-page.tsx", "updates-page.tsx"].map((file) => readFile(`apps/dashboard/src/${file}`, "utf8")));
  assert.match(styles, /background-attachment: fixed/);
  assert.match(styles, /\.dashboard-loading-overlay \{ position: fixed/);
  assert.match(styles, /@keyframes dashboard-loading-spin/);
  assert.match(styles, /main\[aria-busy="true"\] \.setup-status \{ display: none/);
  assert.match(overlay, /role", "status"/);
  assert.match(overlay, /aria-live", "polite"/);
  for (const page of pages) assert.match(page, /useDashboardLoadingOverlay/);
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
