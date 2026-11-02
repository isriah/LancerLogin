import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, compareSnapshots, composedPins, expectComposedPins, expectedRemovals, parseArguments, refSource, removeTree, renderReport, verifyAttendanceInput, wranglerEnvironment } from "../scripts/rehearse-update.mjs";

test("arguments require both trees and a well-formed target tag", () => {
  assert.deepEqual(parseArguments(["--from", "v2.0.0-beta.12", "--to", "origin/main", "--target-tag", "v2.0.0-beta.13", "--keep"]), { from: "v2.0.0-beta.12", to: "origin/main", targetTag: "v2.0.0-beta.13", keep: true });
  assert.throws(() => parseArguments(["--from", "v1.0.0"]), /--from <ref> --to <ref>/);
  assert.throws(() => parseArguments(["--from", "a", "--to", "b", "--target-tag", "2.0.0"]), /--target-tag/);
  assert.throws(() => parseArguments(["--from", "a", "--to", "b", "--deploy"]), /Unknown argument --deploy/);
});

test("release tags come from the public repository and other refs from this one", () => {
  assert.deepEqual(refSource("v2.0.0-beta.12"), { repository: "public", name: "v2.0.0-beta.12" });
  assert.deepEqual(refSource("public:main"), { repository: "public", name: "main" });
  assert.deepEqual(refSource("origin/main"), { repository: "private", name: "origin/main" });
  assert.deepEqual(refSource("private:v2.0.0"), { repository: "private", name: "v2.0.0" });
});

test("children never receive credentials and wrangler cannot reach Cloudflare", () => {
  const env = childEnvironment({ PATH: "p", CLOUDFLARE_API_TOKEN: "x", GITHUB_TOKEN: "x", LANCERLOGIN_PLUGIN_TOKEN: "x", SESSION_KEY: "x", GIT_DIR: "x", CI: "true" });
  assert.deepEqual(env, { PATH: "p" });
  const wrangler = wranglerEnvironment("home");
  assert.equal(wrangler.CLOUDFLARE_API_BASE_URL, "http://127.0.0.1:1");
  assert.equal(wrangler.WRANGLER_HOME, "home"); assert.equal(wrangler.WRANGLER_HIDE_BANNER, "true");
  assert.equal("CLOUDFLARE_API_TOKEN" in wrangler, false);
});

test("snapshot comparison reports lost tables, rows and changed key records", () => {
  const record = (rows) => ({ columns: ["id", "name"], rows: rows.map((row) => JSON.stringify(row)) });
  const before = { tables: ["members", "gone"], counts: { members: 2, gone: 1 }, records: { members: record([["1", "A"], ["2", "B"]]) } };
  const same = { tables: ["members", "gone", "fresh"], counts: { members: 3, gone: 1, fresh: 0 }, records: { members: { columns: ["id", "name", "extra"], rows: [JSON.stringify(["1", "A", 0]), JSON.stringify(["2", "B", 0]), JSON.stringify(["3", "C", 0])] } } };
  const kept = compareSnapshots(before, same);
  assert.deepEqual(kept.problems, []);
  assert.ok(kept.notes.some((note) => note.includes("new table fresh")));
  const changed = compareSnapshots(before, { tables: ["members"], counts: { members: 1 }, records: { members: record([["1", "Z"]]) } });
  assert.equal(changed.problems.length, 3);
});

test("tables a migration drops or prunes on purpose are notes, not problems", () => {
  const before = { tables: ["simulated_kiosk_sessions", "pairing_codes", "members"], counts: { simulated_kiosk_sessions: 1, pairing_codes: 3, members: 2 }, records: {} };
  const after = { tables: ["pairing_codes", "members"], counts: { pairing_codes: 2, members: 1 }, records: {} };
  const diff = compareSnapshots(before, after, { allowRemoved: expectedRemovals });
  assert.deepEqual(diff.problems, ["members: 2 rows before, 1 after"]);
  assert.ok(diff.notes.some((note) => note.includes("table simulated_kiosk_sessions removed as expected")));
  assert.ok(diff.notes.some((note) => note.includes("pairing_codes: 1 rows removed as expected")));
});

test("a plugin catalog row is expected to move to the pin TO composes, and nothing else may change", () => {
  const columns = ["module_id", "origin", "source", "source_commit", "installed"];
  const outreach = "https://example.test/outreach.git"; const carpool = "https://example.test/carpool.git";
  const catalog = (rows) => ({ tables: ["platform_module_catalog"], counts: { platform_module_catalog: rows.length }, records: { platform_module_catalog: { columns, rows: rows.map((row) => JSON.stringify(row)).sort() } } });
  const before = catalog([["attendance", "first-party", null, null, 1], ["carpool", "external", carpool, "c".repeat(40), 1], ["hour-tracking", "external", outreach, "a".repeat(40), 1]]);
  const pins = composedPins({ modules: [{ id: "hour-tracking", source: outreach, commit: "a".repeat(40) }] }, { modules: [{ id: "carpool", source: carpool, commit: "c".repeat(40) }, { id: "hour-tracking", source: outreach, commit: "b".repeat(40) }] });
  assert.equal(pins.get("hour-tracking").commit, "b".repeat(40));
  const moved = catalog([["attendance", "first-party", null, null, 1], ["carpool", "external", carpool, "c".repeat(40), 1], ["hour-tracking", "external", outreach, "b".repeat(40), 1]]);
  assert.deepEqual(compareSnapshots(expectComposedPins(before, pins), moved).problems, []);
  assert.equal(compareSnapshots(before, moved).problems.length, 1);
  const kept = catalog([["attendance", "first-party", null, null, 1], ["carpool", "external", carpool, "c".repeat(40), 1], ["hour-tracking", "external", outreach, "a".repeat(40), 1]]);
  assert.equal(compareSnapshots(expectComposedPins(before, pins), kept).problems.length, 1);
  const uninstalled = catalog([["attendance", "first-party", null, null, 1], ["carpool", "external", carpool, "c".repeat(40), 0], ["hour-tracking", "external", outreach, "b".repeat(40), 1]]);
  assert.equal(compareSnapshots(expectComposedPins(before, pins), uninstalled).problems.length, 1);
});

/** A FROM Worker's API, answering only the Attendance input setup calls the rehearsal makes. */
function setupApi(simulator) {
  const calls = [];
  return {
    calls,
    async ok(method, path, body, options) {
      calls.push({ method, path, body, options });
      if (method === "GET" && path === "/module-setup/attendance/input") return simulator ? { mode: "browser", simulator: null, members: [], meetings: [] } : { kiosks: [] };
      if (path === "/admin/pairing-codes") return { code: "ABCD2345", kind: "web" };
      if (path === "/kiosk/pair") return { kioskId: "setup-kiosk", kioskToken: "token" };
      return {};
    },
  };
}

test("Attendance input setup uses the simulator when the FROM release has it, and a paired web kiosk otherwise", async () => {
  const withSimulator = setupApi(true); const seeded = { currentMeeting: "meeting-1" };
  assert.equal(await verifyAttendanceInput(withSimulator, seeded), "simulator");
  assert.deepEqual(withSimulator.calls.slice(1).map((call) => call.body?.action), ["start", "scan"]);
  assert.equal(seeded.setupKioskId, undefined);

  const withoutSimulator = setupApi(false); const later = { currentMeeting: "meeting-1" };
  assert.equal(await verifyAttendanceInput(withoutSimulator, later), "kiosk");
  assert.deepEqual(withoutSimulator.calls.map((call) => `${call.method} ${call.path}`), ["GET /module-setup/attendance/input", "POST /admin/pairing-codes", "POST /kiosk/pair", "POST /kiosk/heartbeat"]);
  assert.deepEqual(withoutSimulator.calls[1].body, { kioskName: "Rehearsal setup kiosk", kind: "web" });
  assert.equal(withoutSimulator.calls[3].options.headers.authorization, "Bearer token");
  assert.equal(later.setupKioskId, "setup-kiosk");
});

test("removing the work folder unlinks links without following them", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearse-update-test-"));
  const outside = await mkdtemp(join(tmpdir(), "rehearse-update-outside-"));
  try {
    await writeFile(join(outside, "keep.txt"), "keep");
    const work = join(root, "work");
    await mkdir(join(work, "node_modules"), { recursive: true });
    await symlink(outside, join(work, "node_modules", "linked"), "junction");
    await writeFile(join(work, "file.txt"), "remove");
    await removeTree(work);
    assert.equal(existsSync(work), false);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the report lists what the rehearsal does not cover", () => {
  const text = renderReport({ options: { from: "a", to: "b" }, trees: {}, steps: [], checks: [{ name: "x", passed: true, detail: "" }], notes: [], outbound: [], startedAt: "now" });
  assert.match(text, /## Not covered/);
  assert.match(text, /Physical kiosks/);
});
