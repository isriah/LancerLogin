import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const disabledWorkflows = [
  "refresh-web-update-credential.yml",
  "upgrade-web.yml",

  "docs.yml",
  "provision-template.yml",
  "release.yml",
];

test("development automation permits only verification and archives every inherited mutation job", async () => {
  const workflows = (await readdir(".github/workflows")).filter((file) => /\.ya?ml$/.test(file)).sort();
  assert.deepEqual(workflows, ["ci.yml"],
    "Review new workflows for development isolation and update this inventory explicitly");

  const references = (await readdir(".github/disabled-workflows")).filter((file) => /\.ya?ml$/.test(file)).sort();
  assert.deepEqual(references, [...disabledWorkflows].sort());

  for (const file of disabledWorkflows) {
    const workflow = await readFile(`.github/disabled-workflows/${file}`, "utf8");
    const jobs = workflow.split(/^jobs:\s*\r?$/m)[1];
    assert.ok(jobs, `${file} must have a jobs mapping`);
    const blocks = [...jobs.matchAll(/^  ([\w-]+):\s*\r?\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/gm)];
    assert.ok(blocks.length > 0, `${file} must have explicit jobs to inspect`);
    for (const [, job, body] of blocks) {
      const conditions = [...body.matchAll(/^    if: (.+)\r?$/gm)].map((match) => match[1].trim());
      assert.deepEqual(conditions, ["${{ false }}"], `${file}:${job} must always skip, including manual dispatch`);
    }
  }

  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(ci, /if: \$\{\{ false \}\}/);
  assert.match(ci, /run: npm run verify:all/);
  assert.match(ci, /run: npm run test:browser/);
});

test("checked-in API defaults have no deployment identity or live resource binding", async () => {
  const config = JSON.parse(await readFile("apps/api/wrangler.jsonc", "utf8"));
  assert.equal(config.name, "lancerlogin-api-placeholder");
  assert.deepEqual(config.vars, { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "http://localhost:5173" });
  for (const field of ["account_id", "d1_databases", "routes", "route", "env", "services", "r2_buckets"]) {
    assert.equal(config[field], undefined, `${field} must be generated only for an explicitly approved destination`);
  }
});
