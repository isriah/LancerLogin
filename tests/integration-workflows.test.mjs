import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationWorkflows } from "../apps/api/src/integration-workflows.mjs";

function fakeProviders() {
  const sent = []; const discordCalls = [];
  return { sent, discordCalls, resend: { send: async (message) => sent.push(message) }, discord: {
    postMissing: async (payload) => { discordCalls.push(["missing", payload]); return { id: "message-1" }; },
    upsertCalendar: async (payload) => { discordCalls.push(["calendar", payload]); return { id: payload.eventId ?? "event-1" }; },
    upsertStatus: async (payload) => { discordCalls.push(["status", payload]); return { id: payload.messageId ?? "status-1" }; },
  } };
}

test("email delivery is idempotent by meeting and member", async () => {
  const fake = fakeProviders(); const flows = createIntegrationWorkflows(fake);
  const member = { id: "m-1", email: "member@example.test" };
  assert.deepEqual(await flows.sendAbsenceEmail({ meetingId: "a", member }), { sent: true, duplicate: false });
  assert.deepEqual(await flows.sendAbsenceEmail({ meetingId: "a", member }), { sent: false, duplicate: true });
  assert.equal(fake.sent.length, 1);
});

test("Discord workflows use update mappings and controlled contests", async () => {
  const fake = fakeProviders(); const flows = createIntegrationWorkflows(fake);
  await flows.notifyMissingMembers({ meetingId: "a", members: [{ id: "m-1", discordUserId: "d-1" }] });
  assert.equal(flows.resolveContest({ meetingId: "a", memberId: "m-1", resolution: "approved" }).status, "approved");
  await flows.syncCalendar({ id: "meeting-1", title: "Practice" });
  await flows.syncCalendar({ id: "meeting-1", title: "Practice revised" });
  assert.equal(fake.discordCalls.filter(([kind]) => kind === "calendar")[1][1].eventId, "event-1");
});

test("kiosk status creates once and edits only when status changes", async () => {
  const fake = fakeProviders(); const flows = createIntegrationWorkflows(fake);
  assert.equal((await flows.updateKioskStatus({ name: "Front desk", online: true })).changed, true);
  assert.equal((await flows.updateKioskStatus({ name: "Front desk", online: true })).changed, false);
  assert.equal((await flows.updateKioskStatus({ name: "Front desk", online: false })).changed, true);
  assert.equal(fake.discordCalls.filter(([kind]) => kind === "status").length, 2);
});
