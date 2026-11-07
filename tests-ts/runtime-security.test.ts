import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHash } from "node:crypto";
import { createSessionCodec, createSignedStateCodec, fakePasswordSalt, parsePasswordKey, passwordFormat, passwordHashFromCredential, storedPasswordSalt, verifyLegacyPassword, verifyPasswordKey } from "../apps/api/src/runtime-security.ts";
import { clientPasswordHash, constantTimeEqual, decodeBase64Url, encodeBase64Url, parsePasswordHash, passwordVerifierLabel } from "../packages/shared/src/password-hash.mjs";
import { derivePasswordKey, newPasswordCredential, passwordProof } from "../packages/shared/src/password-key.mjs";

// Known answer: what the Worker's own scrypt wrote before server relief, for this password and a salt of sixteen 0x01
// bytes (hashPassword on origin/main at 7a465b93). The browser, the scripts and the Worker's legacy path must all agree.
const knownPassword = "correct horse battery staple";
const knownSalt = new Uint8Array(16).fill(1);
const knownLegacyRow = "scrypt$32768$8$1$AQEBAQEBAQEBAQEBAQEBAQ$IFdK3Vz60pX0K9XA3OdzWkl1cNBPYBtHHZ6y-_JLnSU";

test("the shared client derivation matches the Worker's legacy scrypt byte for byte", async () => {
  const key = await derivePasswordKey(knownPassword, knownSalt);
  assert.equal(`scrypt$32768$8$1$${encodeBase64Url(knownSalt)}$${encodeBase64Url(key)}`, knownLegacyRow);
  assert.equal(await verifyLegacyPassword(knownPassword, knownLegacyRow), true);
  assert.equal(await verifyLegacyPassword("incorrect password", knownLegacyRow), false);
  assert.equal(await verifyLegacyPassword("", knownLegacyRow), false);
});

test("client and server agree on the stored scrypt-c value", async () => {
  const key = await derivePasswordKey(knownPassword, knownSalt);
  const expectedVerifier = createHash("sha256").update(passwordVerifierLabel).update(key).digest("base64url");
  const stored = await clientPasswordHash(knownSalt, key);
  assert.equal(stored, `scrypt-c$32768$8$1$AQEBAQEBAQEBAQEBAQEBAQ$${expectedVerifier}`);
  // The Worker builds the same row from what the browser sends when a password is set.
  assert.equal(await passwordHashFromCredential({ salt: encodeBase64Url(knownSalt), key: encodeBase64Url(key) }), stored);
  assert.equal(passwordFormat(stored), "scrypt-c");
  assert.equal(storedPasswordSalt(stored), encodeBase64Url(knownSalt));
  assert.equal(await verifyPasswordKey(key, stored), true);
  assert.equal(await verifyPasswordKey(await derivePasswordKey("incorrect password", knownSalt), stored), false);
  // K itself is never stored: the row doesn't contain it and a legacy row's K does not verify as a scrypt-c verifier.
  assert.equal(stored.includes(encodeBase64Url(key)), false);
  assert.equal(await verifyPasswordKey(key, knownLegacyRow), false, "a legacy row only signs in through the password check");
  // A fresh credential from the shared helper round-trips through the Worker.
  const credential = await newPasswordCredential(knownPassword);
  const fresh = (await passwordHashFromCredential(credential))!;
  assert.equal(await verifyPasswordKey(await derivePasswordKey(knownPassword, decodeBase64Url(credential.salt)!), fresh), true);
  const proof = await passwordProof(knownPassword, { algorithm: "scrypt", N: 32768, r: 8, p: 1, dkLen: 32, salt: storedPasswordSalt(fresh)!, legacy: false });
  assert.deepEqual(Object.keys(proof), ["key"], "a scrypt-c sign-in never sends the password");
  assert.equal(await verifyPasswordKey(parsePasswordKey(proof.key)!, fresh), true);
  const legacyProof = await passwordProof(knownPassword, { algorithm: "scrypt", N: 32768, r: 8, p: 1, dkLen: 32, salt: credential.salt, legacy: true });
  assert.deepEqual(legacyProof, { key: credential.key, salt: credential.salt, password: knownPassword });
});

test("the Worker accepts exactly the production parameters, 32-byte keys and 16-byte salts", async () => {
  const key = await derivePasswordKey(knownPassword, knownSalt);
  const stored = await clientPasswordHash(knownSalt, key);
  const [, , , , salt, verifier] = stored.split("$");
  for (const malformed of [
    `scrypt-c$16384$8$1$${salt}$${verifier}`, `scrypt-c$32768$4$1$${salt}$${verifier}`, `scrypt-c$32768$8$2$${salt}$${verifier}`,
    `scrypt-c$32768$8$1$${salt}$${verifier}$extra`, `scrypt-c$32768$8$1$$${verifier}`, `scrypt-c$32768$8$1$${salt}$`,
    `scrypt-c$32768$8$1$${salt}$${verifier.slice(0, -2)}`, `scrypt-c$32768$8$1$AQEBAQEBAQEBAQEBAQE$${verifier}`, `scrypt-c$32768$8$1$${salt}$${verifier}=`,
    `argon2$32768$8$1$${salt}$${verifier}`, "", "hash", "synthetic-retained-password-hash",
  ]) {
    assert.equal(parsePasswordHash(malformed), undefined, malformed);
    assert.equal(passwordFormat(malformed), undefined, malformed);
    assert.equal(await verifyPasswordKey(key, malformed), false, malformed);
  }
  assert.equal(passwordFormat(null), undefined);
  assert.equal(passwordFormat(knownLegacyRow), "legacy");
  for (const badKey of [undefined, null, 7, "", encodeBase64Url(new Uint8Array(31)), encodeBase64Url(new Uint8Array(33)), `${encodeBase64Url(key)}=`, encodeBase64Url(key).replace(/.$/, "+")])
    assert.equal(parsePasswordKey(badKey), undefined, String(badKey));
  for (const badCredential of [undefined, null, "text", [], {}, { salt: encodeBase64Url(knownSalt) }, { key: encodeBase64Url(key) }, { salt: encodeBase64Url(new Uint8Array(15)), key: encodeBase64Url(key) }, { salt: encodeBase64Url(knownSalt), key: encodeBase64Url(key), password: knownPassword }])
    assert.equal(await passwordHashFromCredential(badCredential), undefined, JSON.stringify(badCredential));
  await assert.rejects(passwordProof(knownPassword, { algorithm: "scrypt", N: 16384, r: 8, p: 1, dkLen: 32, salt, legacy: false }), /not supported/);
  await assert.rejects(newPasswordCredential("eleven char"), /at least 12 characters/, "the client enforces the minimum the Worker can no longer check");
});

test("constant-time comparison checks every byte and only equal lengths match", () => {
  const base = Uint8Array.from({ length: 32 }, (_, index) => index);
  assert.equal(constantTimeEqual(base, Uint8Array.from(base)), true);
  for (const position of [0, 15, 31]) { const changed = Uint8Array.from(base); changed[position] ^= 1; assert.equal(constantTimeEqual(base, changed), false, `differs at byte ${position}`); }
  assert.equal(constantTimeEqual(base, base.slice(0, 31)), false);
  assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  // No early exit: the loop reads every index of both inputs even when the first byte already differs.
  const reads: number[] = [];
  const tracked = new Proxy(Uint8Array.from(base), { get(target, property) { if (typeof property === "string" && /^\d+$/.test(property)) reads.push(Number(property)); const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } });
  const different = Uint8Array.from(base); different[0] ^= 0xff;
  assert.equal(constantTimeEqual(different, tracked as unknown as Uint8Array), false);
  assert.deepEqual(reads, Array.from({ length: 32 }, (_, index) => index));
});

test("the fake salt for unknown usernames is deterministic, keyed and shaped like a real salt", async () => {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const first = await fakePasswordSalt(secret, "nobody");
  assert.equal(await fakePasswordSalt(secret, "nobody"), first, "the same username always gets the same salt");
  assert.notEqual(await fakePasswordSalt(secret, "somebody"), first, "different usernames get different salts");
  assert.notEqual(await fakePasswordSalt(Buffer.alloc(32, 8).toString("base64url"), "nobody"), first, "the salt depends on the server secret");
  assert.equal(decodeBase64Url(first)?.length, 16);
  assert.equal(first.length, storedPasswordSalt(await clientPasswordHash(knownSalt, await derivePasswordKey(knownPassword, knownSalt)))!.length);
  // HMAC-SHA256(HMAC-SHA256(SESSION_KEY, "lancerlogin:pw-salt"), username), first 16 bytes.
  const derived = createHmac("sha256", Buffer.alloc(32, 7)).update("lancerlogin:pw-salt").digest();
  assert.equal(first, createHmac("sha256", derived).update("nobody").digest().subarray(0, 16).toString("base64url"));
  await assert.rejects(fakePasswordSalt(Buffer.alloc(16).toString("base64url"), "nobody"), /SESSION_KEY/);
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
