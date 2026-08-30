import test from "node:test";
import assert from "node:assert/strict";
import { createPairingService } from "../apps/api/src/pairing-service.mjs";

test("only an Admin can create a short-lived pairing code", () => {
  const service = createPairingService({ now: () => 0, random: () => Buffer.from("123456789") });
  assert.throws(() => service.create({ userId: "operator", role: "operator" }), /Forbidden/);
  const issued = service.create({ userId: "admin", role: "admin" });
  assert.equal(issued.code.length > 0, true);
  assert.equal(service.status().active, true);
});

test("pairing redemption is hashed, one-time, and expires", () => {
  let clock = 0; let value = 1; const service = createPairingService({ now: () => clock, ttlMs: 10, random: () => Buffer.alloc(9, value++) });
  const issued = service.create({ userId: "admin", role: "admin" });
  assert.deepEqual(service.redeem("wrong"), { ok: false });
  assert.deepEqual(service.redeem(issued.code), { ok: true, pairedBy: "admin" });
  assert.deepEqual(service.redeem(issued.code), { ok: false });
  service.create({ userId: "admin", role: "admin" }); clock = 10;
  assert.deepEqual(service.redeem(issued.code), { ok: false });
});
