import test from "node:test";
import assert from "node:assert/strict";
import { createSessionCodec, hashPassword, verifyPassword } from "../apps/api/src/runtime-security.ts";

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
  assert.deepEqual(await codec.verify(token), { userId: "admin-1", role: "admin", expiresAt: 100 });
  assert.equal(await codec.verify(`${token}x`), undefined);
  clock = 101;
  assert.equal(await codec.verify(token), undefined);
});
