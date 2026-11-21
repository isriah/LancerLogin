// Roster CSV import: Email and Discord user ID change only to a value the file gives. A missing column, a blank cell or an
// invalid Discord user ID keeps the stored value, and the dashboard preview (rosterImportPreviewRow) shows what the server
// stores. Real SQLite through the Worker, with the dashboard's own parser building each request.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { importedRosterMember, parseRosterText, rosterImportPreviewRow, type StoredRosterMember } from "../apps/dashboard/src/roster-csv.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";

type Listed = StoredRosterMember & { memberId: string };
const discordId = (index: number) => String(100000000000000000n + BigInt(index));
const email = (index: number) => `test-student-${index}@example.test`;

function linkedRoster(db: BackupDatabase, count: number) {
  const insert = db.raw.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at) VALUES (?, 'primary', ?, 'Test Student', ?, ?, ?, 1, '2026-01-01')");
  for (let index = 0; index < count; index += 1) insert.run(`linked-${index}`, `T-${index}`, `L${index}`, email(index), discordId(index));
}

async function roster(client: ReturnType<typeof backupClient>) {
  const result = await client.call("/admin/members"); assert.equal(result.status, 200);
  return new Map(((await result.json()) as { members: Listed[] }).members.map((member) => [member.memberId, member]));
}

/** Preview a CSV as the dashboard does, import it, and check every preview row against what the server stored. */
async function importCsv(client: ReturnType<typeof backupClient>, csv: string, mode: "merge" | "replace" = "merge") {
  const parsed = parseRosterText(csv); assert.deepEqual(parsed.errors, []);
  const members = parsed.rows.map(({ member }) => importedRosterMember(member));
  const before = await roster(client);
  const preview = members.map((member) => rosterImportPreviewRow(before.get(member.memberId), member));
  const result = await client.call("/admin/members", { members, mode });
  assert.equal(result.status, 201, await result.clone().text());
  const after = await roster(client);
  for (const row of preview) {
    const stored = after.get(row.memberId)!; const previous = before.get(row.memberId);
    assert.deepEqual({ firstName: row.firstName, lastName: row.lastName, email: row.email ?? null, discordUserId: row.discordUserId ?? null }, { firstName: stored.firstName, lastName: stored.lastName, email: stored.email ?? null, discordUserId: stored.discordUserId ?? null }, `preview of ${row.memberId} matches what was stored`);
    const same = previous && previous.firstName === stored.firstName && previous.lastName === stored.lastName && previous.email === stored.email && previous.discordUserId === stored.discordUserId && Boolean(previous.active);
    assert.equal(row.status, !previous ? "Add" : same ? "Unchanged" : "Update", `preview status of ${row.memberId}`);
  }
  return { preview: new Map(preview.map((row) => [row.memberId, row])), after };
}

test("re-importing 40 linked members from a CSV without a Discord column keeps every link", async () => {
  const db = new BackupDatabase(); linkedRoster(db, 40);
  const csv = ["Member ID,First Name,Last Name,Email", ...Array.from({ length: 40 }, (_, index) => `T-${index},Test Student,L${index},${email(index)}`)].join("\n");
  const { preview } = await importCsv(backupClient(worker, db), csv);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM members WHERE external_id LIKE 'T-%' AND discord_user_id IS NOT NULL"), 40);
  for (let index = 0; index < 40; index += 1) assert.equal(db.rows<{ d: string }>("SELECT discord_user_id AS d FROM members WHERE external_id = ?", `T-${index}`)[0].d, discordId(index));
  assert.ok([...preview.values()].every((row) => row.status === "Unchanged"), "the preview shows no change");
});

test("a CSV without an Email column keeps every stored email", async () => {
  const db = new BackupDatabase(); linkedRoster(db, 2);
  const { after, preview } = await importCsv(backupClient(worker, db), "Member ID,First Name,Last Name,Discord user ID\nT-0,Test Student,L0,\nT-1,Test Student,L1,\n");
  assert.equal(after.get("T-0")!.email, email(0)); assert.equal(after.get("T-1")!.email, email(1));
  assert.equal(after.get("T-0")!.discordUserId, discordId(0));
  assert.equal(preview.get("T-0")!.status, "Unchanged");
});

test("blank Email and Discord cells keep the stored values; new values replace them", async () => {
  const db = new BackupDatabase(); linkedRoster(db, 4);
  const csv = [
    "Member ID,First Name,Last Name,Email,Discord user ID",
    "T-0,Test Student,L0,,", // both blank: kept
    `T-1,Test Student,L1,New.Address@Example.TEST,${discordId(901)}`, // both new: replaced (email stored lower-case)
    `T-2,Renamed Student,L2,,${discordId(902)}`, // blank email kept, new Discord, new first name
    "T-3,Test Student,L3,,not-a-discord-id", // invalid Discord ignored: kept
    "N-1,Test Student,New,,", // new member with blanks: stored empty
  ].join("\n");
  const parsed = parseRosterText(csv);
  assert.equal(parsed.rows[0].member.email, "", "a blank cell reaches the dashboard as an empty string");
  const { after, preview } = await importCsv(backupClient(worker, db), csv);
  assert.deepEqual([after.get("T-0")!.email, after.get("T-0")!.discordUserId], [email(0), discordId(0)]);
  assert.equal(preview.get("T-0")!.status, "Unchanged");
  assert.deepEqual([after.get("T-1")!.email, after.get("T-1")!.discordUserId], ["new.address@example.test", discordId(901)]);
  assert.equal(preview.get("T-1")!.status, "Update");
  assert.deepEqual([after.get("T-2")!.firstName, after.get("T-2")!.email, after.get("T-2")!.discordUserId], ["Renamed Student", email(2), discordId(902)]);
  assert.deepEqual([after.get("T-3")!.email, after.get("T-3")!.discordUserId], [email(3), discordId(3)]);
  assert.equal(preview.get("T-3")!.status, "Unchanged");
  assert.deepEqual([after.get("N-1")!.email, after.get("N-1")!.discordUserId], [null, null]);
  assert.equal(preview.get("N-1")!.status, "Add");
});

test("the server keeps stored values for missing, empty and null fields from any client", async () => {
  const db = new BackupDatabase(); linkedRoster(db, 3);
  const client = backupClient(worker, db);
  const result = await client.call("/admin/members", { members: [
    { memberId: "T-0", firstName: "Test Student", lastName: "L0" },
    { memberId: "T-1", firstName: "Test Student", lastName: "L1", email: "", discordUserId: "" },
    { memberId: "T-2", firstName: "Test Student", lastName: "L2", email: null, discordUserId: null },
  ] });
  assert.equal(result.status, 201);
  assert.deepEqual(db.rows("SELECT external_id AS id, email, discord_user_id AS discord FROM members WHERE external_id LIKE 'T-%' ORDER BY external_id"), [0, 1, 2].map((index) => ({ id: `T-${index}`, email: email(index), discord: discordId(index) })));
});

test("replace mode keeps stored email and Discord links for rows without them and reactivates as before", async () => {
  const db = new BackupDatabase(); linkedRoster(db, 3);
  db.raw.exec("UPDATE members SET active = 0 WHERE external_id = 'T-1'");
  const { after, preview } = await importCsv(backupClient(worker, db), "Member ID,First Name,Last Name\nT-0,Test Student,L0\nT-1,Test Student,L1\n", "replace");
  assert.deepEqual([after.get("T-0")!.discordUserId, after.get("T-1")!.discordUserId, after.get("T-1")!.email], [discordId(0), discordId(1), email(1)]);
  assert.equal(preview.get("T-0")!.status, "Unchanged"); assert.equal(preview.get("T-1")!.status, "Update");
  assert.equal(Boolean(after.get("T-1")!.active), true); assert.equal(Boolean(after.get("T-2")!.active), false);
  assert.equal(after.get("T-2")!.discordUserId, discordId(2), "a deactivated member keeps their link");
});
