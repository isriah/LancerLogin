import test from "node:test";
import assert from "node:assert/strict";
import { createSecretVault, hashLocalPassword, resetLocalPassword, verifyLocalPassword } from "../apps/api/src/security.mjs";

test("local password hashes are salted, verified, and reset only through the local tool", async () => {
  const a = await hashLocalPassword("correct horse battery staple", () => Buffer.alloc(16, 1));
  const b = await hashLocalPassword("correct horse battery staple", () => Buffer.alloc(16, 2));
  assert.notEqual(a, b);
  assert.equal(await verifyLocalPassword("correct horse battery staple", a), true);
  assert.equal(await verifyLocalPassword("wrong password", a), false);
  await assert.rejects(() => resetLocalPassword({ adminToolAuthorized: false, password: "correct horse battery staple" }), /authorization/);
});

test("integration secrets are encrypted and status never discloses saved values", () => {
  const vault = createSecretVault(Buffer.alloc(32, 7));
  vault.save("resend", { apiKey: "private-value" }, () => Buffer.alloc(12, 3));
  assert.deepEqual(Object.keys(vault.status("resend")).sort(), ["configured", "updatedAt"]);
  assert.equal(JSON.stringify(vault.status("resend")).includes("private-value"), false);
  assert.deepEqual(vault.decryptForServer("resend"), { apiKey: "private-value" });
  assert.equal(vault.remove("resend"), true);
  assert.deepEqual(vault.status("resend"), { configured: false });
});
