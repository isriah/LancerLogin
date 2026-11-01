import test from "node:test";
import assert from "node:assert/strict";
import { hashSettingsPin, settingsPinIterations, validSettingsPin, verifySettingsPin } from "../apps/dashboard/src/web-kiosk/settings-pin.ts";

test("settings PINs are 6 to 12 digits", () => {
  assert.equal(validSettingsPin("123456"), true);
  assert.equal(validSettingsPin("123456789012"), true);
  assert.equal(validSettingsPin("12345"), false);
  assert.equal(validSettingsPin("1234567890123"), false);
  assert.equal(validSettingsPin("12345a"), false);
});

test("the settings PIN is stored as a salted PBKDF2-SHA256 hash with 100,000 iterations", async () => {
  const stored = await hashSettingsPin("246810");
  assert.equal(stored.iterations, settingsPinIterations);
  assert.equal(settingsPinIterations, 100_000);
  assert.equal(Buffer.from(stored.salt, "base64").length, 16);
  assert.equal(Buffer.from(stored.hash, "base64").length, 32);
  assert.doesNotMatch(JSON.stringify(stored), /246810/);
  assert.equal(await verifySettingsPin("246810", stored), true);
  assert.equal(await verifySettingsPin("246811", stored), false);
  const again = await hashSettingsPin("246810");
  assert.notEqual(again.salt, stored.salt, "every hash gets a new salt");
  assert.notEqual(again.hash, stored.hash);
});

test("the hash matches an independent PBKDF2 computation", async () => {
  const { pbkdf2Sync } = await import("node:crypto");
  const stored = await hashSettingsPin("13579246", { iterations: 1_000 });
  const expected = pbkdf2Sync("13579246", Buffer.from(stored.salt, "base64"), 1_000, 32, "sha256").toString("base64");
  assert.equal(stored.hash, expected);
  assert.equal(await verifySettingsPin("13579246", stored), true);
});

test("malformed PINs and stored hashes never verify", async () => {
  const stored = await hashSettingsPin("123456", { iterations: 1_000 });
  assert.equal(await verifySettingsPin("12345", stored), false);
  assert.equal(await verifySettingsPin("123456", { ...stored, iterations: 0 }), false);
  assert.equal(await verifySettingsPin("123456", { ...stored, hash: "" }), false);
  await assert.rejects(hashSettingsPin("12ab56"), /6 to 12 digits/);
});
