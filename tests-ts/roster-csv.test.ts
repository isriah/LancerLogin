import test from "node:test";
import assert from "node:assert/strict";
import { mapRosterHeader, normaliseRosterHeader, parseRosterText, rosterFieldFor, rosterTemplateCsv } from "../apps/dashboard/src/roster-csv.ts";

test("roster headers normalise case, spaces, underscores, hyphens and dots", () => {
  assert.equal(normaliseRosterHeader(" Member_ID "), "memberid");
  assert.equal(normaliseRosterHeader("E-mail.Address"), "emailaddress");
  for (const header of ["memberId", "Member ID", "member_id", "MEMBER-ID", "id", "Student ID", "member"]) assert.equal(rosterFieldFor(header), "memberId", header);
  for (const header of ["firstName", "First Name", "first", "Given name"]) assert.equal(rosterFieldFor(header), "firstName", header);
  for (const header of ["lastName", "Last name", "last", "Surname", "family_name"]) assert.equal(rosterFieldFor(header), "lastName", header);
  for (const header of ["email", "Email Address", "mail", "e.mail"]) assert.equal(rosterFieldFor(header), "email", header);
  for (const header of ["discordUserId", "Discord user ID", "discord_id", "Discord"]) assert.equal(rosterFieldFor(header), "discordUserId", header);
  assert.equal(rosterFieldFor("Grade"), undefined);
});

test("header mapping lists recognised fields in file order and ignores unknown columns", () => {
  const result = mapRosterHeader(["Member ID", "First Name", "Surname", "Grade", "Email", "Phone", ""]);
  assert.deepEqual(result.columns, ["memberId", "firstName", "lastName", undefined, "email", undefined, undefined]);
  assert.deepEqual(result.recognised, ["memberId", "firstName", "lastName", "email"]);
  assert.deepEqual(result.ignored, ["Grade", "Phone"]);
  assert.deepEqual(result.errors, []);
});

test("header mapping names each missing required column and both duplicate columns", () => {
  assert.deepEqual(mapRosterHeader(["firstName", "Email"]).errors, ["Missing column: Member ID", "Missing column: Last name"]);
  const duplicate = mapRosterHeader(["Member ID", "id", "First", "Last"]);
  assert.deepEqual(duplicate.errors, ['Columns "Member ID" and "id" both match Member ID. Keep only one.']);
  assert.deepEqual(duplicate.columns, ["memberId", undefined, "firstName", "lastName"]);
});

test("comma CSV with friendly headers maps rows to roster records", () => {
  const result = parseRosterText('﻿Member ID,First Name,Surname,Grade\r\n9001,"Test, Jr.",Student,11\r\n');
  assert.equal(result.hasHeader, true);
  assert.deepEqual(result.ignored, ["Grade"]);
  assert.deepEqual(result.rows, [{ rowNumber: 2, member: { memberId: "9001", firstName: "Test, Jr.", lastName: "Student" } }]);
});

test("existing camelCase headers keep working", () => {
  const result = parseRosterText("memberId,firstName,lastName,email,discordUserId\n9002,Test,Person,test.person@example.test,123456789012345678");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0].member, { memberId: "9002", firstName: "Test", lastName: "Person", email: "test.person@example.test", discordUserId: "123456789012345678" });
});

test("tab-separated pastes detect a friendly header row", () => {
  const result = parseRosterText("Member ID\tFirst name\tLast name\n9003\tTest\tStudent");
  assert.equal(result.hasHeader, true);
  assert.deepEqual(result.recognised, ["memberId", "firstName", "lastName"]);
  assert.deepEqual(result.rows, [{ rowNumber: 2, member: { memberId: "9003", firstName: "Test", lastName: "Student" } }]);
  assert.deepEqual(parseRosterText("first_name\tsurname\nTest\tStudent").errors, ["Missing column: Member ID"]);
});

test("tab-separated rows without a header follow the template order", () => {
  const result = parseRosterText("9004\tTest\tStudent\ttest.a@example.test\n9005\tTest\tStudent B");
  assert.equal(result.hasHeader, false);
  assert.deepEqual(result.recognised, ["memberId", "firstName", "lastName", "email"]);
  assert.deepEqual(result.rows.map((row) => [row.rowNumber, row.member.memberId, row.member.lastName, row.member.email]), [[1, "9004", "Student", "test.a@example.test"], [2, "9005", "Student B", ""]]);
  assert.match(parseRosterText("9006\tTest").errors[0], /^Row 1 needs three to five tab-separated columns in this order: Member ID, First name, Last name, Email, Discord user ID\.$/);
});

test("the template parses back to one valid example row", () => {
  assert.equal(rosterTemplateCsv, "Member ID,First name,Last name,Email,Discord user ID\n9001,Test,Student,test.student@example.test,\n");
  const result = parseRosterText(rosterTemplateCsv);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.rows[0].member, { memberId: "9001", firstName: "Test", lastName: "Student", email: "test.student@example.test", discordUserId: "" });
});
