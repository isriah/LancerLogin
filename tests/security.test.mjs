import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSecretVault, createSessionSigner, hashLocalPassword, resetLocalPassword, verifyLocalPassword } from "../apps/api/src/security.mjs";

test("local password hashes are salted, verified, and reset only through the local tool", async () => {
  const a = await hashLocalPassword("correct horse battery staple", () => Buffer.alloc(16, 1));
  const b = await hashLocalPassword("correct horse battery staple", () => Buffer.alloc(16, 2));
  assert.notEqual(a, b);
  assert.equal(await verifyLocalPassword("correct horse battery staple", a), true);
  assert.equal(await verifyLocalPassword("wrong password", a), false);
  await assert.rejects(() => resetLocalPassword({ adminToolAuthorized: false, password: "correct horse battery staple" }), /authorization/);
});

test("local sessions are signed, expiring, and reject tampering", () => {
  let clock = 0; const signer = createSessionSigner(Buffer.alloc(32, 9), { now: () => clock, ttlMs: 100 });
  const token = signer.issue({ userId: "admin-1", role: "admin" });
  assert.deepEqual(signer.verify(token), { userId: "admin-1", role: "admin" });
  assert.equal(signer.verify(`${token}tampered`), undefined);
  clock = 101;
  assert.equal(signer.verify(token), undefined);
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

test("local recovery tool requires hidden interactive input and adopter D1 authorization", async () => {
  const tool = await readFile("scripts/reset-local-password.mjs", "utf8");
  const guide = await readFile("docs/LOCAL-RECOVERY.md", "utf8");
  assert.match(tool, /isTTY/);
  assert.match(tool, /setRawMode/);
  assert.match(tool, /wrangler.*d1.*execute/s);
  assert.match(tool, /selectCloudflareAccount/);
  assert.match(tool, /CLOUDFLARE_ACCOUNT_ID: accountId/);
  assert.match(tool, /failed_login_count = 0, locked_until = NULL/);
  assert.doesNotMatch(tool, /--password/);
  assert.match(guide, /CLOUDFLARE_API_TOKEN/);
  assert.match(guide, /Account Settings read/);
  assert.match(guide, /passwords_reset: 1/);
});
