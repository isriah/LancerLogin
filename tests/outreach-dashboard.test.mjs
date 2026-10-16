import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Outreach dashboard exposes the agreed everyday workflow", async () => {
  const [shell, workspace, setup, clock, publicForm, publication, styles, browserFixture, uiStandards, moduleNavigation, settings, participation] = await Promise.all([
    readFile("apps/dashboard/src/app-shell.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-workspace.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-setup-workspace.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-clock.tsx", "utf8"),
    readFile("apps/dashboard/src/public-outreach-form.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-activity-publication.tsx", "utf8"),
    readFile("apps/dashboard/src/styles.css", "utf8"),
    readFile("tests/fixtures/dashboard-preview-server.mjs", "utf8"),
    readFile("docs/UI-STANDARDS.md", "utf8"),
    readFile("apps/dashboard/src/settings-module-navigation.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-settings.tsx", "utf8"),
    readFile("apps/dashboard/src/outreach-participation.ts", "utf8"),
  ]);
  assert.match(shell, /\["\/hours", "Outreach"\]/);
  assert.match(workspace, /Create Outreach activity/);
  assert.match(workspace, /Activity view/);
  assert.match(workspace, /Activity calendar/);
  assert.match(workspace, /Activity table/);
  assert.match(workspace, /BrowserViewIcon view="calendar"/);
  assert.match(workspace, /BrowserViewIcon view="table"/);
  assert.match(workspace, /outreachActivityViewKey/);
  assert.match(workspace, /outreachActivityVisibilityKey/);
  assert.match(workspace, /if \(raw === null\) return \["event"\]/);
  assert.match(workspace, /Show activity types/);
  assert.match(workspace, /visibleItems/);
  assert.match(workspace, /useModalFocus/);
  assert.match(workspace, /Activity type/);
  assert.match(workspace, /Outreach labels \(optional\)/);
  assert.match(workspace, /\/admin\/hours\/labels/);
  assert.doesNotMatch(workspace, /item === "labels" \? "Labels"|tab === "labels"/);
  assert.doesNotMatch(workspace, /item === "settings" \? "Settings"|<OutreachSettings/);
  assert.match(moduleNavigation, /outreachReady \? \[\{ id: "outreach", label: "Outreach", links: \[\["\/settings\/outreach-setup", "Outreach settings"\]\]/);
  assert.match(shell, /<SettingsModuleNavigation[^>]*outreachReady=\{outreachReady\}/);
  assert.match(shell, /onOpenActivity=\{\(id\) => navigate\(`/);
  assert.match(shell, /outreachReady && path === "\/settings\/outreach-setup"\) page = <OutreachSetupSettings isAdmin=\{role === "admin"\}/);
  assert.match(workspace, /Settings &gt; Outreach/);
  assert.match(workspace, /openCorrections\.length > 0/);
  assert.doesNotMatch(workspace, /Manage labels/);
  assert.match(workspace, /Corrections <span/);
  assert.match(workspace, /Review in activity/);
  assert.match(workspace, /Reopen for 24 hours/);
  assert.match(workspace, /Resolved correction history/);
  assert.match(workspace, /Add member participation/);
  assert.match(workspace, /Staff reason/);
  assert.match(participation, /Staff-added entry/);
  assert.match(workspace, /Submission Log/);
  assert.doesNotMatch(workspace, /TotalsPanel|Outreach totals|Supported-team totals|\/admin\/hours\/totals/);
  assert.match(workspace, /Retry exact submission/);
  assert.match(workspace, /className="ui-control-group outreach-tabs"/);
  assert.match(workspace, /className="ui-button"/);
  assert.match(workspace, /className="ui-card ui-form outreach-stack"/);
  assert.doesNotMatch(workspace, /Historical descriptors|historicalDescriptors/);
  assert.doesNotMatch(workspace, /Reuse Attendance details|attendance-sources|sourceMeetingId/);
  assert.doesNotMatch(workspace, /All older activities|Create category/);
  assert.doesNotMatch(workspace, /"publication"|publication draft|Approve and queue/i);
  assert.match(workspace, /OutreachEventScheduleFields/);
  assert.match(workspace, /ActivityPublicationControls/);
  assert.match(publication, /Automatic activity publication/);
  assert.match(publication, /Off by default/);
  assert.doesNotMatch(publication, /draft|approve/i);
  assert.match(styles, /input\.ui-checkbox \{[^}]*width: 1\.25rem;[^}]*height: 1\.25rem;/s);
  assert.match(styles, /\.outreach-workspace label:not\(\.checkbox-field\),\.outreach-stack label:not\(\.checkbox-field\) \{[^}]*margin: 0;/s);
  assert.match(styles, /\.outreach-stack label\.settings-checkbox \{[^}]*display: flex;/s);
  assert.match(styles, /\.outreach-activity-visibility > summary \{[^}]*background: var\(--ui-surface-subtle\);/s);
  assert.match(uiStandards, /Collection-management pages show the collection first/);
  assert.match(setup, /Set up Outreach/);
  assert.doesNotMatch(setup, /reuse|Attendance details can be copied|integrations/i);
  assert.match(setup, /one setup card at a time|Step \{current \+ 1\}/i);
  assert.match(clock, /Array\.from\(\{ length: 12 \}/);
  assert.match(clock, /delta \* 5/);
  assert.match(clock, /This time occurs twice/);
  assert.match(publicForm, /Record Outreach Participation/);
  assert.match(publicForm, /showContext=\{false\}/);
  assert.doesNotMatch(publicForm, /LancerLogin rejects overlapping time/);
  assert.match(publicForm, /Retry exact submission/);
  assert.match(publicForm, /reopened by Staff/);
  assert.match(publicForm, /publicApi<Page<Activity>>\("activities/);
  assert.match(publicForm, /Outreach activity<select required/);
  assert.doesNotMatch(publicForm, /Participation receipt reference|Keep this reference/);
  assert.match(publicForm, /ui-card ui-form outreach-stack public-outreach-form/);
  for (const source of [workspace, setup, clock, publicForm, publication, settings]) {
    assert.doesNotMatch(source, /className="primary-button"/);
    for (const match of source.matchAll(/<button\b[^>]*>/g)) assert.match(match[0], /className=.*(?:ui-button|outreach-activity-calendar-entry)/);
  }
  for (const source of [workspace, publicForm]) for (const match of source.matchAll(/<form\b[^>]*>/g)) assert.match(match[0], /className=.*ui-form/);
  assert.match(clock, /ui-button outreach-clock-trigger/);
  assert.match(clock, /ui-button outreach-clock-option/);
  assert.doesNotMatch(setup, /historicalDescriptors/);
  assert.doesNotMatch(publicForm, /Participation category|Service date \(optional\)|receipt reference \(optional\)/);
  assert.match(browserFixture, /path === "\/reports\/catalog" \? \{[^\n]*outreachLabels: \[\]/);
  for (const removed of ["responsibleStaff", "partnerTeam", "planningTime", "endNextDay"]) assert.doesNotMatch(workspace, new RegExp(removed, "i"));
});

test("Outreach server keeps simplified ownership and accounting boundaries", async () => {
  const [catalogs, entries, migration, memberMigration, publicRoute] = await Promise.all([
    readFile("apps/api/src/outreach-catalogs.ts", "utf8"),
    readFile("apps/api/src/outreach-entries.ts", "utf8"),
    readFile("apps/api/migrations/0042_outreach_participation.sql", "utf8"),
    readFile("apps/api/migrations/0043_outreach_member_participation.sql", "utf8"),
    readFile("apps/api/src/outreach-public.ts", "utf8"),
  ]);
  assert.match(catalogs, /a\.mode='team'/);
  assert.doesNotMatch(catalogs, /created from member submissions/);
  assert.match(entries, /staffReason/);
  assert.match(entries, /Choose an active Outreach activity/);
  assert.doesNotMatch(catalogs, /attendance-sources|attendanceSources|attendanceSource\(/);
  assert.match(entries, /five-minute increments/);
  assert.match(entries, /hours_overlap/);
  assert.match(entries, /staff_recorded/);
  assert.match(entries, /hours_entry_revisions/);
  assert.match(migration, /CHECK\(end_ms>start_ms AND \(end_ms-start_ms\)=duration_minutes\*60000\)/);
  assert.match(memberMigration, /CREATE TABLE hours_reopen_windows/);
  assert.match(memberMigration, /CREATE TABLE hours_correction_requests/);
  assert.match(publicRoute, /identity_not_verified/);
  assert.match(publicRoute, /result_uncertain/);
  assert.match(entries, /linked_discord/);
  assert.doesNotMatch(migration, /end_next_day|planning_time_zone|responsible_staff|partner_team|organization TEXT/i);
});
