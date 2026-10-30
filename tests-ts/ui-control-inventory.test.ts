import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

type Counts = Partial<Record<"button" | "input" | "select" | "textarea" | "summary", number>>;

const reviewedNativeControls: Record<string, Counts> = {
  "settings-section-navigation.tsx": { select: 1 },
  "attendance-trend-chart.tsx": { button: 1 },
  "app-shell.tsx": { button: 12, input: 1 },
  "attendance-calendar.tsx": { button: 1 },
  "attendance-settings.tsx": { button: 7, input: 5, select: 3, summary: 1 },
  "attendance-workspace.tsx": { button: 11, summary: 1 },
  "bulk-roster-actions.tsx": { button: 8, input: 2, select: 2 },
  "color-editor.tsx": { input: 3, summary: 1 },
  "configuration-settings.tsx": { button: 1, input: 4 },
  "contest-indicator.tsx": { button: 2 },
  "contest-review-list.tsx": { button: 6, input: 3, textarea: 2, summary: 1 },
  "data-settings.tsx": { button: 6, input: 3, summary: 1 },
  "error-boundary.tsx": { button: 4 },
  "fingerprint-reset-panel.tsx": { button: 4, input: 1 },
  "fingerprint-vault-settings.tsx": { button: 5 },
  "home-page.tsx": { button: 14, select: 1 },
  "info-tip.tsx": { button: 1 },
  "integration-settings.tsx": { button: 17, input: 9, select: 1, summary: 2 },
  "kiosk-enrollment-dialog.tsx": { button: 4, input: 1 },
  "kiosk-fingerprint-match.tsx": { button: 1, input: 1 },
  "kiosk-scan-reviews.tsx": { button: 8, input: 1, select: 3, textarea: 2, summary: 1 },
  "kiosks-page.tsx": { button: 18, input: 1, select: 1, summary: 4 },
  "labels-page.tsx": { button: 16, input: 3, select: 1, summary: 2 },
  "mobile-calendar.tsx": { button: 4, input: 1 },
  "main.tsx": { button: 5, input: 12, select: 1 },
  "meeting-management.tsx": { button: 8, input: 12, select: 2, textarea: 1 },
  "meeting-weight-settings.tsx": { button: 6, input: 6, summary: 2 },
  "meetings-page.tsx": { button: 4, input: 3, select: 2, summary: 1 },
  "member-detail-page.tsx": { button: 5, summary: 1 },
  "member-label-controls.tsx": { button: 7, input: 4, select: 2, textarea: 1 },
  "module-access-grants.tsx": { button: 5 },
  "module-controls.tsx": { button: 8, input: 2 },
  "plugin-management.tsx": { button: 13, input: 5, select: 1 },
  "module-setup-workspace.tsx": { button: 10, input: 10, select: 2 },
  "pair-kiosk-dialog.tsx": { button: 6, input: 3 },
  "organization-settings.tsx": { button: 2, input: 4 },
  "page-walkthrough.tsx": { button: 10, summary: 1 },
  "report-leave-dialog.tsx": { button: 3 },
  "report-column-filter.tsx": { button: 2, input: 2, select: 1 },
  "report-result-table.tsx": { button: 9, input: 4, select: 1, summary: 1 },
  "reports-page.tsx": { button: 31, input: 12, select: 16, textarea: 1, summary: 5 },
  "roster-import-panel.tsx": { button: 7, input: 1, select: 1, textarea: 1 },
  "roster-page.tsx": { button: 17, input: 13, select: 2 },
  "scheduler-controls.tsx": { button: 2, summary: 1 },
  "settings-module-navigation.tsx": { button: 1 },
  "simulator-page.tsx": { button: 1, select: 2, summary: 1 },
  "update-indicator.tsx": { button: 3 },
  "update-channel-card.tsx": { button: 1, input: 1, select: 1 },
  "updates-page.tsx": { button: 1 },
  "user-settings.tsx": { button: 4, input: 6, select: 4, summary: 1 },
  "web-update-card.tsx": { button: 5, input: 1, summary: 2 },
  "web-update-setup.tsx": { button: 3, summary: 1 },
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
