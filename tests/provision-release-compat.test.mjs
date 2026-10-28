import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { archivedProvisionProblems, archivedUpgradeProblems, compositionGuardInstalled, missingReleaseFiles, provisionReleaseRequirements } from "../scripts/check-provision-release-compat.mjs";
import { compositionRefusal, continuousIntegration } from "../scripts/check-module-composition.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// File lists from the immutable official v1.0.5 and v1.2.6 tags, limited to the package manifests and scripts directory.
const common = ["package-lock.json", "package.json", "scripts/audit-dependencies.mjs", "scripts/cloudflare-resource-state.mjs", "scripts/d1-maintenance.mjs", "scripts/database-identity.mjs", "scripts/package-kiosk.mjs", "scripts/prepare-cloudflare-provision.mjs", "scripts/prepare-pages-proxy.mjs", "scripts/provision-plan.mjs", "scripts/recover-web-update.mjs", "scripts/refresh-web-update-credential.mjs", "scripts/rehearse-web-upgrade.mjs", "scripts/reset-local-password.mjs", "scripts/run-browser-tests.mjs", "scripts/run-web-upgrade.mjs", "scripts/select-cloudflare-account.mjs", "scripts/verify-d1-migrations.mjs", "scripts/verify-template-config.mjs", "scripts/web-upgrade-policy.json"];
const stableReleases = {
  "v1.0.5": common,
  "v1.2.6": [...common, "scripts/d1-usage-report.mjs", "scripts/release-channel.mjs", "scripts/run-web-tests.mjs"]
};

test("installation workflow runs only files present in every selectable stable release", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  const requirements = provisionReleaseRequirements(workflow);
  assert.equal(requirements.templateRelease, "v1.0.5");
  assert.ok(requirements.required.includes("scripts/prepare-cloudflare-provision.mjs"));
  assert.ok(requirements.required.includes("scripts/refresh-web-update-credential.mjs"));
  assert.ok(requirements.required.includes("package-lock.json"));
  assert.deepEqual(requirements.guarded, ["scripts/check-provision-modules.mjs", "scripts/compose-modules.mjs", "scripts/ensure-fingerprint-vault-key.mjs"]);
  for (const [tag, files] of Object.entries(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), [], tag);
});

test("an unguarded script missing from an older release is reported", async () => {
  const workflow = (await readFile(".github/workflows/provision-template.yml", "utf8")).replace(/if \[ -f scripts\/ensure-fingerprint-vault-key\.mjs \]; then/, "if true; then");
  const requirements = provisionReleaseRequirements(workflow);
  for (const files of Object.values(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), ["scripts/ensure-fingerprint-vault-key.mjs"]);
  assert.deepEqual(missingReleaseFiles(requirements, [...stableReleases["v1.2.6"], "scripts/ensure-fingerprint-vault-key.mjs"]), []);
});

test("an unguarded plugin composition step missing from an older release is reported", async () => {
  const workflow = (await readFile(".github/workflows/provision-template.yml", "utf8")).replace(/if \[ -f scripts\/compose-modules\.mjs \]; then/, "if true; then");
  const requirements = provisionReleaseRequirements(workflow);
  for (const files of Object.values(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), ["scripts/compose-modules.mjs"]);
  assert.deepEqual(missingReleaseFiles(requirements, [...stableReleases["v1.2.6"], "scripts/compose-modules.mjs"]), []);
});

test("steps that run from the controller checkout are not release requirements", () => {
  const workflow = [
    "jobs:",
    "  provision:",
    "    defaults:",
    "      run:",
    "        working-directory: lancerlogin-source",
    "    steps:",
    "      - name: Controller step",
    "        working-directory: .",
    "        run: node scripts/controller-only.mjs",
    "      - name: Release step",
    "        run: node scripts/release-only.mjs"
  ].join("\n");
  assert.deepEqual(provisionReleaseRequirements(workflow).required, ["package.json", "scripts/release-only.mjs"]);
});

// The shape of the installation workflow published with v1.0.6 to v2.0.0-beta.11: no composition, the dashboard workspace
// build, then D1 migrations and deployment.
const archivedProvision = [
  "jobs:", "  provision:", "    defaults:", "      run:", "        working-directory: lancerlogin-source", "    steps:",
  "      - run: npm ci",
  "      - name: Build dashboard before migration or deployment", "        run: npm --workspace @lancerlogin/dashboard run build",
  "      - name: Build API before migration or deployment", "        run: npx wrangler deploy --dry-run --outdir .provision/api-build --config .provision/wrangler.json",
  "      - name: Apply D1 migrations", "        run: npx wrangler d1 migrations apply example-data --remote --config .provision/wrangler.json",
  "      - name: Install or refresh the private dispatch credential", "        run: node scripts/refresh-web-update-credential.mjs",
].join("\n");
test("archived installation workflows must compose or reach this release's composition guard before migrations", async () => {
  const hasFile = () => true;
  assert.equal(await compositionGuardInstalled(), true, "this release's dashboard build carries the guard");
  assert.deepEqual(archivedProvisionProblems(archivedProvision, { guardInstalled: true, hasFile }), []);
  assert.deepEqual(archivedProvisionProblems(archivedProvision, { guardInstalled: false, hasFile }), ["builds without plugin composition and reaches D1 migrations without the composition guard"]);
  // Building only after migrations does not protect them.
  const lateBuild = archivedProvision.replace("npm --workspace @lancerlogin/dashboard run build", "echo skipped") + "\n      - run: npm --workspace @lancerlogin/dashboard run build";
  assert.equal(archivedProvisionProblems(lateBuild, { guardInstalled: true, hasFile }).length, 1);
  // A composing workflow (the current template) is safe without the guard.
  assert.deepEqual(archivedProvisionProblems(await readFile(".github/workflows/provision-template.yml", "utf8"), { guardInstalled: false, hasFile }), []);
  // A script the old workflow runs after migrations and this release lacks would stop it halfway.
  assert.deepEqual(archivedProvisionProblems(archivedProvision, { guardInstalled: true, hasFile: (path) => path !== "scripts/refresh-web-update-credential.mjs" }),
    ["runs scripts/refresh-web-update-credential.mjs after D1 migrations, which this release lacks"]);
});

test("archived update workflows that run an older controller runner must reach the guard before migrating", () => {
  const releaseRunner = "      - run: node deployment-control/scripts/run-web-upgrade.mjs --validate\n      - run: node lancerlogin-source/scripts/run-web-upgrade.mjs\n";
  assert.deepEqual(archivedUpgradeProblems(releaseRunner, "", { guardInstalled: false }), []);
  const controllerRunner = "      - run: node deployment-control/scripts/run-web-upgrade.mjs --validate\n      - run: node deployment-control/scripts/run-web-upgrade.mjs\n";
  const builds = 'await io.build(context); await io.migrate(context); command("npm", ["--workspace", "@lancerlogin/dashboard", "run", "build"])';
  assert.deepEqual(archivedUpgradeProblems(controllerRunner, builds, { guardInstalled: true }), []);
  assert.equal(archivedUpgradeProblems(controllerRunner, builds, { guardInstalled: false }).length, 1);
  assert.equal(archivedUpgradeProblems(controllerRunner, "await io.migrate(context); await io.build(context);", { guardInstalled: true }).length, 1);
  assert.equal(archivedUpgradeProblems(controllerRunner, undefined, { guardInstalled: true }).length, 1);
});

test("a CI build without module composition is refused, with an explicit plugin-free development opt-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-composition-guard-"));
  try {
    await mkdir(join(root, "scripts")); await mkdir(join(root, ".provision")); await mkdir(join(root, "packages/shared/src/generated"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    await writeFile(join(root, "scripts/official-modules.json"), JSON.stringify({ format: 1, modules: [{ id: "hour-tracking" }] }));
    await writeFile(join(root, "packages/shared/src/generated/external-manifests.ts"), "export const externalModuleManifests = [];\n");
    const ci = { GITHUB_ACTIONS: "true", CI: "true" };
    assert.equal(compositionRefusal({ root, env: {} }), undefined, "local development builds are unaffected");
    assert.equal(compositionRefusal({ root, env: ci }), "module composition did not run");
    assert.equal(compositionRefusal({ root, env: { CI: "1" } }), "module composition did not run");
    assert.equal(compositionRefusal({ root, env: { ...ci, LANCERLOGIN_PLUGIN_FREE_BUILD: "1" } }), undefined);
    assert.equal(compositionRefusal({ root, env: { ...ci, LANCERLOGIN_PLUGIN_FREE_BUILD: "true" } }), "module composition did not run");
    await writeFile(join(root, ".provision/module-migrations.json"), JSON.stringify({ format: 1, core: { version: "2.0.0-beta.12" }, modules: [] }));
    assert.match(compositionRefusal({ root, env: ci }), /does not match this LancerLogin version/);
    await writeFile(join(root, ".provision/module-migrations.json"), JSON.stringify({ format: 1, core: { version: "2.0.0" }, modules: [{ id: "hour-tracking" }] }));
    assert.match(compositionRefusal({ root, env: ci }), /hour-tracking is missing from the generated module list/);
    await writeFile(join(root, "packages/shared/src/generated/external-manifests.ts"), "import { manifest as module_hour_tracking } from 'synthetic';\nexport const externalModuleManifests = [module_hour_tracking];\n");
    assert.equal(compositionRefusal({ root, env: ci }), undefined);
    // A selection that opts out of official modules composes nothing and is still a composition.
    await writeFile(join(root, ".provision/module-migrations.json"), JSON.stringify({ format: 1, core: { version: "2.0.0" }, modules: [] }));
    assert.equal(compositionRefusal({ root, env: ci }), undefined);
    await rm(join(root, ".provision/module-migrations.json"));
    await writeFile(join(root, "scripts/official-modules.json"), JSON.stringify({ format: 1, modules: [] }));
    assert.equal(compositionRefusal({ root, env: ci }), undefined, "a release with no official modules builds the same either way");
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(continuousIntegration({ CI: "false" }), false);
  assert.equal(continuousIntegration({ GITHUB_ACTIONS: "true" }), true);
  const dashboard = JSON.parse(await readFile("apps/dashboard/package.json", "utf8"));
  const api = JSON.parse(await readFile("apps/api/package.json", "utf8"));
  for (const scripts of [dashboard.scripts, api.scripts]) assert.equal(scripts.prebuild, "node ../../scripts/check-module-composition.mjs");
  assert.match((await readFile(".github/workflows/ci.yml", "utf8")).replace(/\r\n/g, "\n"), /^env:\n(?: {2}#[^\n]*\n)* {2}LANCERLOGIN_PLUGIN_FREE_BUILD: "1"$/m);
});

test("the installation upgrade path checks for a used module that moved into a plugin before it builds or migrates", async () => {
  const workflow = (await readFile(".github/workflows/provision-template.yml", "utf8")).replace(/\r\n/g, "\n");
  const steps = workflow.split(/\n(?= {6}- )/);
  const index = (pattern) => steps.findIndex((step) => pattern.test(step));
  const guard = index(/node scripts\/check-provision-modules\.mjs/);
  assert.ok(guard > index(/node scripts\/compose-modules\.mjs/));
  assert.ok(guard < index(/npm --workspace @lancerlogin\/dashboard run build/));
  assert.ok(guard < index(/d1 migrations apply/));
  assert.match(steps[guard], /if: inputs\.operation != 'create'/);
  assert.match(steps[guard], /\[ -f scripts\/check-provision-modules\.mjs \]/);
});
