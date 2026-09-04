import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checklistFor, navigationFor, renderDashboard } from "../apps/dashboard/src/shell.mjs";

const branding = { organizationName: "Example Club", subtitle: "Welcome", primaryColor: "#111111", secondaryColor: "#eeeeee", appearance: "dark" };

test("operator dashboard excludes protected administration", () => {
  const navigation = navigationFor("operator");
  assert.deepEqual(navigation, ["Dashboard", "Reports", "Roster", "Kiosks"]);
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
  assert.match(source, /Go to Dashboard/);
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
  assert.match(entry, /role="switch" aria-checked=\{dark\} aria-label="Dark mode"/);
  assert.match(styles, /\.theme-toggle\[aria-checked="true"\] \.theme-toggle-track/);
  assert.match(workspace, /Logo contrast/);
  assert.match(settings, /id="organization-title">Organization/);
  assert.match(settings, /Save organization settings/);
  assert.match(configuration, /Late scan allowance/);
  assert.doesNotMatch(configuration, /Changes apply to every meeting/);
});

test("meeting detail keeps meeting-specific attendance, Discord, and contest operations together", async () => {
  const source = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  const management = await readFile("apps/dashboard/src/meeting-management.tsx", "utf8");
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(source, /Back to Dashboard/);
  assert.match(source, /Switch meeting/);
  assert.match(source, /Refresh attendance/);
  assert.match(source, /Attendance closes/);
  assert.ok(source.includes('role === "admin" && <button type="button" disabled={row.disposition === "not_required"}'));
  assert.doesNotMatch(source, /\/admin\/kiosks|AttendanceCalendar|Export CSV/);
  assert.doesNotMatch(source, /\/discord\/link|Email missed|Email report/);
  assert.match(source, /\/discord\/calendar/);
  assert.match(source, /\/discord\/missing/);
  assert.match(source, /\/discord\/contests\?meetingId=/);
  assert.match(source, /ContestReviewList contests=\{contests\}/);
  assert.match(source, /clock <= Date\.parse\(meeting\.endsAt\)/);
  assert.match(source, /clock >= Date\.parse\(meeting\.startsAt\)/);
  assert.match(source, /MeetingEditDialog/);
  assert.match(source, /MeetingDuplicateDialog/);
  assert.match(source, /MeetingDeleteDialog/);
  assert.match(management, /\/meeting-series\/\$\{encodeURIComponent\(meeting\.seriesId\)\}/);
  assert.match(management, /method: "DELETE"/);
  assert.match(home, /\/restore/);
  assert.match(management, /Delete this and future meetings/);
  assert.match(management, /useModalFocus/);
  assert.match(meetings, /<th>Date<\/th><th>Start<\/th><th>End<\/th>/);
  assert.match(meetings, /Sync all to Discord/);
  assert.doesNotMatch(meetings, />Sync Discord<|calendarByMeeting/);
  assert.match(meetings, /calendarOutcomes/);
  assert.match(management, /addMinutes\(value\.date, startTime, 150\)/);
  assert.doesNotMatch(source, /Kiosk meeting ID/);
  assert.doesNotMatch(source, /Copy ID/);
  assert.match(management, /Notes <span>\(optional\)<\/span>/);
  assert.match(management, /Attendance required/);
  assert.doesNotMatch(meetings, /Optional meeting/);
  assert.match(meetings, /Search Meetings/);
  assert.match(styles, /\.meeting-create-form input\[type="checkbox"\]/);
  assert.match(styles, /\.meeting-directory input\[type="checkbox"\]:checked/);
  assert.match(meetings, /Create recurring series/);
  assert.match(meetings, /Duplicate an existing meeting/);
  assert.doesNotMatch(meetings, />Edit<|>Delete this meeting<|meeting-actions-cell/);
  assert.match(meetings, /closest\("\.meeting-selection"\)/);
  assert.match(home, /pendingMeetingDeletionKey/);
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

test("dashboard consolidates meeting navigation and keeps roster accounts together", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const importer = await readFile("apps/dashboard/src/roster-import-panel.tsx", "utf8");
  const users = await readFile("apps/dashboard/src/user-settings.tsx", "utf8");
  for (const route of ["/dashboard", "/meetings", "/attendance", "/reports", "/roster", "/kiosks", "/settings/data", "/settings/updates"]) {
    assert.match(shell, new RegExp(route.replaceAll("/", "\\/")));
  }
  assert.match(shell, /\["\/dashboard", "Dashboard"\]/);
  assert.doesNotMatch(shell, /\["\/meetings", "Meetings"\]|\["\/attendance", "Attendance"\]/);
  assert.match(shell, /LegacyMeetingsRedirect/);
  assert.match(shell, /dashboardMeetingViewKey, "table"/);
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

test("dashboard access sign-in method is a compact, accessible radio toggle group", async () => {
  const users = await readFile("apps/dashboard/src/user-settings.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(users, /<fieldset className="method-switch"><legend>Sign-in method<\/legend>/);
  assert.match(users, /type="radio" name="user-method" checked=\{method === "local"\}/);
  assert.match(users, /type="radio" name="user-method" checked=\{method === "google"\}/);
  assert.match(users, /className=\{method === "local" \? "selected" : ""\}/);
  assert.match(users, /className=\{method === "google" \? "selected" : ""\}/);
  assert.match(styles, /\.method-switch-options \{ display: inline-grid/);
  assert.match(styles, /\.method-switch-options label\.selected/);
  assert.match(styles, /\.method-switch-options label:has\(input:focus-visible\)/);
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

test("Dashboard provides remembered calendar and table meeting browsers", async () => {
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  const attendance = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const router = await readFile("apps/dashboard/src/router.tsx", "utf8");
  assert.match(home, /length: 35/);
  assert.match(home, /lancerlogin-dashboard-meeting-view/);
  assert.match(home, /Meeting view/);
  assert.match(home, /Add meeting/);
  assert.match(home, /setCalendarOffset/);
  assert.match(home, /MeetingsPage discordEnabled=\{discordEnabled\} navigate=\{navigate\} embedded meetings=\{meetings\} onMeetingsChange=\{load\}/);
  assert.match(home, /MeetingCreationDialog open=\{creating\}/);
  assert.match(meetings, /useModalFocus\(dialog, open, busy, close\)/);
  assert.match(meetings, /useEffect\(\(\) => \{ if \(error\) errorAlert\.current\?\.focus\(\); \}, \[error\]\)/);
  assert.match(meetings, /ref=\{errorAlert\} id="meeting-create-error"/);
  assert.doesNotMatch(meetings, /requestAnimationFrame\(\(\) => document\.getElementById\("meeting-create-error"\)/);
  assert.match(meetings, /onCreated\(result\.meetings\.length\)/);
  assert.match(meetings, /Duplicate an existing meeting/);
  assert.match(home, /previousMonth/);
  assert.match(home, /previous-month/);
  assert.doesNotMatch(home, /Last week through the next three weeks/);
  assert.doesNotMatch(home, /Meetings in progress|live-roster|Active · not checked out/);
  assert.doesNotMatch(home, /Attendance contests|ContestReviewList|\/discord\/contests/);
  assert.match(attendance, /className="attendance-table"/);
  assert.match(attendance, /Active · not checked out/);
  assert.match(attendance, /ContestReviewList contests=\{contests\}/);
  assert.match(home, /navigate\(`\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}`\)/);
  assert.match(meetings, /className="meeting-browser-row"/);
  assert.match(attendance, /api<\{ meeting: Meeting \}>\(`\/meetings\/\$\{encodeURIComponent\(meetingId\)\}`\)/);
  assert.match(shell, /path\.startsWith\("\/meetings\/"\)/);
  assert.match(shell, /LegacyAttendanceRedirect/);
  assert.match(shell, /navigate\(meetingId \? `\/meetings\/\$\{encodeURIComponent\(meetingId\)\}` : "\/dashboard", true\)/);
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
  assert.match(attendance, /lifecycle === "in_progress" \|\| lifecycle === "late_scan_window"/);
  assert.match(attendance, /setInterval\([\s\S]*30_000/);
  assert.match(attendance, /disabled=\{row\.disposition === "present"\}/);
  assert.match(attendance, /Optional note for marking \$\{row\.firstName\} present/);
  assert.match(attendance, /disposition !== "present" && !reason\.trim\(\)/);
  assert.match(attendance, /memberNotices\[row\.memberId\]/);
  assert.match(attendance, /window\.setTimeout/);
  assert.doesNotMatch(attendance, /Kiosk meeting ID|Copy ID|meeting data is current/i);
  assert.match(attendance, /Refresh attendance/);
  assert.match(attendance, /navigate\(`\/meetings\/\$\{encodeURIComponent\(event\.target\.value\)\}`\)/);
  assert.match(attendance, /toLocaleDateString\(\).*item\.title/);
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
  assert.match(reports, /Download attendance CSV/);
  assert.match(reports, /\/exports\/attendance\.csv/);
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

test("pending contests use meeting detail and the global notifier instead of Dashboard or Reports", async () => {
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const indicator = await readFile("apps/dashboard/src/contest-indicator.tsx", "utf8");
  const reviewList = await readFile("apps/dashboard/src/contest-review-list.tsx", "utf8");
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(shell, /ContestIndicator/);
  assert.match(shell, /ContestIndicator enabled=\{integrations\.discord\.configured\}/);
  assert.match(indicator, /\/discord\/contests/);
  assert.match(indicator, /capabilities\.integrations\.discord\.configured/);
  assert.match(indicator, /aria-haspopup="dialog"/);
  assert.match(indicator, /useModalFocus/);
  assert.match(indicator, /contestsChangedEvent/);
  assert.match(reviewList, /meetingStartsAt/);
  assert.match(reviewList, /<strong>\{contest\.firstName\} \{contest\.lastName\}<small>\{contest\.externalId\}/);
  assert.match(reviewList, /contest\.meetingTitle.*occurrenceDate\(contest\)/s);
  assert.match(reviewList, /A review reason is required before resolving this contest\./);
  assert.match(reviewList, /window\.dispatchEvent\(new Event\(contestsChangedEvent\)\)/);
  assert.doesNotMatch(home, /ContestReviewList|\/discord\/contests|Attendance contests/);
  assert.match(styles, /\.reports-page \.contest-report \{ display: none; \}/);
});

test("dashboard cards keep their spacing and operational actions aligned", async () => {
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const roster = await readFile("apps/dashboard/src/roster-page.tsx", "utf8");
  const setup = await readFile("apps/dashboard/src/setup-workspace.tsx", "utf8");
  assert.match(styles, /--card-padding: var\(--space-5\)/);
  assert.match(styles, /\.kiosk-monitor[^\n]*padding: var\(--card-padding\)/);
  assert.match(styles, /\.attendance-layout \{[^}]*margin-top: 1rem/);
  assert.match(styles, /\.attendance-card \.panel-heading \{ padding: var\(--card-padding\)/);
  assert.match(styles, /\.report-grid \{ display: grid; grid-template-columns: minmax\(0,1\.5fr\) minmax\(18rem,1fr\)/);
  assert.match(styles, /\.leaderboard-card \{ grid-row: span 2; \}/);
  assert.match(styles, /\.roster-row-actions \{ display: flex/);
  assert.match(styles, /\.roster-row \{[^}]*minmax\(15rem,max-content\)/);
  assert.match(styles, /\.roster-row\.with-discord \{[^}]*grid-template-columns:[^}]*minmax\(15rem,max-content\)/);
  assert.match(styles, /\.roster-row > \* \{ align-self: center/);
  assert.match(styles, /\.roster-action-cell \{ justify-self: end/);
  assert.match(styles, /\.roster-row\.header \{ display: none/);
  assert.match(styles, /\.roster-action-cell \{ grid-column: 1 \/ -1; width: 100%; justify-self: stretch/);
  assert.match(styles, /\.roster-actions \{[^}]*align-items: center/);
  assert.match(styles, /\.roster-directory \.panel-heading \{ align-items: start; flex-direction: column/);
  assert.match(styles, /\.roster-directory \.roster-actions \{ width: 100%; justify-content: space-between/);
  assert.match(styles, /\.roster-row-actions button \{ min-height: 2\.25rem/);
  assert.match(roster, /className="roster-row-actions"/);
  assert.match(roster, /discordConfigured \? " with-discord"/);
  assert.match(roster, /className="roster-action-cell"/);
  assert.match(styles, /\.panel-heading \{[^}]*align-items: center/);
  assert.match(styles, /\.roster-directory h2 \{ margin-bottom: 0/);
  assert.match(styles, /\.wizard-steps \.setup-finish-button \{[^}]*background: var\(--primary\)/);
  assert.match(setup, /className="primary-button setup-finish-button"/);
  assert.match(roster, /<span className="roster-action-cell">Actions<\/span>/);
  assert.doesNotMatch(roster, /current\.active \? "Active" : "Inactive"/);
});

test("shared dashboard foundations expose reusable contract patterns", async () => {
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  for (const pattern of ["ui-card", "ui-form", "ui-control", "ui-table", "ui-status", "ui-dialog", "ui-control-group"]) {
    assert.match(styles, new RegExp(`\\.${pattern}`));
  }
  assert.match(styles, /\.ui-control[^}]*min-height: var\(--control-min-block-size\)/);
  assert.match(styles, /\.ui-table th[^}]*font-size: var\(--text-caption\)/);
  assert.match(styles, /\.ui-status\[data-tone="error"\][^}]*var\(--ui-error\)/);
});

test("Dashboard and meeting workspace apply the shared conformance contract", async () => {
  const home = await readFile("apps/dashboard/src/home-page.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  const management = await readFile("apps/dashboard/src/meeting-management.tsx", "utf8");
  const attendance = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  assert.match(home, /dashboard-meeting-status[^>]+data-tone=\{noticeTone\}/);
  assert.match(home, /No meetings are scheduled in this five-week range\./);
  assert.match(meetings, /meeting-directory-heading/);
  assert.match(meetings, /className="ui-table"/);
  assert.match(meetings, /data-tone=\{calendarAllTone\}/);
  assert.match(management, /aria-describedby=\{descriptionId\}/);
  assert.match(attendance, /role="columnheader"/);
  assert.match(attendance, /data-tone=\{discordNoticeTone\}/);
  assert.match(attendance, /className="empty-page ui-card"/);
  for (const selector of ["meeting-browser-controls", "dashboard-meeting-calendar", "meeting-detail-heading", "meeting-lifecycle", "attendance-state", "meeting-management-dialog"]) {
    assert.match(styles, new RegExp(`\\.${selector}`));
  }
  assert.match(styles, /\.meeting-lifecycle\.in_progress[^}]*var\(--ui-success\)/);
  assert.match(styles, /\.attendance-state\.absent[^}]*var\(--ui-error\)/);
  assert.match(styles, /\.attendance-state\.excused[^}]*var\(--ui-warning\)/);
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
  assert.match(shell, /discordEnabled=\{integrations\.discord\.enabled\}/);
  assert.match(detail, /discordEnabled && <dl className="member-discord-identity"/);
  assert.match(detail, /detail\.member\.discordUserId/);
  assert.match(detail, /member-discord-unlinked">Not linked/);
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
  assert.match(source, /<div className="page-intro"><h1 id="kiosks-title">Kiosks<\/h1><\/div>/);
  assert.match(source, /<div className="kiosk-card-heading"><h2>Physical kiosk<\/h2>\{role === "admin" && <button className="primary-button"/);
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
  assert.match(styles, /\.kiosk-card-heading \{[^}]*display: flex[^}]*justify-content: space-between/);
  assert.match(styles, /\.kiosk-card-heading \.primary-button \{[^}]*width: auto[^}]*margin: 0/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.kiosk-card-heading \.primary-button \{ width: 100%; \}/);
  assert.doesNotMatch(styles, /\.kiosk-page-heading/);
  assert.doesNotMatch(source, /openSetup/);
  assert.match(source, /discordConfigured && <section className="kiosk-discord-status"/);
  assert.match(source, /\/discord\/kiosk-status/);
  assert.match(source, /Sync Discord status/);
  assert.match(source, /Persistent Discord kiosk status (?:updated|is already current)/);
  assert.match(styles, /\.kiosk-discord-status \{[^}]*align-items: center[^}]*var\(--ui-surface-subtle\)[^}]*var\(--radius-card\)/);
  assert.match(styles, /\.kiosk-discord-status button \{[^}]*min-height: var\(--control-min-block-size\)/);
});

test("Kiosks refresh hides redundant success while preserving actionable feedback", async () => {
  const source = await readFile("apps/dashboard/src/kiosks-page.tsx", "utf8");
  assert.doesNotMatch(source, /Kiosk status is current\./);
  assert.match(source, /if \(!preserveNotice\) setNotice\(""\)/);
  assert.match(source, /load\(\{ preserveNotice: true \}\)/);
  assert.match(source, /setInterval\(\(\) => void load\(\)\.catch\(\(error: Error\) => setNotice\(error\.message\)\), 30_000\)/);
  assert.match(source, /\{notice && <p className="setup-status" role="status">\{notice\}<\/p>\}/);
  for (const result of ["Kiosk renamed.", "Kiosk retired.", "queued. The kiosk normally receives it within five seconds.", "Browser simulator stopped."]) {
    assert.match(source, new RegExp(result.replaceAll(".", "\\.")));
  }
});

test("integration setup distinguishes saved credentials from verified connections", async () => {
  const source = await readFile("apps/dashboard/src/integration-settings.tsx", "utf8");
  const shell = await readFile("apps/dashboard/src/app-shell.tsx", "utf8");
  const meetings = await readFile("apps/dashboard/src/meetings-page.tsx", "utf8");
  const attendance = await readFile("apps/dashboard/src/attendance-workspace.tsx", "utf8");
  assert.match(source, /Verification required/);
  assert.match(source, /result\.created \?/);
  assert.match(source, /credentials saved\. Complete verification below/);
  assert.match(source, /resend\/verify\/start/);
  assert.match(source, /resend\/verify\/complete/);
  assert.match(source, /discord\/verify\/start/);
  assert.match(source, /Verify with Google/);
  assert.match(source, /role="switch" aria-label=\{`Enable/);
  assert.match(source, /const ordered = \[\.\.\.providers\]\.sort/);
  assert.match(source, /integration-card\$\{enabled \? "" : " disabled"\}/);
  assert.match(source, /enabled && <details className="integration-details"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(shell, /\/integrations\/capabilities/);
  assert.match(shell, /HomePage[^>]+discordEnabled=\{integrations\.discord\.configured\}/);
  assert.match(shell, /ReportsPage discordEnabled=\{integrations\.discord\.configured\}/);
  assert.match(shell, /KiosksPage role=\{role\} discordConfigured=\{integrations\.discord\.configured\}/);
  assert.match(meetings, /discordEnabled && <button.*Sync all to Discord/);
  assert.match(attendance, /capabilities\.integrations\.discord\.configured/);
  assert.match(attendance, /Send Discord absence notice/);
  assert.match(attendance, /Sync Discord calendar/);
  assert.doesNotMatch(source, /Previous credentials were replaced|\/test"/);
});

test("dashboard styling uses self-hosted typography and themed organization controls", async () => {
  const entry = await readFile("apps/dashboard/src/main.tsx", "utf8");
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  const organization = await readFile("apps/dashboard/src/organization-settings.tsx", "utf8");
  assert.match(entry, /@fontsource\/bebas-neue\/latin-400\.css/);
  assert.match(entry, /@fontsource\/roboto\/latin-700\.css/);
  assert.match(styles, /--font-body: "Roboto"/);
  assert.match(styles, /--font-display: "Bebas Neue", sans-serif/);
  assert.match(styles, /h1, h2, h3, h4, h5, h6, legend \{ font-family: var\(--font-display\)/);
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
