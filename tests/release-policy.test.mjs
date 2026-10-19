import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseVersion, kioskReleaseTransition, compareReleaseVersions, completeOfficialRelease, newestOfficialRelease } from "../packages/shared/src/release-policy.mjs";
import { releasePublicationPolicy, assertLatestPromotion } from "../scripts/release-channel.mjs";
import { validateMigrationPolicy } from "../scripts/run-web-upgrade.mjs";
import { resolveKioskRelease } from "../apps/kiosk/src/resolve-kiosk-release.mjs";
import { prepareVerifiedKioskUpdate } from "../apps/kiosk/src/update-command.mjs";
const release = (tag) => ({ tag_name: tag, draft: false, prerelease: tag.includes("-beta."), immutable: true, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => {
  const archive = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`; return [archive, `${archive}.sha256`];
})].map((name) => ({ name })) });
test("canonical stable and beta ordering never downgrades on opt-out", () => {
  for (const value of ["v01.2.3", "1.2", "v2.0.0-beta.01", "v2.0.0-rc.1", "v2.0.0+build", "v2.0.0-beta.1\n", "v2.0.0/evil", "vv2.0.0"]) assert.equal(parseReleaseVersion(value), undefined, value);
  for (const [a, b] of [["2.0.0-beta.1", "1.2.6"], ["2.0.0-beta.10", "2.0.0-beta.9"], ["2.0.0", "2.0.0-beta.99"], ["2.1.0-beta.1", "2.0.0"]]) { assert.equal(compareReleaseVersions(a, b), 1); assert.equal(compareReleaseVersions(b, a), -1); }
  assert.equal(compareReleaseVersions("v2.0.0-beta.1", "2.0.0-beta.1"), 0);
  assert.equal(compareReleaseVersions("unknown", "2.0.0"), undefined);
});
test("tracks require matching release flags, complete assets and canonical tags", () => {
  const beta = release("v2.0.0-beta.1"); assert.equal(completeOfficialRelease(beta), undefined);
  assert.equal(completeOfficialRelease(beta, "beta")?.tag, beta.tag_name);
  for (const value of [{ ...beta, draft: true }, { ...beta, immutable: false }, { ...beta, prerelease: false }, { ...beta, assets: [] }, { ...release("v2.0.0"), prerelease: true }]) assert.equal(completeOfficialRelease(value, "beta"), undefined);
  const feed = [release("v2.0.0-beta.10"), release("v2.0.0-beta.9"), release("v1.2.6")];
  assert.equal(newestOfficialRelease(feed)?.tag, "v1.2.6"); assert.equal(newestOfficialRelease(feed, "beta")?.tag, "v2.0.0-beta.10");
  assert.equal(newestOfficialRelease([...feed, release("v2.0.0")], "beta")?.tag, "v2.0.0");
  assert.deepEqual(releasePublicationPolicy("v1.2.6"), { branch: "main", prerelease: false, latest: true });
  assert.deepEqual(releasePublicationPolicy("v2.0.0-beta.1"), { branch: "modular", prerelease: true, latest: false });
  assert.throws(() => releasePublicationPolicy("v2.0.0-rc.1"));
  assert.doesNotThrow(() => assertLatestPromotion("v1.2.6", "v1.2.5"));
  assert.doesNotThrow(() => assertLatestPromotion("v2.0.0-beta.1", "v1.2.6"));
  for (const previous of ["v1.2.6", "v2.0.0", "v1.2.5-beta.1", "unknown"]) assert.throws(() => assertLatestPromotion("v1.2.6", previous), /latest_must_advance/);
});
test("reviewed independent bridge permits only the unchanged ordinary migration prefix", async () => {
  const files = [{ name: "0001_core.sql", content: "one" }, { name: "0040_module.sql", content: "two" }, { name: "0061_update_channels.sql", content: "three" }];
  const policy = { format: 1, minimumInstalledVersion: "0.24.0", automaticCodeRollback: false, independentBridgeMigrations: ["0061_update_channels.sql"], reviewedMigrations: files.map((file) => ({ name: file.name, sha256: createHash("sha256").update(file.content).digest("hex"), forwardCompatible: true })) };
  for (const applied of [["0001_core.sql"], ["0001_core.sql", "0061_update_channels.sql"], files.map((file) => file.name)]) await validateMigrationPolicy(policy, files, applied, "1.2.6", "v2.0.0-beta.1");
  await validateMigrationPolicy(policy, files, files.map((file) => file.name), "2.0.0-beta.1", "v2.0.0");
  for (const applied of [["0040_module.sql"], ["0001_core.sql", "unknown.sql"], ["0001_core.sql", "0001_core.sql"]]) await assert.rejects(validateMigrationPolicy(policy, files, applied, "1.2.6", "v2.0.0-beta.1"), /migration_path_review_required/);
  await assert.rejects(validateMigrationPolicy({ ...policy, independentBridgeMigrations: ["0040_module.sql"] }, files, ["0040_module.sql"], "1.2.6", "v2.0.0-beta.1"), /migration_path_review_required/);
  await assert.rejects(validateMigrationPolicy(policy, [{ ...files[0], content: "changed" }, ...files.slice(1)], [], "1.2.6", "v2.0.0-beta.1"), /migration_hash_review_required/);
  await assert.rejects(validateMigrationPolicy(policy, files, [], "2.0.0-beta.1", "v1.2.6"), /migration_compatibility_review_required/);
});
test("physical updater revalidates exact official tag and commit, consent and expiry", async () => {
  const calls = []; const tag = "v2.0.0-beta.1"; const sha = "b".repeat(40); const now = Date.now();
  const fetcher = async (url, init) => { calls.push(url); assert.equal(init.redirect, "error"); return Response.json(url.includes("/commits/") ? { sha } : release(tag)); };
  const request = { targetTag: tag, targetCommit: sha, channel: "beta", expiresAt: new Date(now + 60_000).toISOString() };
  assert.equal((await resolveKioskRelease({ request, installedVersion: "1.2.6", fetcher, now })).version, "2.0.0-beta.1");
  assert.deepEqual(calls, [`https://api.github.com/repos/isriah/LancerLogin/releases/tags/${tag}`, `https://api.github.com/repos/isriah/LancerLogin/commits/${tag}`]);
  for (const invalid of [{ ...request, channel: "stable" }, { ...request, expiresAt: new Date(now).toISOString() }, { ...request, url: "https://evil.test" }]) await assert.rejects(resolveKioskRelease({ request: invalid, installedVersion: "1.2.6", fetcher, now }), /invalid_update_request/);
  await assert.rejects(resolveKioskRelease({ request: { ...request, targetCommit: "c".repeat(40) }, installedVersion: "1.2.6", fetcher, now }), /release_commit_mismatch/);
  await assert.rejects(resolveKioskRelease({ request, installedVersion: "2.0.0", fetcher, now }), /newer_official_release_required/);
  assert.equal((await resolveKioskRelease({ request, installedVersion: "2.0.0-dev.kiosk-list.fe4c8f2", fetcher, now })).version, "2.0.0-beta.1");
  await assert.rejects(resolveKioskRelease({ installedVersion: "2.0.0-dev.kiosk-list.fe4c8f2", fetcher, now }), /newer_official_release_required/);
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-target-test-")); const path = join(directory, "request.json");
  try {
    await prepareVerifiedKioskUpdate({ ...request, createdAt: new Date(now - 1_000).toISOString() }, path);
    assert.equal(JSON.parse(await readFile(path, "utf8")).targetCommit, sha);
    await prepareVerifiedKioskUpdate({ type: "install_latest" }, path); await assert.rejects(readFile(path), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("kiosk development replacement permits only official same-base or newer targets", () => {
  const dev = "2.0.0-dev.kiosk-list.fe4c8f2";
  for (const target of ["v2.0.0-beta.4", "2.0.0", "2.1.0-beta.1"]) assert.equal(kioskReleaseTransition(target, dev), "replace-development");
  for (const target of ["1.2.6", dev, "2.0.0-rc.1", "unknown"]) assert.equal(kioskReleaseTransition(target, dev), "unavailable");
  for (const installed of ["unknown", "development", "2.0.0-dev.bad", "02.0.0-dev.foo.abcdef0"]) assert.equal(kioskReleaseTransition("2.0.0", installed), "unavailable");
  assert.equal(kioskReleaseTransition("2.0.0-beta.5", "2.0.0-beta.4"), "upgrade");
  assert.equal(kioskReleaseTransition("2.0.0-beta.4", "2.0.0"), "current");
});
