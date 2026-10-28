import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

// Every workflow pins the same exact Node release as .node-version. Workflows keep a literal version instead of
// node-version-file because adopters copy provision-template.yml, upgrade-web.yml and refresh-web-update-credential.yml
// into deployment repositories, and several workflows check out their tools under a subdirectory, where a version file
// path would not resolve.
const workflowDirectory = ".github/workflows";

async function agreedVersion() {
  const version = (await readFile(".node-version", "utf8")).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, ".node-version must hold one exact version");
  return version;
}

/** The setup-node steps of a workflow, each with its line number and the node-version values it declares. */
function setupNodeSteps(workflow) {
  const lines = workflow.split(/\r?\n/);
  const steps = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].match(/^(\s*)- /);
    if (!start) continue;
    const indent = start[1].length;
    let end = index + 1;
    while (end < lines.length && (lines[end].trim() === "" || lines[end].match(/^\s*/)[0].length > indent)) end++;
    const body = lines.slice(index, end).join("\n");
    if (!/\buses:\s*actions\/setup-node@/.test(body)) continue;
    steps.push({
      line: index + 1,
      versions: [...body.matchAll(/\bnode-version:\s*["']?([^\s,"'}]+)/g)].map((match) => match[1]),
      versionFile: /\bnode-version-file:/.test(body)
    });
  }
  return steps;
}

test("every workflow setup-node step pins the agreed exact Node version", async () => {
  const version = await agreedVersion();
  const files = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/.test(name)).sort();
  let checked = 0;
  for (const name of files) {
    const workflow = await readFile(`${workflowDirectory}/${name}`, "utf8");
    const steps = setupNodeSteps(workflow);
    assert.equal(steps.length, (workflow.match(/actions\/setup-node@/g) ?? []).length, `${name}: every setup-node use is a parsed step`);
    for (const step of steps) {
      const where = `${name}:${step.line}`;
      assert.equal(step.versionFile, false, `${where}: use a literal node-version, not node-version-file`);
      assert.deepEqual(step.versions, [version], `${where}: node-version must be exactly ${version}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "found setup-node steps to check");
});

test("adopter-copied workflows pin the agreed version", async () => {
  const version = await agreedVersion();
  for (const name of ["provision-template.yml", "upgrade-web.yml", "refresh-web-update-credential.yml"]) {
    const steps = setupNodeSteps(await readFile(`${workflowDirectory}/${name}`, "utf8"));
    assert.ok(steps.length > 0, `${name} sets up Node`);
    for (const step of steps) assert.deepEqual(step.versions, [version], `${name}:${step.line}`);
  }
});

test("development guide names the agreed version", async () => {
  const version = await agreedVersion();
  assert.match(await readFile("docs/DEVELOPMENT.md", "utf8"), new RegExp(`Node\\.js ${version.replaceAll(".", "\\.")}\\b`));
});

test("the step parser reports unpinned, floating and file-based versions", () => {
  const workflow = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: actions/setup-node@v7",
    "        with: { node-version: 24, cache: npm }",
    "      - uses: actions/setup-node@v7",
    "      - uses: actions/setup-node@v7",
    "        with:",
    "          node-version-file: .node-version",
    "      - name: Quoted",
    "        uses: actions/setup-node@v7",
    "        with:",
    "          node-version: \"24.22.1\"",
    "          cache: npm"
  ].join("\n");
  assert.deepEqual(setupNodeSteps(workflow), [
    { line: 5, versions: ["24"], versionFile: false },
    { line: 7, versions: [], versionFile: false },
    { line: 8, versions: [], versionFile: true },
    { line: 11, versions: ["24.22.1"], versionFile: false }
  ]);
});
