import assert from "node:assert/strict";
import { executeWebUpgrade } from "./run-web-upgrade.mjs";

/** No provider IO: useful before a separately authorized isolated/live rehearsal. */
export function syntheticUpgradeIO({ failAt, initialVersion = "0.23.2" } = {}) {
  const installation = { version: initialVersion, attendance: ["synthetic-check-in"], pairing: "synthetic-pairing", keyIdentity: "synthetic-existing-key", claim: null, state: "queued", maintenance: 0, stages: [], recovery: null, mutations: 0 };
  const step = async (name) => { installation.stages.push(name); if (name === failAt) throw new Error("synthetic_failure"); };
  const io = {
    preflight: () => step("preflight"),
    async claim(context) { await step("claim"); if (installation.claim) return false; installation.claim = context.runId; return true; },
    async state(state, stage, maintenance) { installation.state = state; installation.maintenance = maintenance; installation.stage = stage; },
    build: () => step("build"), drain: () => step("drain"),
    async checkpoint() { await step("checkpoint"); return { databaseBookmark: "synthetic-bookmark", workerVersionIds: ["synthetic-previous-worker"], pagesDeploymentId: "synthetic-previous-pages" }; },
    async saveRecovery(recovery) { await step("saveRecovery"); installation.recovery = recovery; },
    async migrate() { await step("migrate"); installation.mutations++; },
    async deployApi(context) { await step("deployApi"); installation.version = context.tag.slice(1); installation.mutations++; },
    async deployPages() { await step("deployPages"); installation.mutations++; },
    health: () => step("health"),
  };
  return { installation, io };
}
export async function rehearseSyntheticWebUpgrade() {
  const evidence = [];
  for (const [previous, tag] of [["0.23.2", "v0.24.0"], ["0.24.0", "v1.0.0"]]) {
    const { installation, io } = syntheticUpgradeIO({ initialVersion: previous });
    const context = { runId: "synthetic-run", tag };
    assert.equal((await executeWebUpgrade(context, io)).succeeded, true);
    assert.equal((await executeWebUpgrade(context, io)).duplicate, true);
    assert.deepEqual(installation.attendance, ["synthetic-check-in"]); assert.equal(installation.pairing, "synthetic-pairing");
    assert.equal(installation.keyIdentity, "synthetic-existing-key"); assert.equal(installation.maintenance, 0);
    assert.equal(installation.mutations, 3);
    evidence.push({ previous, target: tag, verified: true, duplicateMutation: false, synthetic: true });
  }
  for (const failAt of ["preflight", "build", "drain", "checkpoint", "saveRecovery", "migrate", "deployApi", "deployPages", "health"]) {
    const { installation, io } = syntheticUpgradeIO({ failAt });
    await assert.rejects(executeWebUpgrade({ runId: "synthetic-run", tag: "v0.24.0" }, io));
    const uncertainMutation = ["migrate", "deployApi", "deployPages", "health"].includes(failAt);
    if (uncertainMutation) { assert.equal(installation.state, "recovery_required"); assert.equal(installation.maintenance, 1); }
    assert.deepEqual(installation.attendance, ["synthetic-check-in"]); assert.equal(installation.keyIdentity, "synthetic-existing-key");
    evidence.push({ stage: failAt, state: installation.state, maintenance: installation.maintenance, automaticDatabaseRestore: false, synthetic: true });
  }
  return { kind: "synthetic-only", providerAcceptance: false, cases: evidence };
}
if (process.argv[1]?.endsWith("rehearse-web-upgrade.mjs")) rehearseSyntheticWebUpgrade().then((result) => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error("Synthetic web-upgrade rehearsal failed."); process.exitCode = 1; });
