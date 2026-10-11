import test from "node:test";
import assert from "node:assert/strict";
import { groupOutreachParticipation, loadOutreachPages, type OutreachParticipationEntry } from "../apps/dashboard/src/outreach-participation.ts";

const entry = (id: string, minutes: number, status: "counted" | "void" = "counted"): OutreachParticipationEntry => ({ id, memberId: "member-1", activityId: "activity-1", revision: 2, status, memberName: "Avery Synthetic", externalId: "SYN-001", serviceDate: "2026-10-09", startLocal: "09:00", endLocal: "10:00", durationMinutes: minutes, taskNotes: "Synthetic service", attribution: "self_asserted" });

test("activity member totals include current counted revisions but retain void submissions for review", () => {
  const entries = [entry("entry-3", 90), entry("entry-1", 15), entry("entry-2", 60, "void"), { ...entry("entry-4", 60, "void"), memberId: "member-2", memberName: "Blake Synthetic", externalId: "SYN-002" }];
  const groups = groupOutreachParticipation(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].minutes, 105);
  assert.equal(groups[0].counted, 2);
  assert.deepEqual(groups[0].entries.map((value) => value.id), ["entry-1", "entry-2", "entry-3"]);
  assert.equal(groups[1].minutes, 0);
  assert.equal(groups[1].counted, 0);
  assert.equal(groups[1].entries.length, 1);
  assert.equal(entries[0].id, "entry-3");
});

test("activity reads follow encoded cursors and retain the activity/status filters", async () => {
  const queries: string[] = []; const signal = new AbortController().signal;
  const entries = await loadOutreachPages<number>("/admin/hours/entries?activityId=activity-1&status=all&limit=100", async (query, readSignal) => {
    queries.push(query); assert.equal(readSignal, signal);
    return queries.length === 1 ? { items: [1], nextCursor: "entry&2" } : { items: [2], nextCursor: null };
  }, signal);
  assert.deepEqual(entries, [1, 2]);
  assert.deepEqual(queries, ["/admin/hours/entries?activityId=activity-1&status=all&limit=100", "/admin/hours/entries?activityId=activity-1&status=all&limit=100&after=entry%262"]);
});

test("an incomplete or cyclic page sequence never produces partial totals", async () => {
  await assert.rejects(loadOutreachPages("/entries", async () => ({ items: [1], nextCursor: "same" })), /could not be loaded completely/);
  let reads = 0;
  await assert.rejects(loadOutreachPages("/entries", async () => { if (++reads === 2) throw new Error("Connection unavailable"); return { items: [1], nextCursor: "next" }; }), /Connection unavailable/);
});
