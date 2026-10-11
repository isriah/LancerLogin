import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

type Counts = Partial<Record<"button" | "input" | "select" | "textarea" | "summary", number>>;

const reviewedNativeControls: Record<string, Counts> = {
  "app-shell.tsx": { button: 7, input: 1 },
  "attendance-calendar.tsx": { button: 1 },
  "attendance-settings.tsx": { button: 9, input: 6, select: 3 },
  "attendance-workspace.tsx": { button: 11, select: 1 },
  "bulk-roster-actions.tsx": { button: 3, input: 2, select: 2 },
  "carpool-setup-workspace.tsx": { button: 1, input: 2 },
  "carpool-meeting-links.tsx": { select: 1 },
  "carpool-workspace.tsx": { button: 45, input: 25, select: 6, textarea: 2, summary: 1 },
  "color-editor.tsx": { input: 3, summary: 1 },
  "configuration-settings.tsx": { button: 1, input: 4 },
  "contest-indicator.tsx": { button: 2 },
  "contest-review-list.tsx": { button: 5, input: 3, textarea: 2 },
  "data-settings.tsx": { button: 6, input: 2 },
  "discord-label-role-settings.tsx": { button: 6 },
  "fingerprint-reset-panel.tsx": { button: 4, input: 1 },
  "fingerprint-sync-settings.tsx": { button: 2 },
  "fingerprint-vault-settings.tsx": { button: 2 },
  "home-page.tsx": { button: 16, input: 2, select: 1 },
  "info-tip.tsx": { button: 1 },
  "integration-settings.tsx": { button: 15, input: 8, select: 1, summary: 1 },
  "kiosks-page.tsx": { button: 20, input: 2, select: 1 },
  "main.tsx": { button: 6, input: 13 },
  "meeting-management.tsx": { button: 8, input: 11, select: 2, textarea: 1 },
  "meeting-weight-settings.tsx": { button: 6, input: 6, summary: 2 },
  "meetings-page.tsx": { button: 4, input: 3, select: 2 },
  "member-detail-page.tsx": { button: 7 },
  "member-label-controls.tsx": { button: 6, input: 3, select: 2, textarea: 1 },
  "module-controls.tsx": { button: 6, input: 2 },
  "module-setup-workspace.tsx": { button: 5, input: 10, select: 2 },
  "organization-settings.tsx": { button: 2, input: 4 },
  "outreach-activity-publication.tsx": { button: 2, input: 2 },
  "outreach-clock.tsx": { button: 9, select: 1 },
  "outreach-setup-workspace.tsx": { button: 2, input: 5 },
  "outreach-workspace.tsx": { button: 37, input: 15, select: 9, textarea: 6, summary: 2 },
  "page-walkthrough.tsx": { button: 10 },
  "public-outreach-form.tsx": { button: 10, input: 1, select: 2, textarea: 2 },
  "outreach-public-settings.tsx": { button: 1, select: 1 },
  "report-result-table.tsx": { button: 11, input: 6, select: 1, summary: 1 },
  "reports-page.tsx": { button: 25, input: 11, select: 16, textarea: 1, summary: 2 },
  "roster-import-panel.tsx": { button: 6, input: 1, select: 1, textarea: 1 },
  "roster-page.tsx": { button: 13, input: 13, select: 2 },
  "scheduler-controls.tsx": { button: 2 },
  "settings-module-navigation.tsx": { button: 2 },
  "setup-workspace.tsx": { button: 21, input: 8, select: 3 },
  "simulator-page.tsx": { button: 1, select: 2 },
  "update-indicator.tsx": { button: 3 },
  "update-channel-card.tsx": { button: 1, input: 1, select: 1 },
  "updates-page.tsx": { button: 2 },
  "user-settings.tsx": { button: 2, input: 5, select: 4 },
  "web-update-card.tsx": { button: 5, input: 1, summary: 1 },
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
