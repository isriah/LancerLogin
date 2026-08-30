import test from "node:test";
import assert from "node:assert/strict";
import { decryptIntegration, encryptIntegration } from "../apps/api/src/integration-crypto.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("integration configuration uses authenticated encryption and round-trips", async () => {
  const encrypted = await encryptIntegration({ apiKey: "secret-value", fromEmail: "hello@example.test" }, key);
  assert.equal(encrypted.ciphertext.includes("secret-value"), false);
  assert.equal(encrypted.iv.length, 16);
  assert.deepEqual(await decryptIntegration(encrypted.ciphertext, encrypted.iv, key), { apiKey: "secret-value", fromEmail: "hello@example.test" });
});

test("integration ciphertext rejects tampering", async () => {
  const encrypted = await encryptIntegration({ botToken: "secret" }, key);
  const changed = `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(() => decryptIntegration(changed, encrypted.iv, key));
});
