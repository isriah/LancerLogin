import test from "node:test";
import assert from "node:assert/strict";
import { createD1Repository } from "../apps/api/src/d1-repository.mjs";

function fakeD1() {
  const calls = [];
  return { calls, prepare(sql) { return { bind(...values) { return { async all() { calls.push({ sql, values, kind: "all" }); return { results: [{ id: "m-1", externalId: "1" }] }; }, async run() { calls.push({ sql, values, kind: "run" }); return { success: true }; } }; } }; } };
}

test("repository scopes every member query to its installation", async () => {
  const db = fakeD1(); const repo = createD1Repository(db, "install-a");
  assert.deepEqual(await repo.listMembers(), [{ id: "m-1", externalId: "1" }]);
  assert.equal(db.calls[0].values[0], "install-a");
  assert.match(db.calls[0].sql, /WHERE installation_id = \?/);
});

test("repository writes member and audit records with tenant scope", async () => {
  const db = fakeD1(); const repo = createD1Repository(db, "install-a");
  await repo.insertMember({ id: "m-1", externalId: "1", firstName: "Ada", lastName: "Lovelace", createdAt: "2026-01-01T00:00:00Z" });
  await repo.recordAudit({ id: "audit-1", action: "member.created", targetType: "member", targetId: "m-1", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(db.calls[0].values[1], "install-a");
  assert.equal(db.calls[1].values[1], "install-a");
  assert.equal(db.calls[1].values[6], "{}");
});
