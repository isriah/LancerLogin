import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// member-labels.tsx has no JSX or imports; Node strip-types only loads .ts, so import a temporary .ts copy.
const directory = mkdtempSync(join(tmpdir(), "lancerlogin-member-labels-"));
copyFileSync("apps/dashboard/src/member-labels.tsx", join(directory, "member-labels.ts"));
const { labelChangesTemplateCsv, normaliseLabelHeader, parseLabelChangesCsv } = await import(pathToFileURL(join(directory, "member-labels.ts")).href) as typeof import("../apps/dashboard/src/member-labels.tsx");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("label CSV headers ignore case, spaces, underscores, hyphens and dots", () => {
  assert.equal(normaliseLabelHeader(" Member_ID "), "memberid");
  assert.equal(normaliseLabelHeader("Effective.Date"), "effectivedate");
  assert.deepEqual(parseLabelChangesCsv("MEMBER-ID,Label,ACTION,effective_date\nTEST-001,Build Team,Remove,2026-09-01\n"), [{ memberId: "TEST-001", label: "Build Team", action: "remove", effectiveDate: "2026-09-01" }]);
  assert.deepEqual(parseLabelChangesCsv("﻿member.id, label \nTEST-002,Test Label"), [{ memberId: "TEST-002", label: "Test Label", action: "add", effectiveDate: "" }]);
});

test("label CSV accepts header aliases and ignores unknown columns", () => {
  for (const [member, label, date] of [["id", "Label name", "Date"], ["Student ID", "label_name", "Effective"], ["member id", "LABEL", "Effective date"]]) {
    assert.deepEqual(parseLabelChangesCsv(`Notes,${member},${label},${date}\nignored,TEST-003,Build Team,2026-10-01\n`), [{ memberId: "TEST-003", label: "Build Team", action: "add", effectiveDate: "2026-10-01" }], member);
  }
});

test("label CSV defaults blank action and date and keeps the camelCase template", () => {
  assert.equal(labelChangesTemplateCsv.split("\n")[0], "memberId,label,action,effectiveDate");
  assert.deepEqual(parseLabelChangesCsv(labelChangesTemplateCsv), [{ memberId: "TEST-001", label: "Build Team", action: "add", effectiveDate: "" }]);
  assert.deepEqual(parseLabelChangesCsv("memberId,label,action,effectiveDate\nTEST-004,\"Team, Test\",,\n"), [{ memberId: "TEST-004", label: "Team, Test", action: "add", effectiveDate: "" }]);
});

test("label CSV reports missing columns, duplicates, bad rows and row limits", () => {
  assert.throws(() => parseLabelChangesCsv("name,label\nTest Student A,Build Team"), /must include member ID and label columns/);
  assert.throws(() => parseLabelChangesCsv(""), /must include member ID and label columns/);
  assert.throws(() => parseLabelChangesCsv("Member ID,id,label\nTEST-001,TEST-002,Build Team"), /Columns "Member ID" and "id" both match memberId/);
  assert.throws(() => parseLabelChangesCsv("memberId,label\n"), /1 to 500 changes/);
  assert.throws(() => parseLabelChangesCsv("memberId,label,action\nTEST-001,Build Team,toggle"), /CSV row 2 needs/);
  assert.throws(() => parseLabelChangesCsv("memberId,label,date\nTEST-001,Build Team,09/01/2026"), /CSV row 2 needs/);
  assert.throws(() => parseLabelChangesCsv("memberId,label\nTEST-001,"), /CSV row 2 needs/);
  assert.throws(() => parseLabelChangesCsv("memberId,label\n\"TEST-001,Build Team"), /unclosed quoted value/);
});
