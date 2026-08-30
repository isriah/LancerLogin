import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("foundation documents state standalone constraints", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /standalone/i);
  assert.match(readme, /sensor/i);
});

test("provisioning workflow remains mock-only", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  assert.match(workflow, /dry-run/);
  assert.doesNotMatch(workflow, /cloudflare\.com/i);
});
