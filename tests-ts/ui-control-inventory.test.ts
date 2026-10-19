import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

type Counts = Partial<Record<"button" | "input" | "select" | "textarea" | "summary", number>>;

const reviewedNativeControls: Record<string, Counts> = {
  "settings-section-navigation.tsx": { select: 1 },
  "attendance-trend-chart.tsx": { button: 1 },
  "app-shell.tsx": { button: 7, input: 1 },
  "attendance-calendar.tsx": { button: 1 },
  "attendance-settings.tsx": { button: 9, input: 6, select: 3, summary: 2 },
  "attendance-workspace.tsx": { button: 11, summary: 1 },
  "bulk-roster-actions.tsx": { button: 3, input: 2, select: 2 },
  "carpool-plan-form.tsx": { button: 2, input: 7, select: 3, textarea: 1, summary: 1 },
  "carpool-settings.tsx": { button: 1, input: 4 },
  "carpool-setup-workspace.tsx": { button: 1, input: 2 },
  "carpool-meeting-links.tsx": { select: 1 },
  "carpool-workspace.tsx": { button: 20, input: 1, select: 2 },
  "carpool-share.tsx": { button: 4, select: 1, summary: 1 },
  "carpool-location-status.tsx": { button: 1 },
  "carpool-import.tsx": { button: 14, input: 2, select: 3, summary: 1 },
  "carpool-participant-editor.tsx": { button: 11, input: 7, select: 2, textarea: 1, summary: 2 },
  "carpool-people.tsx": { button: 5, input: 1, select: 1 },
  "carpool-pin-map.tsx": { button: 1 },
  "carpool-groups.tsx": { button: 27, input: 6, select: 3, summary: 1 },
  "carpool-rebuild-preview.tsx": { button: 4, input: 1, summary: 1 },
  "carpool-assignment-editor.tsx": { button: 4, select: 1 },
  "color-editor.tsx": { input: 3, summary: 1 },
  "configuration-settings.tsx": { button: 1, input: 4 },
  "contest-indicator.tsx": { button: 2 },
  "contest-review-list.tsx": { button: 5, input: 3, textarea: 2 },
  "data-settings.tsx": { button: 6, input: 2, summary: 1 },
  "discord-label-role-settings.tsx": { button: 6 },
  "fingerprint-reset-panel.tsx": { button: 4, input: 1 },
  "fingerprint-vault-settings.tsx": { button: 5 },
  "home-page.tsx": { button: 14, select: 1 },
  "info-tip.tsx": { button: 1 },
  "integration-settings.tsx": { button: 15, input: 8, select: 1, summary: 2 },
  "kiosks-page.tsx": { button: 20, input: 2, select: 1, summary: 4 },
  "mobile-calendar.tsx": { button: 4, input: 1 },
  "main.tsx": { button: 6, input: 13 },
  "meeting-management.tsx": { button: 8, input: 11, select: 2, textarea: 1 },
  "meeting-weight-settings.tsx": { button: 6, input: 6, summary: 2 },
  "meetings-page.tsx": { button: 4, input: 3, select: 2, summary: 1 },
  "member-detail-page.tsx": { button: 5, summary: 1 },
  "member-label-controls.tsx": { button: 6, input: 3, select: 2, textarea: 1 },
  "module-controls.tsx": { button: 6, input: 2 },
  "module-setup-workspace.tsx": { button: 5, input: 10, select: 2 },
  "organization-settings.tsx": { button: 2, input: 4 },
  "outreach-activity-publication.tsx": { button: 4, input: 2, select: 1 },
  "outreach-clock.tsx": { button: 9, select: 1 },
  "outreach-setup-workspace.tsx": { button: 2, input: 3, select: 1 },
  "outreach-entry-edit.tsx": { button: 3, select: 2, textarea: 2 },
  "outreach-settings.tsx": { button: 12, input: 4, select: 2 },
  "outreach-workspace.tsx": { button: 24, input: 12, select: 10, textarea: 6, summary: 3 },
  "page-walkthrough.tsx": { button: 10, summary: 1 },
  "public-outreach-form.tsx": { button: 10, input: 1, select: 2, textarea: 2 },
  "outreach-public-settings.tsx": { button: 1, select: 1 },
  "report-leave-dialog.tsx": { button: 3 },
  "report-result-table.tsx": { button: 11, input: 6, select: 1, summary: 1 },
  "reports-page.tsx": { button: 31, input: 12, select: 16, textarea: 1, summary: 5 },
  "roster-import-panel.tsx": { button: 6, input: 1, select: 1, textarea: 1 },
  "roster-page.tsx": { button: 13, input: 13, select: 2, summary: 1 },
  "scheduler-controls.tsx": { button: 2, summary: 1 },
  "settings-module-navigation.tsx": { button: 1 },
  "setup-workspace.tsx": { button: 21, input: 8, select: 3 },
  "simulator-page.tsx": { button: 1, select: 2, summary: 1 },
  "update-indicator.tsx": { button: 3 },
  "update-channel-card.tsx": { button: 1, input: 1, select: 1, summary: 1 },
  "updates-page.tsx": { button: 1 },
  "user-settings.tsx": { button: 3, input: 5, select: 4, summary: 1 },
  "web-update-card.tsx": { button: 5, input: 1, summary: 2 },
};

test("raw dashboard controls remain in the reviewed UI inventory", async () => {
  const folder = "apps/dashboard/src";
  const files = (await readdir(folder)).filter((file) => file.endsWith(".tsx")).sort();
  const actual: Record<string, Counts> = {};
  for (const file of files) {
    const source = await readFile(`${folder}/${file}`, "utf8");
    const counts: Counts = {};
    for (const tag of ["button", "input", "select", "textarea", "summary"] as const) {
      const count = [...source.matchAll(new RegExp(`<${tag}\\b`, "g"))].length;
      if (count) counts[tag] = count;
    }
    if (Object.keys(counts).length) actual[file] = counts;
  }
  assert.deepEqual(actual, reviewedNativeControls,
    "Native control markup changed. Use the shared UI patterns and focused rendered coverage, then review and update this inventory deliberately.");
});

test("the theme-safe foundation covers every inventoried native control kind", async () => {
  const styles = await readFile("apps/dashboard/src/styles.css", "utf8");
  for (const tag of ["button", "input", "select", "textarea", "summary"]) assert.match(styles, new RegExp(`\\.app[^}]*${tag}|\\.app :where\\([^)]*${tag}`));
  assert.match(styles, /--ui-scrollbar-track/);
  assert.match(styles, /html::-webkit-scrollbar/);
  assert.match(styles, /color-scheme: dark/);
  assert.match(styles, /:is\(button,input,select,textarea\)\[aria-invalid="true"\]/);
});
