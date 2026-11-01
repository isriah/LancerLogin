import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findMemberById, membersUseNumericIds, searchMembers } from "../packages/shared/src/member-lookup.mjs";
import { formatPairingCode, generateWebPairingCode, normalizePairingCode, pairingCodeAlphabet, validWebPairingCode } from "../packages/shared/src/pairing-code.mjs";

const roster = [
  { memberId: "1001", firstName: "Test Student", lastName: "A", email: "test.student.a@example.test" },
  { memberId: "1002", firstName: "Test Student", lastName: "B", email: "test.student.b@example.test" },
  { memberId: "2010", firstName: "Avery", lastName: "Sample", email: "avery.sample@example.test" },
  { memberId: "2011", firstName: "Blake", lastName: "Avery", email: "blake@example.test" },
];

test("member ID entry: numeric keypad only when every ID is a number, and exact matches", () => {
  assert.equal(membersUseNumericIds(roster), true);
  assert.equal(membersUseNumericIds([...roster, { memberId: "R-7", firstName: "Test", lastName: "C" }]), false);
  assert.equal(membersUseNumericIds([]), false);
  assert.equal(findMemberById(roster, " 1002 ")?.lastName, "B");
  assert.equal(findMemberById([{ memberId: "R-7", firstName: "T", lastName: "C" }], "r-7")?.memberId, "R-7");
  assert.equal(findMemberById(roster, "100"), undefined);
  assert.equal(findMemberById(roster, ""), undefined);
});

test("member search matches names, IDs and emails, ranks the best first, and never returns email", () => {
  // Both start with "avery"; ties go by last name, so Blake Avery comes before Avery Sample.
  assert.deepEqual(searchMembers(roster, "avery").map((member) => member.memberId), ["2011", "2010"]);
  assert.deepEqual(searchMembers(roster, "2011").map((member) => member.memberId), ["2011"]);
  assert.deepEqual(searchMembers(roster, "test st b").map((member) => member.memberId), ["1002"]);
  assert.deepEqual(searchMembers(roster, "blake@").map((member) => member.memberId), ["2011"]);
  assert.deepEqual(searchMembers(roster, "  "), []);
  assert.ok(searchMembers(roster, "test").every((member) => !("email" in member)));
  const many = Array.from({ length: 10 }, (_, index) => ({ memberId: String(3000 + index), firstName: "Test", lastName: `Member ${index}` }));
  assert.equal(searchMembers(many, "test").length, 6);
  assert.equal(searchMembers(many, "test", { limit: 3 }).length, 3);
});

test("web pairing codes: normalized, validated, formatted and generated without look-alike characters", () => {
  assert.equal(normalizePairingCode(" k7q2-m9xd "), "K7Q2M9XD");
  assert.equal(validWebPairingCode("k7q2-m9xd"), true);
  assert.equal(validWebPairingCode("K7Q2M9X0"), false);
  assert.equal(validWebPairingCode("K7Q2M9X"), false);
  assert.equal(formatPairingCode("k7q2m9xd"), "K7Q2-M9XD");
  for (const excluded of ["0", "O", "1", "I"]) assert.equal(pairingCodeAlphabet.includes(excluded), false);
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const code = generateWebPairingCode(randomBytes);
    assert.equal(validWebPairingCode(code), true, code);
    for (const character of code) seen.add(character);
  }
  assert.equal(seen.size, pairingCodeAlphabet.length, "every character appears");
  // 32 characters divide 256 evenly, so every byte maps straight to a character: 255 is "9", 7 is "H".
  assert.equal(generateWebPairingCode((count) => new Uint8Array(count).map((_, index) => index ? 7 : 255)), "9HHHHHHH");
});
