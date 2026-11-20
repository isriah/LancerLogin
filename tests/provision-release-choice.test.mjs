import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareReleaseVersions, newestOfficialRelease } from "../packages/shared/src/release-policy.mjs";
import { findShell, requireTool, toolSkip } from "./fixtures/host-tools.mjs";

// The installation workflow's release choice (latest stable or latest beta), its Beta-track rule and its no-downgrade
// rule live in the workflow itself, because they run before any release is checked out. These tests run the shell and
// the Node.js policy the workflow ships, against stubs for GitHub, Cloudflare and the installation.
const workflowPath = ".github/workflows/provision-template.yml";
const stepsOf = (workflow) => workflow.replace(/\r\n/g, "\n").split(/\n(?= {6}- )/).slice(1);
const provisionStep = async (name) => {
  const step = stepsOf(await readFile(workflowPath, "utf8")).find((entry) => entry.includes(`name: ${name}`));
  assert.ok(step, name);
  return step;
};
const runBlock = (step) => {
  const lines = step.split("\n"); const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  return lines.slice(start + 1).map((line) => line.slice(10)).join("\n");
};
const embeddedPolicySource = async () => runBlock(await provisionStep("Resolve the public release")).match(/<<'EOF'\n([\s\S]*?)\nEOF\n/)[1];
async function embeddedPolicy(t) {
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-release-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "release-policy.cjs"), await embeddedPolicySource());
  return createRequire(import.meta.url)(join(root, "release-policy.cjs"));
}
const officialRelease = (tag, overrides = {}) => {
  const version = tag.slice(1);
  const names = ["install-lancerlogin.sh", ...["arm64", "armv7"].map((arch) => `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`)].flatMap((name) => [name, `${name}.sha256`]);
  return { tag_name: tag, draft: false, prerelease: tag.includes("-beta."), immutable: true, assets: names.map((name) => ({ name })), body: "", ...overrides };
};

test("the release input offers latest stable and latest beta, and nothing else", async () => {
  const workflow = (await readFile(workflowPath, "utf8")).replace(/\r\n/g, "\n");
  const input = workflow.slice(workflow.indexOf("      release:\n"), workflow.indexOf("      installation_slug:\n"));
  assert.match(input, /default: latest stable\n/);
  assert.deepEqual([...input.matchAll(/^ {10}- (.+)$/gm)].map((match) => match[1]), ["latest stable", "latest beta"]);
});

test("the workflow's embedded release policy orders versions exactly as the product does", async (t) => {
  const policy = await embeddedPolicy(t);
  const versions = ["v1.2.6", "v2.0.0-beta.9", "v2.0.0-beta.10", "v2.0.0", "v2.0.1", "v2.1.0-beta.2", "v2.1.0-beta.9", "v2.1.0-beta.10", "v2.1.0", "2.1.0", "v10.0.0", "v2.1.0-rc.1", "v2.1", "v02.1.0", "v2.1.0-beta.01", "v2.1.0-nightly.20261101", "main", "", "v2.1.0+build", `v${"9".repeat(30)}.0.0`];
  for (const left of versions) for (const right of versions) assert.equal(policy.compare(left, right), compareReleaseVersions(left, right), `${left} against ${right}`);
  assert.equal(policy.compare("v2.1.0-beta.10", "v2.1.0-beta.9"), 1);
  assert.equal(policy.compare("v2.1.0", "v2.1.0-beta.10"), 1);
  assert.equal(policy.compare("v2.0.1", "v2.1.0-beta.2"), -1);
  // /health reports a bare version; a development build or anything else is not an installed release.
  assert.equal(policy.installed({ releaseVersion: "2.1.0-beta.9" }), "2.1.0-beta.9");
  for (const health of [{ releaseVersion: "development" }, { releaseVersion: "v2.1.0" }, { releaseVersion: "2.1.0-dev.main.abcdef1" }, {}, null, []]) assert.equal(policy.installed(health), undefined);
  // Cloudflare's Worker settings carry the same release as the one plain-text RELEASE_VERSION variable.
  const settings = (...bindings) => ({ success: true, result: { bindings } });
  const release = (text, type = "plain_text") => ({ name: "RELEASE_VERSION", type, text });
  assert.equal(policy.configured(settings({ name: "ALLOWED_ORIGIN", type: "plain_text", text: "https://example-club-dashboard.pages.dev" }, release("2.1.0-beta.9"))), "2.1.0-beta.9");
  for (const value of [settings(), settings(release("development")), settings(release("2.1.0", "secret_text")), settings(release("2.1.0"), release("2.0.1")), { success: false, result: { bindings: [release("2.1.0")] } }, { success: true }, null]) assert.equal(policy.configured(value), undefined);
});

test("latest beta resolves to the newest complete official release across stable and beta, like the dashboard's Beta track", async (t) => {
  const policy = await embeddedPolicy(t);
  const feeds = {
    "a beta is newest": [officialRelease("v2.1.0-beta.9"), officialRelease("v2.1.0-beta.10"), officialRelease("v2.0.1"), officialRelease("v2.1.0-beta.2")],
    "a stable release is newest": [officialRelease("v2.1.0-beta.10"), officialRelease("v2.1.0"), officialRelease("v2.0.1")],
    "publication order is ignored": [officialRelease("v2.0.2"), officialRelease("v2.1.0-beta.3"), officialRelease("v2.0.1")],
    "a draft is skipped": [officialRelease("v2.1.0-beta.11", { draft: true }), officialRelease("v2.1.0-beta.10")],
    "a beta that is not immutable is skipped": [officialRelease("v2.1.0-beta.11", { immutable: false }), officialRelease("v2.1.0-beta.10")],
    "a beta not flagged as a prerelease is skipped": [officialRelease("v2.1.0-beta.11", { prerelease: false }), officialRelease("v2.1.0-beta.10")],
    "a stable tag flagged as a prerelease is skipped": [officialRelease("v2.2.0", { prerelease: true }), officialRelease("v2.1.0-beta.10")],
    "a release missing an asset is skipped": [officialRelease("v2.1.0-beta.11", { assets: officialRelease("v2.1.0-beta.11").assets.slice(1) }), officialRelease("v2.1.0-beta.10")],
    "a release without an asset list is skipped": [officialRelease("v2.1.0-beta.11", { assets: undefined }), officialRelease("v2.1.0-beta.10")],
    "non-canonical tags are skipped": [officialRelease("2.2.0"), officialRelease("v2.2.0-rc.1"), officialRelease("v2.2.0-nightly.20261101"), officialRelease("v2.1.0-beta.10"), null, "v9.9.9"],
    "a stable release need not be immutable": [officialRelease("v2.1.0", { immutable: false }), officialRelease("v2.1.0-beta.10")],
    "nothing official": [officialRelease("v2.1.0-beta.11", { draft: true })],
    "empty": [],
  };
  for (const [name, feed] of Object.entries(feeds)) assert.equal(policy.newest([feed]), newestOfficialRelease(feed, "beta")?.tag, name);
  assert.equal(policy.newest([feeds["a beta is newest"]]), "v2.1.0-beta.10");
  assert.equal(policy.newest([feeds["a stable release is newest"]]), "v2.1.0");
  assert.equal(policy.newest([feeds["a beta that is not immutable is skipped"]]), "v2.1.0-beta.10");
  assert.equal(policy.newest([feeds["nothing official"]]), undefined);
  // Every page counts, and a full last page cannot prove a newest release.
  const full = Array.from({ length: 100 }, (_, index) => officialRelease(`v1.0.${index}`));
  assert.equal(policy.newest([full, [officialRelease("v2.1.0-beta.10")]]), "v2.1.0-beta.10");
  assert.equal(policy.newest([full]), undefined);
  assert.equal(policy.newest([]), undefined);
  assert.equal(policy.newest([{ message: "rate limited" }]), undefined);
});

const bash = findShell("bash");
const shellEnvironment = (values) => bash.env({ ...process.env, ...values });
const spawnScript = (root, script, values) => spawnSync(bash.path, [script], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, env: shellEnvironment(values) });

test("latest beta is refused for create and resume before anything else is checked", { skip: toolSkip(bash) }, async (t) => {
  requireTool(bash);
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-release-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "validate.sh"), `set -eo pipefail\n${runBlock(await provisionStep("Validate deployment request"))}\n`);
  const run = (operation, release, slug = "example-club") => spawnScript(root, "validate.sh", { INPUT_OPERATION: operation, RELEASE_SELECTION: release, INSTALLATION_SLUG: slug,
    CLOUDFLARE_API_TOKEN: "cfat_synthetic", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), LANCERLOGIN_SETUP_CODE: "synthetic-setup-code" });
  for (const operation of ["create", "resume"]) {
    const refused = run(operation, "latest beta");
    assert.equal(refused.status, 1, operation);
    assert.match(refused.stdout, new RegExp(`^::error title=beta_requires_upgrade::The release latest beta is available only with the operation upgrade, and ${operation} always installs the latest stable release\\. .*choose the Beta track in Settings > Updates > Update track first`, "m"));
    // Refused ahead of every other input: an invalid slug is not reported first.
    assert.match(run(operation, "latest beta", "X").stdout, /^::error title=beta_requires_upgrade::/);
    assert.equal(run(operation, "latest stable").status, 0, operation);
  }
  for (const release of ["latest stable", "latest beta"]) assert.equal(run("upgrade", release).status, 0, release);
  for (const release of ["", "latest", "v2.1.0-beta.10", "latest nightly"]) {
    const invalid = run("upgrade", release);
    assert.equal(invalid.status, 1, release);
    assert.match(invalid.stdout, /^::error title=release_selection_invalid::Choose latest stable or latest beta as the release/m, release);
  }
});

test("the release step installs the newest official release for latest beta and GitHub Latest for latest stable", { skip: toolSkip(bash) }, async (t) => {
  requireTool(bash);
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-release-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Stub for GitHub: the release list by page, GitHub Latest, the tag's release and its commit.
  const stub = [
    "gh() {",
    "  printf '%s\\n' \"$2\" >> gh-calls.txt",
    "  case \"$2\" in",
    "    *'releases?per_page=100&page='*) cat \"feed/page-${2##*page=}.json\" ;;",
    "    */releases/latest) printf '%s\\n' \"$LATEST\" ;;",
    "    */releases/tags/*) printf '%s\\n' \"${2##*/}\" ;;",
    "    */commits/*) printf '%s\\n' 0123456789abcdef0123456789abcdef01234567 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
  ].join("\n");
  await writeFile(join(root, "resolve.sh"), `set -eo pipefail\n${stub}\n${runBlock(await provisionStep("Resolve the public release"))}\n`);
  const run = async (release, pages = []) => {
    await rm(join(root, "feed"), { recursive: true, force: true }); await mkdir(join(root, "feed"));
    for (const [index, page] of pages.entries()) await writeFile(join(root, "feed", `page-${index + 1}.json`), typeof page === "string" ? page : JSON.stringify(page));
    for (const name of ["output.txt", "env.txt", "gh-calls.txt"]) await writeFile(join(root, name), "");
    const result = spawnScript(root, "resolve.sh", { RELEASE_SELECTION: release, LATEST: "v2.0.1", RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "output.txt"), GITHUB_ENV: join(root, "env.txt") });
    const text = async (name) => (await readFile(join(root, name), "utf8")).replace(/\r/g, "");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: await text("output.txt"), env: await text("env.txt"), calls: await text("gh-calls.txt") };
  };
  const beta = await run("latest beta", [[officialRelease("v2.0.1"), officialRelease("v2.1.0-beta.9"), officialRelease("v2.1.0-beta.10"), officialRelease("v2.1.0-beta.11", { draft: true })]]);
  assert.equal(beta.status, 0, beta.stderr);
  assert.equal(beta.output, "sha=0123456789abcdef0123456789abcdef01234567\ntag=v2.1.0-beta.10\n");
  assert.equal(beta.env, "RELEASE_TAG=v2.1.0-beta.10\nRELEASE_KIND=a beta release\n");
  assert.match(beta.stdout, /Using LancerLogin v2\.1\.0-beta\.10, a beta release\./);
  assert.doesNotMatch(beta.calls, /releases\/latest/);
  // The Beta track offers stable releases too: when the newest release is stable, that is what is installed.
  const stableOnBeta = await run("latest beta", [[officialRelease("v2.1.0"), officialRelease("v2.1.0-beta.10")]]);
  assert.equal(stableOnBeta.env, "RELEASE_TAG=v2.1.0\nRELEASE_KIND=a stable release\n");
  // A second page is read when the first is full.
  const paged = await run("latest beta", [Array.from({ length: 100 }, (_, index) => officialRelease(`v1.0.${index}`)), [officialRelease("v2.1.0-beta.10")]]);
  assert.equal(paged.env, "RELEASE_TAG=v2.1.0-beta.10\nRELEASE_KIND=a beta release\n");
  assert.match(paged.calls, /page=1\n.*page=2\n/);
  for (const pages of [[[officialRelease("v2.1.0-beta.10", { immutable: false })]], [[]], ["{\"message\":\"rate limited\"}"], []]) {
    const invalid = await run("latest beta", pages);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /^::error title=release_invalid::/m);
    assert.equal(invalid.env, "");
  }
  const stable = await run("latest stable");
  assert.equal(stable.status, 0, stable.stderr);
  assert.equal(stable.env, "RELEASE_TAG=v2.0.1\nRELEASE_KIND=a stable release\n");
  assert.doesNotMatch(stable.calls, /per_page/);
  assert.match((await run("v2.1.0-beta.10")).stdout, /^::error title=release_selection_invalid::/m);
});

test("latest beta needs the Beta track, and neither choice moves an installation to an older release", { skip: toolSkip(bash) }, async (t) => {
  requireTool(bash);
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-release-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".provision"));
  await writeFile(join(root, "release-policy.cjs"), await embeddedPolicySource());
  // Stubs: npx answers the two read-only D1 queries from TRACK (none means a release from before update tracks); curl
  // writes the Worker's /health, or fails when HEALTH is empty; for Cloudflare's Worker settings it answers with SETTINGS,
  // or HTTP 500 when that is empty.
  const stubs = [
    "npx() {",
    "  printf '%s\\n' \"$*\" >> npx-calls.txt",
    "  case \"$*\" in",
    "    *sqlite_master*) if [ \"$TRACK\" = none ]; then printf '[{\"results\":[{\"tables\":0}]}]'; else printf '[{\"results\":[{\"tables\":1}]}]'; fi ;;",
    "    *update_channel*) printf '[{\"results\":[{\"update_channel\":\"%s\"}]}]' \"$TRACK\" ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "curl() {",
    "  local out url; while [ $# -gt 0 ]; do [ \"$1\" = --output ] && out=$2; url=$1; shift; done; printf '%s\\n' \"$url\" >> curl-calls.txt",
    "  case \"$url\" in",
    "    */settings) if [ -n \"$SETTINGS\" ]; then printf '%s' \"$SETTINGS\" > \"$out\"; printf 200; else printf 500; fi ;;",
    "    *) [ -n \"$HEALTH\" ] || return 22; printf '%s' \"$HEALTH\" > \"$out\" ;;",
    "  esac",
    "}",
  ].join("\n");
  const step = await provisionStep("Check the update track and refuse a downgrade before any cloud mutation");
  await writeFile(join(root, "guard.sh"), `set -eo pipefail\n${stubs}\n${runBlock(step)}\n`);
  const run = async ({ operation = "upgrade", release, target, installed, configured, track = "stable", subdomain = "example-account" }) => {
    await writeFile(join(root, ".provision/workers-subdomain.txt"), subdomain);
    for (const name of ["npx-calls.txt", "curl-calls.txt"]) await writeFile(join(root, name), "");
    const result = spawnScript(root, "guard.sh", { INPUT_OPERATION: operation, RELEASE_SELECTION: release, RELEASE_TAG: target, INSTALLATION_SLUG: "example-club", DATABASE_NAME: "", RUNNER_TEMP: root, TRACK: track,
      CLOUDFLARE_API_TOKEN: "cfat_synthetic", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), SETTINGS: configured === undefined ? "" : JSON.stringify({ success: true, result: { bindings: [{ name: "RELEASE_VERSION", type: "plain_text", text: configured }] } }),
      HEALTH: installed === undefined ? "" : JSON.stringify({ ok: true, releaseVersion: installed }) });
    const text = async (name) => (await readFile(join(root, name), "utf8")).replace(/\r/g, "");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, npx: await text("npx-calls.txt"), curl: await text("curl-calls.txt") };
  };
  // The Beta-track rule. A release from before update tracks has no settings table and counts as Stable.
  for (const track of ["stable", "none"]) {
    const refused = await run({ release: "latest beta", target: "v2.1.0-beta.10", installed: "2.1.0-beta.9", track });
    assert.equal(refused.status, 1, track);
    assert.match(refused.stdout, /^::error title=beta_track_required::This installation is on the Stable update track, so the release latest beta is refused and nothing was changed\. In the dashboard, open Settings > Updates > Update track, choose Beta and save it, then run this workflow again\./m);
    assert.equal(refused.curl, "", "refused before the installed release is read");
  }
  const upgraded = await run({ release: "latest beta", target: "v2.1.0-beta.10", installed: "2.1.0-beta.9", track: "beta" });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /Update track: Beta\.\r?\nInstalled release v2\.1\.0-beta\.9, read from https:\/\/example-club-api\.example-account\.workers\.dev\/health\.\r?\nThis run installs v2\.1\.0-beta\.10\./);
  assert.match(upgraded.npx, /wrangler d1 execute example-club-data --remote --json --config \.provision\/wrangler\.json --command SELECT update_channel FROM installation_update_settings WHERE installation_id = 'primary'/);
  assert.equal(upgraded.curl, "https://example-club-api.example-account.workers.dev/health\n");
  // latest stable reads no track: Stable and Beta installations may both take a newer stable release.
  const stable = await run({ release: "latest stable", target: "v2.1.0", installed: "2.1.0-beta.9", track: "beta" });
  assert.equal(stable.status, 0, stable.stderr);
  assert.equal(stable.npx, "");
  // No downgrade, for either choice. Before this rule, latest stable moved an installation on a newer beta backwards.
  const stableDowngrade = await run({ release: "latest stable", target: "v2.0.1", installed: "2.1.0-beta.9", track: "beta" });
  assert.equal(stableDowngrade.status, 1);
  assert.match(stableDowngrade.stdout, /^::error title=release_downgrade_refused::This installation already runs LancerLogin v2\.1\.0-beta\.9, which is newer than v2\.0\.1, the release that latest stable selects\. Nothing was changed, because LancerLogin is never downgraded\. Wait for a stable release newer than v2\.1\.0-beta\.9, or to install a newer beta choose the release latest beta with the operation upgrade\./m);
  const betaDowngrade = await run({ release: "latest beta", target: "v2.1.0-beta.10", installed: "2.1.0", track: "beta" });
  assert.equal(betaDowngrade.status, 1);
  assert.match(betaDowngrade.stdout, /^::error title=release_downgrade_refused::This installation already runs LancerLogin v2\.1\.0, which is newer than v2\.1\.0-beta\.10, the release that latest beta selects\. .* Wait for a newer release\./m);
  // resume redeploys too, so it is held to the same rule.
  assert.equal((await run({ operation: "resume", release: "latest stable", target: "v2.0.1", installed: "2.1.0-beta.9" })).status, 1);
  // The same release is not a downgrade: the run says so and redeploys it (module changes, a refused Pages binding).
  for (const [release, target, installed] of [["latest stable", "v2.0.1", "2.0.1"], ["latest beta", "v2.1.0-beta.10", "2.1.0-beta.10"]]) {
    const same = await run({ release, target, installed, track: "beta" });
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, new RegExp(`^::notice title=release_already_installed::This installation already runs LancerLogin ${target.replaceAll(".", "\\.")}, the release that ${release} selects\\. No newer release is available`, "m"));
  }
  // A Worker that does not answer with a release: its Cloudflare settings still name the release, so the rule holds.
  const settingsUrl = `https://api.cloudflare.com/client/v4/accounts/${"0".repeat(32)}/workers/scripts/example-club-api/settings\n`;
  for (const installed of [undefined, "development"]) {
    const fallback = await run({ release: "latest stable", target: "v2.0.1", installed, configured: "2.1.0-beta.9" });
    assert.equal(fallback.status, 1, String(installed));
    assert.match(fallback.stdout, /^::error title=release_downgrade_refused::This installation already runs LancerLogin v2\.1\.0-beta\.9/m);
    assert.equal(fallback.curl, `https://example-club-api.example-account.workers.dev/health\n${settingsUrl}`);
  }
  const repaired = await run({ release: "latest beta", target: "v2.1.0-beta.10", installed: undefined, configured: "2.1.0-beta.9", track: "beta" });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Installed release v2\.1\.0-beta\.9, read from the Worker's RELEASE_VERSION setting, because https:\/\/example-club-api\.example-account\.workers\.dev\/health did not answer with a release\./);
  // Neither source gives a release. latest beta is never a repair, so it stops. latest stable is also the recovery route
  // for a Worker that cannot answer, and had no such check before, so it warns and continues, for upgrade and resume.
  for (const [installed, configured] of [[undefined, undefined], ["development", "development"]]) {
    const beta = await run({ release: "latest beta", target: "v2.1.0-beta.10", installed, configured, track: "beta" });
    assert.equal(beta.status, 1);
    assert.match(beta.stdout, /^::error title=installed_release_unreadable::Upgrade stopped before any change because the release this installation runs could not be read from https:\/\/example-club-api\.example-account\.workers\.dev\/health or from the Worker's settings/m);
    for (const operation of ["upgrade", "resume"]) {
      const stableRun = await run({ operation, release: "latest stable", target: "v2.0.1", installed, configured });
      assert.equal(stableRun.status, 0, stableRun.stderr);
      assert.match(stableRun.stdout, new RegExp(`^::warning title=installed_release_unreadable::.* could not confirm that v2\\.0\\.1 is not a downgrade\\. It continues, because ${operation} with the release latest stable is also how an installation whose Worker does not answer is repaired\\.`, "m"));
      assert.doesNotMatch(stableRun.stdout, /::error/);
    }
  }
  // An unusable workers.dev subdomain is never fetched; the settings still answer.
  const unsafeSubdomain = await run({ release: "latest stable", target: "v2.0.1", installed: "2.0.0", configured: "2.1.0", subdomain: "example.test/x" });
  assert.equal(unsafeSubdomain.status, 1);
  assert.equal(unsafeSubdomain.curl, settingsUrl);
  assert.match(unsafeSubdomain.stdout, /^::error title=release_downgrade_refused::/m);
});

test("the track and downgrade check only reads, runs before any cloud mutation, and the summary names the release kind", async () => {
  const steps = stepsOf(await readFile(workflowPath, "utf8"));
  const index = (name) => { const found = steps.findIndex((step) => step.includes(`name: ${name}`)); assert.ok(found >= 0, name); return found; };
  const guard = index("Check the update track and refuse a downgrade before any cloud mutation");
  assert.match(steps[guard], /if: steps\.resources\.outputs\.worker == 'exists'/);
  assert.ok(guard > index("Check for resource collisions"));
  for (const later of ["Build dashboard before migration or deployment", "Create Pages project", "Create D1 database", "Apply D1 migrations", "Deploy existing Worker API without rotating secrets"]) assert.ok(guard < index(later), later);
  assert.doesNotMatch(steps[guard], /wrangler (?:d1 create|d1 migrations|deploy|pages|secret)|-X |--request |--data|INSERT|UPDATE |DELETE/);
  // One policy decides the order in both steps: the file the release step writes before any release is checked out.
  const release = index("Resolve the public release");
  assert.match(steps[release], /cat > "\$RUNNER_TEMP\/release-policy\.cjs" <<'EOF'/);
  assert.match(steps[guard], /node "\$RUNNER_TEMP\/release-policy\.cjs" compare "\$RELEASE_TAG" "v\$installed"/);
  assert.ok(release < index("Check out the selected public release"));
  assert.doesNotMatch(steps[release], /secrets\./);
  assert.match(steps[index("Publish setup links")], /echo "- Release: \$RELEASE_TAG \(\$RELEASE_KIND\)"/);
});
