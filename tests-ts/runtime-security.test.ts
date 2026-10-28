import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSessionCodec, createSignedStateCodec, hashPassword, verifyPassword } from "../apps/api/src/runtime-security.ts";

test("Worker password hashing uses salted scrypt", async () => {
  const first = await hashPassword("correct horse battery staple", new Uint8Array(16).fill(1));
  const second = await hashPassword("correct horse battery staple", new Uint8Array(16).fill(2));
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.match(first, /^scrypt\$32768\$8\$1\$/);
});

test("Worker sessions reject tampering and expiration", async () => {
  let clock = 0;
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const codec = createSessionCodec(secret, () => clock);
  const token = await codec.issue({ userId: "admin-1", role: "admin" }, 100);
  assert.deepEqual(await codec.verify(token), { userId: "admin-1", role: "admin", expiresAt: 100, authenticatedAt: 0 });
  assert.equal(await codec.verify(`${token}x`), undefined);
  clock = 101;
  assert.equal(await codec.verify(token), undefined);
});

test("purpose-bound signed state never verifies as a session, under another purpose, or after expiry", async () => {
  let clock = 0;
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const sessions = createSessionCodec(secret, () => clock);
  const calendar = createSignedStateCodec(secret, "google_calendar_oauth", () => clock);
  const state = await calendar.issue({ userId: "admin-1" }, 100);
  const verified = await calendar.verify(state);
  assert.equal(verified?.purpose, "google_calendar_oauth"); assert.equal(verified?.userId, "admin-1"); assert.equal(verified?.expiresAt, 100);
  assert.equal(await sessions.verify(state), undefined);
  assert.equal(await createSignedStateCodec(secret, "google_sign_in", () => clock).verify(state), undefined);
  assert.equal(await calendar.verify(await sessions.issue({ userId: "admin-1", role: "admin" })), undefined);
  assert.notEqual(await calendar.issue({ userId: "admin-1" }), await calendar.issue({ userId: "admin-1" }), "each state carries a nonce");
  // Even a purpose payload signed with the session key itself is refused as a session.
  const payload = Buffer.from(JSON.stringify({ purpose: "google_calendar_oauth", userId: "admin-1", role: "admin", expiresAt: 100 })).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url");
  assert.equal(await sessions.verify(`${payload}.${signature}`), undefined);
  clock = 101;
  assert.equal(await calendar.verify(state), undefined);
});

test("sessions carry the issuing epoch, and tokens without one remain valid as epoch 0", async () => {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const codec = createSessionCodec(secret, () => 0);
  assert.equal((await codec.verify(await codec.issue({ userId: "admin-1", role: "admin", epoch: 3 }, 100)))?.epoch, 3);
  assert.equal((await codec.verify(await codec.issue({ userId: "admin-1", role: "admin" }, 100)))?.epoch, undefined);
});
