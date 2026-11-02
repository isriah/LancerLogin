import test from "node:test";
import assert from "node:assert/strict";
import { parseRosterCsv } from "../apps/api/src/roster-import.mjs";

test("roster CSV accepts optional contact and Discord fields", () => {
  const result = parseRosterCsv("memberId,firstName,lastName,email,discordUserId\n1,Test Student,A,test-student-a@example.test,123456789012345678");
  assert.deepEqual(result, { rows: [{ memberId: "1", firstName: "Test Student", lastName: "A", email: "test-student-a@example.test", discordUserId: "123456789012345678" }], errors: [], warnings: [] });
});

test("invalid optional Discord IDs warn without blocking core roster rows", () => {
  const result = parseRosterCsv("memberId,firstName,lastName,email,discordUserId\n1,Test Student,A,test-student-a@example.test,bad");
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].discordUserId, undefined);
  assert.match(result.warnings[0].message, /ignored/);
});

test("roster CSV reports missing headers, row errors, and duplicates", () => {
  assert.match(parseRosterCsv("firstName,lastName\nTest Student,A").errors[0].message, /memberId/);
  const result = parseRosterCsv("memberId,firstName,lastName,email\n1,Test Student,A,bad\n1,Test Student,B,test-student-b@example.test\n2,,B,");
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.errors.map((error) => error.row), [2, 3, 4]);
});
