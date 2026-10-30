import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec, hashPassword } from "../apps/api/src/runtime-security.ts";
import { latestUpdate, recordUpdateBackup, startWebUpdate } from "../apps/api/src/web-updates.ts";
import { clearPluginReleaseCache, commitPluginChange, freshUntil, lookupPluginRelease, newestTrackRelease, parseAllowlist, pendingChanges, pluginManagementState, pluginVersionInfo, releaseIndexTtlMs, reauthenticationWindowMs, reviewPluginChange, selectionCredentialState, sourceAllowed, type InstalledPlugins } from "../apps/api/src/plugin-selection.ts";
import { resetCredentialObservations } from "../apps/api/src/github-credential.ts";
import { parseSelectionFile, serializeSelection } from "../packages/shared/src/module-selection.ts";

class D1 {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const file of readdirSync("apps/api/migrations").sort()) this.sqlite.exec(readFileSync(join("apps/api/migrations", file), "utf8"));
    this.sqlite.exec("INSERT INTO installations (id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'); INSERT INTO users (id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01'), ('operator','primary','operator','operator','2026-01-01'); INSERT INTO organization_settings (installation_id,time_zone) VALUES ('primary','UTC');");
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return { bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() {
        const before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        database.sqlite.prepare(sql).run(...params as []);
        return { success: true, meta: { changes: Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before } };
      } };
  }
  async batch(statements: Array<{ run(): Promise<unknown> }>) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

const secret = "A".repeat(43);
const origin = "https://example-dashboard.pages.dev";
const selectionToken = "synthetic-selection-token";
const dispatchToken = "synthetic-dispatch-token";
const pluginCommit = "c".repeat(40); const nextCommit = "d".repeat(40); const releaseSha = "b".repeat(40);
const carpoolSource = "https://github.com/example/lancerlogin-carpool.git";
const outreachSource = "https://github.com/isriah/lancerlogin-outreach.git";
const installed: InstalledPlugins = { "hour-tracking": { source: outreachSource, commit: "e".repeat(40), official: true } };

function environment(database = new D1()): Env & { DB: D1 } {
  return { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, RELEASE_VERSION: "2.0.0-beta.11", UPDATE_REPOSITORY: "example/private-install",
    WEB_UPDATE_TOKEN: dispatchToken, WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    MODULE_SELECTION_TOKEN: selectionToken, MODULE_SELECTION_TOKEN_EXPIRES_AT: new Date(Date.now() + 30 * 86_400_000).toISOString(), DB: database } as unknown as Env & { DB: D1 };
}
const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** A synthetic GitHub: the private repository's files, plugin package metadata and dispatch. */
class GitHub {
  files = new Map<string, string>();
  calls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
  pluginPackage: object | number = { name: "carpool", version: "1.0.0", type: "module", lancerlogin: { moduleId: "carpool", contract: 1, core: ">=2.0.0-beta.11 <3.0.0", tablePrefix: "carpool_", entries: { manifest: "./src/manifest.ts", api: "./src/api.ts" }, migrations: "./migrations" } };
  conflictNextPut = false; putStatus?: number;
  /** The plugin repository's published releases, newest publication first, and what each tag resolves to. */
  releases: object[] | number = [
    { tag_name: "v1.1.0-nightly.20261025", draft: false, prerelease: true, immutable: true, html_url: "https://github.com/example/lancerlogin-carpool/releases/tag/v1.1.0-nightly.20261025" },
    { tag_name: "v1.0.1", draft: false, prerelease: false, immutable: false },
    { tag_name: "v1.1.0-nightly.20261026", draft: true, prerelease: true, immutable: true },
    { tag_name: "v1.1.0-beta.1", draft: false, prerelease: true, immutable: false },
    { tag_name: "v1.0.0", draft: false, prerelease: false, immutable: true, html_url: "https://github.com/example/lancerlogin-carpool/releases/tag/v1.0.0" },
    { tag_name: "v0.9.0-beta.1", draft: false, prerelease: true, immutable: true },
  ];
  tags: Record<string, string> = { "v1.0.0": "1".repeat(40), "v1.1.0-nightly.20261025": "2".repeat(40) };
  /** The official Outreach plugin repository, for LancerLogin's release pin. */
  outreach: { releases: object[]; tags: Record<string, string> } | number = 404;
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? "GET"; const headers = new Headers(init?.headers);
      this.calls.push({ url: url.href, method, authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : undefined });
      assert.equal(init?.redirect, "manual");
      assert.equal(url.origin, "https://api.github.com");
      const path = url.pathname;
      if (path === "/repos/example/private-install") return Response.json({ private: true });
      const file = /^\/repos\/example\/private-install\/contents\/(.+)$/.exec(path);
      if (file) {
        assert.equal(headers.get("authorization"), `Bearer ${selectionToken}`);
        const name = decodeURIComponent(file[1]!);
        if (method === "PUT") {
          assert.equal(name, "lancerlogin.modules.json");
          if (this.putStatus) return new Response(null, { status: this.putStatus });
          const body = JSON.parse(String(init?.body)) as { content: string; sha?: string; branch: string };
          assert.equal(body.branch, "main");
          const current = this.files.get(name);
          if (this.conflictNextPut || (current === undefined ? body.sha !== undefined : body.sha !== blob(current))) { this.conflictNextPut = false; return new Response(null, { status: 409 }); }
          const text = Buffer.from(body.content, "base64").toString("utf8"); this.files.set(name, text);
          return Response.json({ content: { sha: blob(text) }, commit: { sha: "f".repeat(40) } }, { status: current === undefined ? 201 : 200 });
        }
        const text = this.files.get(name);
        return text === undefined ? new Response(null, { status: 404 }) : Response.json({ type: "file", sha: blob(text), encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length });
      }
      if (path === "/repos/example/lancerlogin-carpool/releases") {
        assert.equal(headers.get("authorization"), null, "plugin repositories never receive a credential");
        if (typeof this.releases === "number") return new Response(null, { status: this.releases });
        return Response.json(url.searchParams.get("page") === "1" ? this.releases : []);
      }
      if (path === "/repos/example/lancerlogin-carpool/tags") {
        assert.equal(headers.get("authorization"), null, "plugin repositories never receive a credential");
        if (typeof this.releases === "number") return new Response(null, { status: this.releases });
        return Response.json(url.searchParams.get("page") === "1" ? Object.entries(this.tags).map(([name, sha]) => ({ name, commit: { sha } })) : []);
      }
      const outreach = /^\/repos\/isriah\/lancerlogin-outreach\/(releases|tags)$/.exec(path);
      if (outreach) {
        assert.equal(headers.get("authorization"), null, "plugin repositories never receive a credential");
        if (typeof this.outreach === "number") return new Response(null, { status: this.outreach });
        if (url.searchParams.get("page") !== "1") return Response.json([]);
        return Response.json(outreach[1] === "releases" ? this.outreach.releases : Object.entries(this.outreach.tags).map(([name, sha]) => ({ name, commit: { sha } })));
      }
      const tag = /^\/repos\/example\/lancerlogin-carpool\/commits\/(.+)$/.exec(path);
      if (tag) {
        assert.equal(headers.get("authorization"), null, "plugin repositories never receive a credential");
        const sha = this.tags[decodeURIComponent(tag[1]!)];
        return sha ? Response.json({ sha }) : new Response(null, { status: 404 });
      }
      if (path.startsWith("/repos/example/lancerlogin-carpool/contents/")) {
        assert.equal(headers.get("authorization"), null, "plugin repositories never receive a credential");
        if (path.endsWith("/package.json")) return typeof this.pluginPackage === "number" ? new Response(null, { status: this.pluginPackage }) : Response.json(this.pluginPackage);
        if (path.endsWith("/migrations")) return Response.json([{ type: "file", name: "0001_carpool.sql" }, { type: "file", name: "README.md" }]);
      }
      if (path === "/repos/example/private-install/actions/workflows/upgrade-web.yml") return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml", name: "Upgrade LancerLogin web (update channels v2)" });
      if (path === "/repos/isriah/LancerLogin/commits/v2.0.0-beta.11") return Response.json({ sha: releaseSha });
      if (path.endsWith("/dispatches")) return Response.json({ workflow_run_id: 77 });
      return new Response(null, { status: 404 });
    };
    return () => { globalThis.fetch = previous; };
  }
}
async function withGitHub(run: (github: GitHub) => Promise<void>, github = new GitHub()) {
  const restore = github.install();
  try { await run(github); } finally { restore(); }
}
// One clock reading: freshUntil requires the session to span exactly its lifetime, and two readings can differ by a millisecond.
const signedInAt = Date.now();
const fresh = { userId: "admin", expiresAt: signedInAt + 8 * 3_600_000, authenticatedAt: signedInAt };
const add = { action: "add", id: "carpool", source: carpoolSource, commit: pluginCommit };

test("selection parsing, serialization, pending changes and allowlists follow composition's rules", () => {
  const document = parseSelectionFile(serializeSelection({ modules: [{ id: "carpool", source: carpoolSource, commit: pluginCommit }] }));
  assert.deepEqual(document.modules, [{ id: "carpool", source: carpoolSource, commit: pluginCommit }]);
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [{ id: "carpool", source: carpoolSource, commit: "main" }] })), /full 40-character/);
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [{ id: "carpool", source: "https://token@github.com/a/b.git", commit: pluginCommit }] })), /credentials/);
  assert.deepEqual(pendingChanges(document, installed), [{ kind: "add", id: "carpool", source: carpoolSource, commit: pluginCommit }]);
  assert.deepEqual(pendingChanges({ modules: [], officialModules: false }, installed), [{ kind: "remove", id: "hour-tracking", installedCommit: "e".repeat(40) }]);
  assert.deepEqual(pendingChanges({ modules: [] }, { "hour-tracking": { ...installed["hour-tracking"]!, selected: true } }), [{ kind: "revert", id: "hour-tracking", installedCommit: "e".repeat(40) }]);
  assert.deepEqual(pendingChanges({ modules: [{ id: "hour-tracking", source: outreachSource, commit: nextCommit }] }, installed), [{ kind: "upgrade", id: "hour-tracking", source: outreachSource, commit: nextCommit, installedCommit: "e".repeat(40) }]);
  const allowlist = parseAllowlist(JSON.stringify({ format: 1, allowedSources: ["github.com/example", "git.example.org"] }));
  assert.equal(sourceAllowed(carpoolSource, allowlist), true);
  assert.equal(sourceAllowed("https://github.com/other/plugin.git", allowlist), false);
  assert.equal(sourceAllowed("https://git.example.org/anyone/plugin.git", allowlist), true);
  assert.equal(sourceAllowed(carpoolSource, parseAllowlist("{")), false, "an invalid allowlist refuses every source");
  assert.equal(sourceAllowed(carpoolSource, { state: "none" }), true);
});

test("a plugin's release track is an optional selection field: absent means stable, and unknown values are refused", () => {
  const entry = { id: "carpool", source: carpoolSource, commit: pluginCommit };
  const parse = (value: unknown) => parseSelectionFile(JSON.stringify(value));
  assert.deepEqual(parse({ format: 1, modules: [entry] }).modules, [entry], "a file written before tracks stays valid");
  assert.deepEqual(parse({ format: 1, modules: [{ ...entry, track: "nightly" }] }).modules, [{ ...entry, track: "nightly" }]);
  assert.deepEqual(parse({ format: 1, modules: [{ ...entry, track: "stable" }] }).modules, [entry], "an explicit stable track is the default");
  for (const track of ["beta", "Nightly", "", 1, null]) assert.throws(() => parse({ format: 1, modules: [{ ...entry, track }] }), /track .* is not supported; use "stable" or "nightly", or leave it out for stable/, JSON.stringify(track));
  assert.equal(serializeSelection({ modules: [{ ...entry, track: "nightly" }, { ...entry, id: "other", source: "https://github.com/example/other.git" }] }), `${JSON.stringify({ format: 1, modules: [{ ...entry, track: "nightly" }, { ...entry, id: "other", source: "https://github.com/example/other.git" }] }, null, 2)}\n`);
  // Composition builds the pinned commit; pending changes ignore the track.
  assert.deepEqual(pendingChanges(parse({ format: 1, modules: [{ id: "hour-tracking", source: outreachSource, commit: "e".repeat(40), track: "nightly" }] }), installed), []);
});

test("a selection credential without an expiry is ready, and GitHub's 401 surfaces the fixed rejected code", async () => {
  const env = environment(); delete env.MODULE_SELECTION_TOKEN_EXPIRES_AT;
  assert.deepEqual(selectionCredentialState(env), { state: "ready", expiresAt: null });
  assert.equal(selectionCredentialState({ ...env, MODULE_SELECTION_TOKEN_EXPIRES_AT: "2020-01-01T00:00:00.000Z" }).state, "expired");
  assert.equal(selectionCredentialState({ ...env, MODULE_SELECTION_TOKEN: undefined }).state, "missing");
  await withGitHub(async () => { assert.equal((await reviewPluginChange(env, add, installed)).action, "add"); });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try { await assert.rejects(reviewPluginChange(env, add, installed), { code: "selection_credential_rejected" }); }
  finally { globalThis.fetch = previous; resetCredentialObservations(); }
});

test("Upgrade offers the newest published, immutable release on the plugin's track, read without credentials", async () => {
  await withGitHub(async (github) => {
    assert.deepEqual(await newestTrackRelease(carpoolSource, "stable"), { track: "stable", release: { tag: "v1.0.0", kind: "stable", commit: "1".repeat(40), url: "https://github.com/example/lancerlogin-carpool/releases/tag/v1.0.0" } }, "mutable, draft and nightly releases never reach Stable");
    assert.deepEqual((await newestTrackRelease(carpoolSource, "nightly")).release, { tag: "v1.1.0-nightly.20261025", kind: "nightly", commit: "2".repeat(40), url: "https://github.com/example/lancerlogin-carpool/releases/tag/v1.1.0-nightly.20261025" });
    github.releases = [{ tag_name: "v1.1.0-nightly.20261025", draft: false, prerelease: true, immutable: true }];
    assert.match((await newestTrackRelease(carpoolSource, "stable")).reason!, /No published, immutable release is on the Stable track/);
    github.releases = 404;
    assert.match((await newestTrackRelease(carpoolSource, "nightly")).reason!, /not found, or its repository is private/);
    assert.match((await newestTrackRelease("https://git.example.org/example/carpool.git", "stable")).reason!, /only for github.com sources/);
    await assert.rejects(lookupPluginRelease({ id: "carpool", source: carpoolSource, track: "beta" }), { code: "invalid_request" });
    await assert.rejects(lookupPluginRelease({ id: "carpool", source: carpoolSource }), { code: "invalid_request" });
    await assert.rejects(lookupPluginRelease({ id: "carpool", source: "https://token@github.com/a/b.git", track: "stable" }), { code: "invalid_request" });
    await assert.rejects(lookupPluginRelease({ id: "carpool", source: carpoolSource, track: "stable", commit: pluginCommit }), { code: "invalid_request" });
    assert.ok(github.calls.length > 0);
    for (const call of github.calls) { assert.equal(call.authorization, null); assert.equal(call.method, "GET"); assert.equal(call.url.includes("private-install"), false); }
  });
});

const published = (tag_name: string) => ({ tag_name, draft: false, prerelease: !/^v\d+\.\d+\.\d+$/.test(tag_name), immutable: true });
const versionReleases = () => ({
  releases: [published("v1.2.0-nightly.20261027"), published("v1.1.0-beta.1"), published("v1.0.1"), published("v1.0.0"), { ...published("v0.9.0"), draft: true }],
  tags: { "v1.2.0-nightly.20261027": "5".repeat(40), "v1.1.0-beta.1": "4".repeat(40), "v1.0.1": "3".repeat(40), "v1.0.0": "1".repeat(40), "v0.9.0": "9".repeat(40) } as Record<string, string>,
});

test("plugin versions: the release at the pinned commit and the newest release on its track, read anonymously and cached", async () => {
  clearPluginReleaseCache();
  const github = new GitHub(); Object.assign(github, versionReleases());
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  try {
    await withGitHub(async () => {
      // Stable offers stable releases only.
      assert.deepEqual(await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable"), { version: "v1.0.0", latest: { tag: "v1.0.1", kind: "stable", commit: "3".repeat(40) }, latestUnavailable: false, updateAvailable: true });
      assert.deepEqual(await pluginVersionInfo(carpoolSource, "3".repeat(40), "stable"), { version: "v1.0.1", latest: { tag: "v1.0.1", kind: "stable", commit: "3".repeat(40) }, latestUnavailable: false, updateAvailable: false });
      // Nightly also offers beta and nightly prereleases; the highest version wins.
      assert.deepEqual((await pluginVersionInfo(carpoolSource, "3".repeat(40), "nightly")).latest, { tag: "v1.2.0-nightly.20261027", kind: "nightly", commit: "5".repeat(40) });
      assert.equal((await pluginVersionInfo(carpoolSource, "4".repeat(40), "nightly")).updateAvailable, true);
      // An unreleased commit, and a draft release's commit, have no version and are never reported as outdated.
      assert.deepEqual(await pluginVersionInfo(carpoolSource, "8".repeat(40), "stable"), { version: null, latest: { tag: "v1.0.1", kind: "stable", commit: "3".repeat(40) }, latestUnavailable: false, updateAvailable: false });
      assert.equal((await pluginVersionInfo(carpoolSource, "9".repeat(40), "stable")).version, null);
      // Cached for ten minutes per repository: one read of releases and one of tags so far.
      const reads = () => github.calls.filter((call) => /lancerlogin-carpool\/(releases|tags)/.test(call.url)).length;
      assert.equal(reads(), 2);
      github.releases = [published("v2.0.0"), ...versionReleases().releases]; github.tags = { ...versionReleases().tags, "v2.0.0": "6".repeat(40) };
      assert.equal((await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable")).latest?.tag, "v1.0.1");
      now += releaseIndexTtlMs + 1;
      assert.equal((await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable")).latest?.tag, "v2.0.0");
      assert.equal(reads(), 4);
      // A failure never throws: the latest version is unavailable, and the lookup is retried after a minute.
      now += releaseIndexTtlMs + 1; github.releases = 500;
      assert.deepEqual(await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable"), { version: null, latest: null, latestUnavailable: true, updateAvailable: false });
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(github, versionReleases());
      assert.equal((await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable")).latestUnavailable, true, "a failure is cached briefly");
      now += 61_000;
      assert.equal((await pluginVersionInfo(carpoolSource, "1".repeat(40), "stable")).latestUnavailable, false);
      // Other hosts are not looked up.
      assert.equal((await pluginVersionInfo("https://git.example.org/example/carpool.git", "1".repeat(40), "stable")).latestUnavailable, true);
      for (const call of github.calls) { assert.equal(call.authorization, null); assert.equal(call.url.includes("git.example.org"), false); }
    }, github);
  } finally { Date.now = realNow; clearPluginReleaseCache(); }
});

test("the plugin status carries versions per installed plugin, LancerLogin's pinned version and versioned pending changes", async () => {
  clearPluginReleaseCache();
  const env = environment();
  const github = new GitHub(); Object.assign(github, versionReleases());
  const pin = (JSON.parse(readFileSync("scripts/official-modules.json", "utf8")) as { modules: Array<{ id: string; commit: string }> }).modules.find((entry) => entry.id === "hour-tracking")!;
  github.outreach = { releases: [published("v0.2.1"), published("v0.2.0")], tags: { "v0.2.1": "7".repeat(40), "v0.2.0": pin.commit } };
  github.files.set("lancerlogin.modules.json", serializeSelection({ modules: [{ id: "carpool", source: carpoolSource, commit: "3".repeat(40) }] }));
  const plugins: InstalledPlugins = { "hour-tracking": { source: outreachSource, commit: pin.commit, official: true }, carpool: { source: carpoolSource, commit: "1".repeat(40), official: false, selected: true } };
  try {
    await withGitHub(async () => {
      const state = await pluginManagementState(env, { installed: plugins, principal: fresh, passwordAvailable: true, googleAvailable: false });
      const outreach = state.installed.find((item) => item.id === "hour-tracking")!; const carpool = state.installed.find((item) => item.id === "carpool")!;
      assert.deepEqual({ version: outreach.version, latest: outreach.latest?.tag, updateAvailable: outreach.updateAvailable, releasePinVersion: outreach.releasePinVersion, track: outreach.track }, { version: "v0.2.0", latest: "v0.2.1", updateAvailable: true, releasePinVersion: "v0.2.0", track: "stable" });
      assert.deepEqual({ version: carpool.version, latest: carpool.latest?.tag, updateAvailable: carpool.updateAvailable }, { version: "v1.0.0", latest: "v1.0.1", updateAvailable: true });
      assert.equal("releasePinVersion" in carpool, false, "only official plugins following LancerLogin's pin report it");
      assert.deepEqual(state.pending, [{ kind: "upgrade", id: "carpool", source: carpoolSource, commit: "3".repeat(40), installedCommit: "1".repeat(40), version: "v1.0.1", installedVersion: "v1.0.0" }]);
      // GitHub failures leave the status intact and mark the latest version unavailable.
      clearPluginReleaseCache(); github.releases = 503; github.outreach = 503;
      const degraded = await pluginManagementState(env, { installed: plugins, principal: fresh, passwordAvailable: true, googleAvailable: false });
      assert.equal(degraded.error, null);
      for (const item of degraded.installed) { assert.equal(item.latestUnavailable, true); assert.equal(item.latest, null); assert.equal(item.version, null); }
      assert.deepEqual(degraded.pending.map((change) => [change.version, change.installedVersion]), [[null, null]]);
    }, github);
  } finally { clearPluginReleaseCache(); }
});

test("changing a plugin's release track is a reviewed, re-authenticated, audited plugin change", async () => {
  const env = environment();
  await withGitHub(async (github) => {
    github.files.set("lancerlogin.modules.json", serializeSelection({ modules: [{ id: "carpool", source: carpoolSource, commit: pluginCommit }] }));
    const withCarpool: InstalledPlugins = { ...installed, carpool: { source: carpoolSource, commit: pluginCommit, selected: true } };
    const current = () => blob(github.files.get("lancerlogin.modules.json")!);
    const toNightly = { action: "upgrade", id: "carpool", source: carpoolSource, commit: pluginCommit, track: "nightly" };
    const review = await reviewPluginChange(env, toNightly, withCarpool);
    assert.equal(review.track, "nightly"); assert.equal(review.previousTrack, "stable");
    await assert.rejects(reviewPluginChange(env, { ...toNightly, track: "weekly" }, withCarpool), { code: "invalid_request" });
    await assert.rejects(reviewPluginChange(env, { action: "remove", id: "carpool", track: "stable" }, withCarpool), { code: "invalid_request" });
    await assert.rejects(reviewPluginChange(env, { ...toNightly, track: "stable" }, withCarpool), { code: "unchanged" });
    await assert.rejects(commitPluginChange(env, { ...fresh, authenticatedAt: Date.now() - reauthenticationWindowMs - 1_000 }, { ...toNightly, selectionSha: current(), trustConfirmed: true }, withCarpool), { code: "reauthentication_required" });
    await assert.rejects(commitPluginChange(env, fresh, { ...toNightly, selectionSha: current() }, withCarpool), { code: "trust_confirmation_required" });
    github.files.set("lancerlogin.plugin-sources.json", JSON.stringify({ format: 1, allowedSources: ["github.com/trusted"] }));
    await assert.rejects(commitPluginChange(env, fresh, { ...toNightly, selectionSha: current(), trustConfirmed: true }, withCarpool), { code: "source_not_allowed" });
    github.files.delete("lancerlogin.plugin-sources.json");
    const result = await commitPluginChange(env, fresh, { ...toNightly, selectionSha: current(), trustConfirmed: true }, withCarpool);
    assert.equal(result.committed.track, "nightly");
    assert.deepEqual(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules, [{ id: "carpool", source: carpoolSource, commit: pluginCommit, track: "nightly" }]);
    const put = github.calls.filter((call) => call.method === "PUT").at(-1)!;
    assert.match(JSON.parse(put.body!).message, /^Set plugin carpool release track to nightly\n\nRequested in LancerLogin Settings > Modules by Admin user admin\./);
    const audit = JSON.parse(String(env.DB.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'module_selection.changed' ORDER BY created_at DESC LIMIT 1").get()?.metadata));
    assert.equal(audit.track, "nightly"); assert.equal(audit.previousTrack, "stable"); assert.equal(audit.commit, pluginCommit);
    // An upgrade that names no track keeps the plugin's track; returning to Stable removes the field.
    await commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, selectionSha: current(), trustConfirmed: true }, withCarpool);
    assert.equal(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules[0].track, "nightly");
    assert.match(JSON.parse(github.calls.filter((call) => call.method === "PUT").at(-1)!.body!).message, /^Pin plugin carpool at dddddddddddd on the nightly track/);
    await commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, track: "stable", selectionSha: current(), trustConfirmed: true }, withCarpool);
    assert.deepEqual(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules, [{ id: "carpool", source: carpoolSource, commit: nextCommit }]);
    // An official module that the selection does not pin can move to Nightly; the selection then pins it.
    await commitPluginChange(env, fresh, { action: "upgrade", id: "hour-tracking", source: outreachSource, commit: "e".repeat(40), track: "nightly", selectionSha: current(), trustConfirmed: true }, withCarpool);
    assert.deepEqual(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules.at(-1), { id: "hour-tracking", source: outreachSource, commit: "e".repeat(40), track: "nightly" });
  });
});

test("freshness requires a recent full sign-in session, never a short-lived state token", () => {
  const now = Date.now();
  assert.ok(freshUntil({ userId: "a", authenticatedAt: now, expiresAt: now + 8 * 3_600_000 }));
  assert.equal(freshUntil({ userId: "a", authenticatedAt: now - reauthenticationWindowMs - 1, expiresAt: now - reauthenticationWindowMs - 1 + 8 * 3_600_000 }), null);
  assert.equal(freshUntil({ userId: "a", authenticatedAt: now, expiresAt: now + 10 * 60_000 }), null);
  assert.equal(freshUntil({ userId: "a", expiresAt: now + 8 * 3_600_000 }), null);
});

test("review shows source, commit, compatibility and declarations without running plugin code or sending credentials", async () => {
  const env = environment();
  await withGitHub(async (github) => {
    const review = await reviewPluginChange(env, add, installed);
    assert.equal(review.source, carpoolSource); assert.equal(review.commit, pluginCommit);
    assert.equal(review.metadata?.state, "compatible"); assert.equal(review.metadata?.tablePrefix, "carpool_");
    assert.deepEqual(review.metadata?.migrations, ["0001_carpool.sql"]);
    assert.match(review.trustStatement, /same access as LancerLogin/); assert.match(review.declaredNote, /does not run plugin code/);
    assert.equal(review.selectionSha, "0".repeat(40));
    github.pluginPackage = { ...github.pluginPackage as object, lancerlogin: { moduleId: "carpool", contract: 1, core: ">=3.0.0", tablePrefix: "carpool_", entries: {} } };
    assert.equal((await reviewPluginChange(env, add, installed)).metadata?.state, "incompatible");
    github.pluginPackage = 404;
    assert.equal((await reviewPluginChange(env, add, installed)).metadata?.state, "unknown");
    assert.equal((await reviewPluginChange(env, { ...add, source: "https://git.example.org/example/carpool.git" }, installed)).metadata?.state, "unknown");
    await assert.rejects(reviewPluginChange(env, { ...add, commit: "abc1234" }, installed), { code: "invalid_request" });
    await assert.rejects(reviewPluginChange(env, { ...add, id: "attendance" }, installed), { code: "first_party_module" });
    await assert.rejects(reviewPluginChange(env, { ...add, extra: true }, installed), { code: "invalid_request" });
    for (const call of github.calls) if (!call.url.includes("/repos/example/private-install")) assert.equal(call.authorization, null);
  });
});

test("a change commits optimistically, is audited, expires prepared updates and survives a concurrent edit only by review", async () => {
  const env = environment();
  await withGitHub(async (github) => {
    env.DB.sqlite.exec("INSERT INTO web_update_requests (id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at) VALUES ('11111111-1111-4111-8111-111111111111','primary','v2.0.0-beta.12','" + releaseSha + "','n','2.0.0-beta.11','prepared','2026-01-01','2999-01-01','2026-01-01')");
    await assert.rejects(commitPluginChange(env, fresh, { ...add, selectionSha: "0".repeat(40) }, installed), { code: "trust_confirmation_required" });
    await assert.rejects(commitPluginChange(env, { ...fresh, authenticatedAt: Date.now() - reauthenticationWindowMs - 1_000 }, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true }, installed), { code: "reauthentication_required" });
    const result = await commitPluginChange(env, fresh, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true }, installed);
    const text = github.files.get("lancerlogin.modules.json")!;
    assert.deepEqual(JSON.parse(text), { format: 1, modules: [{ id: "carpool", source: carpoolSource, commit: pluginCommit }] });
    assert.equal(result.committed.selectionSha, blob(text));
    const audit = env.DB.sqlite.prepare("SELECT actor_user_id AS actor, metadata_json AS metadata FROM audit_log WHERE action = 'module_selection.changed'").all() as Array<{ actor: string; metadata: string }>;
    assert.equal(audit.length, 1); assert.equal(audit[0]!.actor, "admin");
    assert.deepEqual(JSON.parse(audit[0]!.metadata), { action: "add", moduleId: "carpool", source: carpoolSource, commit: pluginCommit, previousCommit: null, track: "stable", previousTrack: null, selectionSha: blob(text), repositoryCommit: "f".repeat(40) });
    assert.equal(env.DB.sqlite.prepare("SELECT state, error_code AS code FROM web_update_requests").get()?.code, "module_selection_changed");
    // Reviewing against a stale blob, or a concurrent repository edit, is refused without writing.
    await assert.rejects(commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, selectionSha: "0".repeat(40), trustConfirmed: true }, installed), { code: "selection_changed" });
    github.conflictNextPut = true;
    await assert.rejects(commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, selectionSha: blob(text), trustConfirmed: true }, installed), { code: "selection_changed" });
    assert.equal(github.files.get("lancerlogin.modules.json"), text);
    await commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, selectionSha: blob(text), trustConfirmed: true }, installed);
    assert.equal(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules[0].commit, nextCommit);
    const puts = github.calls.filter((call) => call.method === "PUT");
    assert.equal(JSON.parse(puts[0]!.body!).sha, undefined, "creating the file sends no blob SHA");
    assert.equal(JSON.parse(puts.at(-1)!.body!).sha, blob(text));
  });
});

test("the source allowlist in the private repository limits additions and an invalid list refuses all", async () => {
  const env = environment();
  await withGitHub(async (github) => {
    github.files.set("lancerlogin.plugin-sources.json", JSON.stringify({ format: 1, allowedSources: ["github.com/trusted"] }));
    await assert.rejects(reviewPluginChange(env, add, installed), { code: "source_not_allowed" });
    await assert.rejects(commitPluginChange(env, fresh, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true }, installed), { code: "source_not_allowed" });
    github.files.set("lancerlogin.plugin-sources.json", "not json");
    await assert.rejects(reviewPluginChange(env, add, installed), { code: "source_not_allowed" });
    github.files.set("lancerlogin.plugin-sources.json", JSON.stringify({ format: 1, allowedSources: ["github.com/example"] }));
    await commitPluginChange(env, fresh, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true }, installed);
    assert.equal(github.calls.some((call) => call.method === "PUT" && call.url.includes("plugin-sources")), false);
  });
});

test("changes are refused while a web update is active, and removal while the module is enabled, retained or deleting", async () => {
  const env = environment();
  await withGitHub(async (github) => {
    github.files.set("lancerlogin.modules.json", serializeSelection({ modules: [{ id: "carpool", source: carpoolSource, commit: pluginCommit }] }));
    const sha = blob(github.files.get("lancerlogin.modules.json")!);
    const withCarpool: InstalledPlugins = { ...installed, carpool: { source: carpoolSource, commit: pluginCommit, selected: true } };
    env.DB.sqlite.exec("INSERT INTO web_update_requests (id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at) VALUES ('22222222-2222-4222-8222-222222222222','primary','v2.0.0-beta.12','" + releaseSha + "','n','2.0.0-beta.11','running','2026-01-01','2999-01-01','2026-01-01')");
    await assert.rejects(commitPluginChange(env, fresh, { action: "remove", id: "carpool", selectionSha: sha }, withCarpool), { code: "update_active" });
    env.DB.sqlite.exec("UPDATE web_update_requests SET state = 'succeeded'");
    for (const [phase, extra] of [["enabled", ""], ["retained", ",disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z'"], ["deleting", ",disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z'"]] as const) {
      env.DB.sqlite.exec("DELETE FROM platform_modules WHERE module_id = 'carpool'");
      env.DB.sqlite.exec(`INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version${extra ? ",disabled_at,delete_after" : ""}) VALUES ('primary','carpool',1,1,'${phase}',1${extra ? ",'2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z'" : ""})`);
      await assert.rejects(commitPluginChange(env, fresh, { action: "remove", id: "carpool", selectionSha: sha }, withCarpool), { code: "module_in_use" });
    }
    env.DB.sqlite.exec("UPDATE platform_modules SET phase = 'deleted', disabled_at = NULL, delete_after = NULL WHERE module_id = 'carpool'");
    await commitPluginChange(env, fresh, { action: "remove", id: "carpool", selectionSha: sha }, withCarpool);
    assert.deepEqual(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules, []);
    // An official module's selection pin can be removed while enabled: it returns to LancerLogin's pin.
    github.files.set("lancerlogin.modules.json", serializeSelection({ modules: [{ id: "hour-tracking", source: outreachSource, commit: nextCommit }] }));
    env.DB.sqlite.exec("INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','hour-tracking',1,1,'enabled',1)");
    await commitPluginChange(env, fresh, { action: "remove", id: "hour-tracking", selectionSha: blob(github.files.get("lancerlogin.modules.json")!) }, installed);
    await assert.rejects(reviewPluginChange(env, { action: "remove", id: "hour-tracking" }, installed), { code: "not_selected" });
  });
});

test("routes require an active Admin, the exact dashboard Origin and fresh re-authentication, and never expose credentials", async () => {
  const env = environment();
  env.DB.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await hashPassword("correct horse battery"));
  const codec = createSessionCodec(secret);
  const stale = createSessionCodec(secret, () => Date.now() - 20 * 60_000);
  const admin = `lancerlogin_session=${await stale.issue({ userId: "admin", role: "admin" })}`;
  const operator = `lancerlogin_session=${await codec.issue({ userId: "operator", role: "operator" })}`;
  const call = (path: string, cookie: string, body?: unknown, requestOrigin = origin) => worker.fetch(new Request(`https://api.example.test${path}`, body === undefined ? { headers: { cookie } } : { method: "POST", headers: { cookie, origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  await withGitHub(async (github) => {
    assert.equal((await call("/admin/plugins", operator)).status, 403);
    const state = await call("/admin/plugins", admin);
    assert.equal(state.status, 200);
    const text = await state.text();
    for (const value of [selectionToken, dispatchToken, secret]) assert.equal(text.includes(value), false);
    const view = JSON.parse(text);
    assert.equal(view.credential.state, "ready"); assert.equal("protection" in view, false); assert.equal(view.reauthentication.freshUntil, null); assert.equal(view.reauthentication.password, true);
    assert.deepEqual(view.installed.map((item: { id: string }) => item.id), []);
    assert.equal((await call("/admin/plugins/review", admin, add, "https://evil.example")).status, 403);
    assert.equal((await call("/admin/plugins/release", admin, { id: "carpool", source: carpoolSource, track: "nightly" }, "https://evil.example")).status, 403);
    assert.equal((await call("/admin/plugins/release", operator, { id: "carpool", source: carpoolSource, track: "nightly" })).status, 403);
    const lookup = await call("/admin/plugins/release", admin, { id: "carpool", source: carpoolSource, track: "nightly" });
    assert.equal(lookup.status, 200); assert.equal((await lookup.json()).release.tag, "v1.1.0-nightly.20261025");
    assert.equal((await call("/admin/plugins/change", admin, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true })).status, 401);
    assert.equal(github.calls.some((entry) => entry.method === "PUT"), false);
    const wrong = await call("/admin/plugins/reauthenticate", admin, { password: "wrong" });
    assert.equal(wrong.status, 401); assert.equal((await wrong.json()).code, "reauthentication_failed");
    const reauth = await call("/admin/plugins/reauthenticate", admin, { password: "correct horse battery" });
    assert.equal(reauth.status, 200);
    const renewed = /lancerlogin_session=([^;]+)/.exec(reauth.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(renewed);
    const changed = await call("/admin/plugins/change", `lancerlogin_session=${renewed}`, { ...add, selectionSha: "0".repeat(40), trustConfirmed: true });
    assert.equal(changed.status, 201);
    assert.equal(JSON.stringify(await changed.json()).includes(selectionToken), false);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauthenticated'").get()?.n, 1);
    // The status never reads the production environment's protection rules.
    assert.equal(github.calls.some((entry) => entry.url.includes("/environments/")), false);
  });
});

test("the apply-plugin-changes mode prepares the installed release, pins the selection and dispatches the fixed workflow once", async () => {
  const env = environment();
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const post = (path: string, body: unknown) => worker.fetch(new Request(`https://api.example.test${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  await withGitHub(async (github) => {
    github.files.set("lancerlogin.modules.json", serializeSelection({ modules: [{ id: "carpool", source: carpoolSource, commit: pluginCommit }] }));
    assert.equal((await post("/admin/web-updates/prepare", { mode: "anything" })).status, 400);
    assert.equal((await post("/admin/web-updates/prepare", { mode: "modules", release: "v9.0.0" })).status, 400);
    const prepared = await (await post("/admin/web-updates/prepare", { mode: "modules" })).json();
    assert.equal(prepared.request.mode, "modules"); assert.equal(prepared.request.targetTag, "v2.0.0-beta.11"); assert.equal(prepared.request.targetCommit, releaseSha);
    const row = (await latestUpdate(env))!;
    assert.equal(row.module_selection_sha, blob(github.files.get("lancerlogin.modules.json")!));
    assert.equal(row.previous_version, "2.0.0-beta.11");
    // Changing the selection after preparation expires the prepared request.
    await commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: nextCommit, selectionSha: row.module_selection_sha!, trustConfirmed: true }, installed);
    assert.equal((await latestUpdate(env))!.state, "expired");
    const again = await (await post("/admin/web-updates/prepare", { mode: "modules" })).json();
    await recordUpdateBackup(env, again.request.requestId);
    await startWebUpdate(env, { requestId: again.request.requestId, backupSaved: true }, "admin");
    await startWebUpdate(env, { requestId: again.request.requestId, backupSaved: true }, "admin");
    const dispatches = github.calls.filter((entry) => entry.url.endsWith("/dispatches"));
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.authorization, `Bearer ${dispatchToken}`);
    assert.deepEqual(JSON.parse(dispatches[0]!.body!), { ref: "main", inputs: { request_id: again.request.requestId, release_tag: "v2.0.0-beta.11", release_sha: releaseSha } });
    // While that update runs, the selection cannot change.
    await assert.rejects(commitPluginChange(env, fresh, { action: "upgrade", id: "carpool", source: carpoolSource, commit: pluginCommit, selectionSha: blob(github.files.get("lancerlogin.modules.json")!), trustConfirmed: true }, installed), { code: "update_active" });
  });
});

test("plugin changes need the selection credential and an official installed release", async () => {
  const env = environment(); delete (env as Partial<Env>).MODULE_SELECTION_TOKEN;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const post = (body: unknown, target = env) => worker.fetch(new Request("https://api.example.test/admin/web-updates/prepare", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) }), target);
  await withGitHub(async () => {
    assert.equal((await (await post({ mode: "modules" })).json()).code, "selection_credential_required");
    const expired = environment(); expired.MODULE_SELECTION_TOKEN_EXPIRES_AT = "2020-01-01T00:00:00.000Z";
    assert.equal((await (await post({ mode: "modules" }, expired)).json()).code, "selection_credential_expired");
    const development = environment(); development.RELEASE_VERSION = "development";
    assert.equal((await (await post({ mode: "modules" }, development)).json()).code, "release_unavailable");
  });
});

const sqliteQuery = (database: D1) => async (sql: string, params: readonly unknown[] = []) => database.sqlite.prepare(sql).all(...params as []) as Record<string, unknown>[];
const enabledCarpool = "INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','carpool',1,1,'enabled',1); INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','kept-plan','Synthetic kept plan','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');";
const knownCarpool = () => (JSON.parse(readFileSync("scripts/known-modules.json", "utf8")) as { modules: Array<{ id: string; source: string; commit: string }> }).modules.find((entry) => entry.id === "carpool")!;

test("an extracted module counts as used by the backup definition, and a deliberately disabled one does not", async () => {
  const { extractedModulesInUse } = await import("../apps/api/src/extracted-modules.ts");
  const database = new D1(); const query = sqliteQuery(database);
  const ids = async (composed: string[] = []) => (await extractedModulesInUse(query, new Set(composed))).map((module) => module.id);
  assert.deepEqual(await ids(), []);
  database.sqlite.exec("INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','carpool',1,1,'disabled',1)");
  assert.deepEqual(await ids(), [], "disabled and never used passes");
  database.sqlite.exec("UPDATE platform_modules SET phase = 'enabled' WHERE module_id = 'carpool'");
  assert.deepEqual(await ids(), ["carpool"]);
  assert.deepEqual(await ids(["carpool"]), [], "composing the plugin keeps it");
  database.sqlite.exec("UPDATE platform_modules SET phase = 'deleted' WHERE module_id = 'carpool'");
  assert.deepEqual(await ids(), []);
  database.sqlite.exec("INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','p','Plan','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')");
  assert.deepEqual(await ids(), ["carpool"], "module rows count as use");
  database.sqlite.exec("DELETE FROM carpool_plans; INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','hour-tracking',1,1,'disabled',1); INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at) VALUES ('primary','hour-tracking','workspace',1,'completed','2026-03-01T00:00:00.000Z')");
  assert.deepEqual(await ids(), ["hour-tracking"], "setup progress counts as use");
});

test("the known plugin list names only extracted modules and agrees with the official pins", async () => {
  const known = JSON.parse(readFileSync("scripts/known-modules.json", "utf8")) as { modules: Array<{ id: string; source: string; commit: string }> };
  const official = JSON.parse(readFileSync("scripts/official-modules.json", "utf8")) as { modules: Array<{ id: string; source: string; commit: string }> };
  const { extractedModules } = await import("../apps/api/src/extracted-modules.ts");
  parseSelectionFile(JSON.stringify({ format: 1, modules: known.modules.map(({ id, source, commit }) => ({ id, source, commit })) }));
  for (const entry of known.modules) assert.ok(extractedModules.some((module) => module.id === entry.id), entry.id);
  for (const entry of official.modules) {
    const listed = known.modules.find((item) => item.id === entry.id);
    if (!listed) continue;
    assert.equal(listed.commit, entry.commit, `${entry.id} must use the official pin`);
    if (!entry.source.startsWith("file:")) assert.equal(listed.source, entry.source);
  }
});

test("updates are refused before preparation and before claim while a used extracted module would be dropped", async () => {
  const env = environment(); env.DB.sqlite.exec(enabledCarpool);
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const known = knownCarpool();
  await withGitHub(async (github) => {
    const migrations = await (await worker.fetch(new Request("https://api.example.test/admin/plugins/migrations", { headers: { cookie } }), env)).json();
    assert.deepEqual(migrations, { required: [{ id: "carpool", label: "Carpool", plugin: { source: known.source, commit: known.commit } }] });
    const refused = await worker.fetch(new Request("https://api.example.test/admin/web-updates/prepare", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}" }), env);
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, "module_migration_required");
    assert.equal(github.calls.some((call) => call.url.includes("/actions/workflows/")), false, "nothing is prepared");
    assert.equal(await latestUpdate(env), null);
  });
  // The controller refuses before claim and records a sanitized code, which the Worker keeps when the run fails.
  const { preflightModuleGuard } = await import("../scripts/run-web-upgrade.mjs");
  const id = "44444444-4444-4444-8444-444444444444";
  env.DB.sqlite.exec(`INSERT INTO web_update_requests (id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,started_at,run_id,backup_exported_at) VALUES ('${id}','primary','v2.0.0-beta.12','${releaseSha}','n','2.0.0-beta.11','queued','2026-01-01','2999-01-01','2026-01-01','2026-01-01','91','2026-01-01')`);
  const record = async (code: string) => { env.DB.sqlite.prepare("UPDATE web_update_requests SET error_code = ? WHERE id = ? AND executor_run_id IS NULL").run(code, id); };
  await assert.rejects(preflightModuleGuard({ query: sqliteQuery(env.DB), composed: ["hour-tracking"], record }), /module_migration_required/);
  await preflightModuleGuard({ query: sqliteQuery(env.DB), composed: ["hour-tracking", "carpool"], record: async () => assert.fail("no diagnostic when composed") });
  assert.equal(env.DB.sqlite.prepare("SELECT executor_run_id AS claimed FROM web_update_requests WHERE id = ?").get(id)?.claimed, null);
  const { webUpdateStatus } = await import("../apps/api/src/web-updates.ts");
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/actions\/runs\/91$/);
    return Response.json({ status: "completed", conclusion: "failure", path: ".github/workflows/upgrade-web.yml", display_title: `LancerLogin web update ${id}`, event: "workflow_dispatch" });
  };
  try { const view = await webUpdateStatus(env); assert.equal(view.latestCompletedRequest?.state, "failed"); assert.equal(view.latestCompletedRequest?.errorCode, "module_migration_required:carpool"); }
  finally { globalThis.fetch = previous; }
});

test("keeping a used extracted module through the plugin flow lets the update proceed", async () => {
  const env = environment(); env.DB.sqlite.exec(enabledCarpool);
  const known = knownCarpool();
  await withGitHub(async (github) => {
    github.pluginPackage = 404;
    const { requiredModuleMigrations } = await import("../apps/api/src/plugin-selection.ts");
    assert.equal((await requiredModuleMigrations(env, installed)).length, 1);
    await commitPluginChange(env, fresh, { action: "add", id: "carpool", source: known.source, commit: known.commit, selectionSha: "0".repeat(40), trustConfirmed: true }, installed);
    assert.deepEqual(await requiredModuleMigrations(env, installed), []);
    assert.deepEqual(JSON.parse(github.files.get("lancerlogin.modules.json")!).modules, [{ id: "carpool", source: known.source, commit: known.commit }]);
  });
});

test("Google re-authentication must sign in the same Admin and returns to Settings > Modules freshly authenticated", async () => {
  const { encryptIntegration } = await import("../apps/api/src/integration-crypto.ts");
  const env = environment(); (env as unknown as { INTEGRATION_KEY: string }).INTEGRATION_KEY = secret;
  const encrypted = await encryptIntegration({ clientId: "client-id", clientSecret: "client-secret" }, secret);
  env.DB.sqlite.exec("UPDATE installations SET auth_mode = 'google', google_enabled = 1; UPDATE users SET email = 'admin@example.test' WHERE id = 'admin'; UPDATE users SET email = 'operator@example.test' WHERE id = 'operator'");
  env.DB.sqlite.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, updated_at) VALUES ('google-1','primary','google',?,?,'2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  const stale = `lancerlogin_session=${await createSessionCodec(secret, () => Date.now() - 20 * 60_000).issue({ userId: "admin", role: "admin" })}`;
  assert.equal((await worker.fetch(new Request("https://api.example.test/auth/google/start?reauth=modules"), env)).status, 401, "re-authentication needs the current Admin session");
  const started = await worker.fetch(new Request("https://api.example.test/auth/google/start?reauth=modules", { headers: { cookie: stale } }), env);
  assert.equal(started.status, 302);
  const cookies = started.headers.getSetCookie();
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  assert.ok(cookies.some((value) => value.startsWith("lancerlogin_oauth_reauth=admin;")));
  const callbackCookie = `lancerlogin_oauth_state=${state}; lancerlogin_oauth_reauth=admin`;
  const previous = globalThis.fetch;
  for (const [email, expected] of [["operator@example.test", 403], ["admin@example.test", 302]] as const) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return calls === 1 ? Response.json({ id_token: "google-token" }) : Response.json({ aud: "client-id", email, email_verified: "true", iss: "https://accounts.google.com" }); };
    try {
      const callback = await worker.fetch(new Request(`https://api.example.test/auth/google/callback?code=one-time&state=${encodeURIComponent(state)}`, { headers: { cookie: callbackCookie } }), env);
      assert.equal(callback.status, expected);
      if (expected === 302) {
        assert.equal(callback.headers.get("location"), `${origin}/settings/modules?reauthenticated=1`);
        const session = /lancerlogin_session=([^;]+)/.exec(callback.headers.getSetCookie().join("\n"))![1]!;
        const principal = await createSessionCodec(secret).verify(session);
        assert.ok(principal && freshUntil(principal));
        assert.ok(callback.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_oauth_reauth=;")));
      }
    } finally { globalThis.fetch = previous; }
  }
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauthenticated'").get()?.n, 1);
});
