import test from "node:test";
import assert from "node:assert/strict";
import { hasUnmatchedRoleList, linkedSyncText, roleJobMaxFailures, roleJobPollDelay, roleJobStuck, roleJobStuckMs, splitBySync, unmatchedRoleUserCount } from "../apps/dashboard/src/discord-roles.ts";
import { saveInTwoSteps, type FirstWrite } from "../apps/dashboard/src/two-step-save.ts";

// What the dashboard says about when label changes reach Discord. A two-way label syncs on its own every 5 minutes;
// a Dashboard to Discord label, or a two-way one paused after a restore, waits for Sync to Discord. Synthetic labels only.
const manual = { labelName: "Test Label A", syncDirection: "to_discord" } as const;
const twoWay = { labelName: "Test Label B", syncDirection: "two_way" } as const;
const paused = { labelName: "Test Label C", syncDirection: "two_way", twoWayPaused: true } as const;

test("the Discord roles summary says how the linked labels sync", () => {
  assert.equal(linkedSyncText([manual]), "Label and pairing changes reach Discord only when you sync.");
  assert.equal(linkedSyncText([manual, paused, { labelName: "Older link" }]), "Label and pairing changes reach Discord only when you sync.");
  assert.equal(linkedSyncText([twoWay]), "Two-way labels sync automatically every 5 minutes, so their changes reach Discord without a manual sync.");
  assert.equal(linkedSyncText([manual, twoWay]), "Two-way labels sync automatically every 5 minutes. For the others, label and pairing changes reach Discord only when you sync.");
  assert.equal(linkedSyncText([twoWay, paused]), "Two-way labels sync automatically every 5 minutes. For the others, label and pairing changes reach Discord only when you sync.");
});

test("after label changes, only labels that wait for a manual sync are said to be out of date", () => {
  assert.deepEqual(splitBySync(["Test Label A", "Test Label B", "Test Label C"], [manual, twoWay, paused]), { automatic: ["Test Label B"], manual: ["Test Label A", "Test Label C"] });
  // Names match as the label lookup does, ignoring case.
  assert.deepEqual(splitBySync(["test label b"], [twoWay]), { automatic: ["test label b"], manual: [] });
  // When the role links can't be read, every label keeps the warning.
  assert.deepEqual(splitBySync(["Test Label B"], []), { automatic: [], manual: ["Test Label B"] });
});

test("Discord users not on the roster is offered only when a label syncs both ways, and counts every listed user", () => {
  // Only a two-way label's check records unmatched users, so with none the list could never have content.
  assert.equal(hasUnmatchedRoleList([]), false);
  assert.equal(hasUnmatchedRoleList([manual, { labelName: "Older link" }]), false);
  assert.equal(hasUnmatchedRoleList([manual, twoWay]), true);
  // A two-way label paused after a restore is stored as Dashboard to Discord, and its list was cleared.
  assert.equal(hasUnmatchedRoleList([{ labelName: "Test Label C", syncDirection: "to_discord", twoWayPaused: true }]), false);
  assert.equal(unmatchedRoleUserCount([]), 0);
  assert.equal(unmatchedRoleUserCount([{ users: [] }, { users: [] }]), 0);
  assert.equal(unmatchedRoleUserCount([{ users: ["test-user-a", "test-user-b"] }, { users: ["test-user-c"] }]), 3);
});

test("a role sync check that keeps failing backs off and then stops", () => {
  assert.equal(roleJobPollDelay(0), 4_000);
  assert.deepEqual([1, 2, 3, 4].map((failures) => roleJobPollDelay(failures)), [8_000, 16_000, 32_000, 60_000]);
  assert.equal(roleJobMaxFailures, 5);
  assert.equal(roleJobPollDelay(5), undefined);
  assert.equal(roleJobPollDelay(9), undefined);
  // A sync that answers but makes no progress (a rate limit, paused delivery) is checked less often, not dropped.
  assert.equal(roleJobPollDelay(0, 9), 4_000);
  assert.equal(roleJobPollDelay(0, 10), 30_000);
});

test("a save of two writes resumes with the second when only the second failed", async () => {
  const calls: string[] = []; let failSecond = true;
  const done: FirstWrite = {};
  const first = async () => { calls.push("first"); };
  const second = async () => { calls.push("second"); if (failSecond) throw new Error("Attendance settings changed."); };
  const partial = (message: string) => `Test Student A was added to the roster, but the attendance start date was not saved: ${message}`;
  await assert.rejects(saveInTwoSteps(done, "member-a", first, second, partial), { message: "Test Student A was added to the roster, but the attendance start date was not saved: Attendance settings changed." });
  assert.equal(done.current, "member-a");
  // The retry sends only the second write.
  failSecond = false;
  await saveInTwoSteps(done, "member-a", first, second, partial);
  assert.deepEqual(calls, ["first", "second", "second"]);
  assert.equal(done.current, undefined, "a finished save remembers nothing");

  // A failed first write is reported as it is and remembered as not done.
  await assert.rejects(saveInTwoSteps(done, "member-b", async () => { throw new Error("Member ID is required"); }, second, partial), { message: "Member ID is required" });
  assert.equal(done.current, undefined);
  // Changed details after a partial save are sent again; no second write is fine too.
  calls.length = 0; failSecond = true;
  await assert.rejects(saveInTwoSteps(done, "member-c", first, second, partial));
  await saveInTwoSteps(done, "member-c-renamed", first, undefined, partial);
  assert.deepEqual(calls, ["first", "second", "first"]);
});

test("a pending or running role sync is called stuck only when it has gone 15 minutes without progress", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z"); const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const job = (fields: Partial<Parameters<typeof roleJobStuck>[0]>) => ({ status: "pending", createdAt: ago(20), updatedAt: ago(0), total: 10, completed: 0, failed: 0, ...fields });
  assert.equal(roleJobStuckMs, 15 * 60_000);
  // Claimed again and again (updated just now) with nobody changed: the stall seen with three two-way labels.
  assert.equal(roleJobStuck(job({}), now), true);
  assert.equal(roleJobStuck(job({ status: "running" }), now), true);
  // Younger than 15 minutes, or moving: not stuck.
  assert.equal(roleJobStuck(job({ createdAt: ago(14) }), now), false);
  assert.equal(roleJobStuck(job({ completed: 3 }), now), false);
  assert.equal(roleJobStuck(job({ failed: 1 }), now), false, "failures are progress too; they show once the job ends");
  // Some members done, then nothing touched it for 15 minutes.
  assert.equal(roleJobStuck(job({ completed: 3, updatedAt: ago(16) }), now), true);
  // Without counts (an older API), only the last update can tell.
  assert.equal(roleJobStuck({ status: "pending", createdAt: ago(60), updatedAt: ago(1) }, now), false);
  assert.equal(roleJobStuck({ status: "pending", createdAt: ago(60), updatedAt: ago(30) }, now), true);
  // A finished job is never stuck.
  for (const status of ["completed", "partial", "stale"]) assert.equal(roleJobStuck(job({ status }), now), false, status);
});
