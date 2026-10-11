import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Only these physical runtime/artifact suites are omitted. API pairing,
// simulator, security, migration and recovery coverage stays in the web gate.
export const kioskOnlyTests = [
  "tests/kiosk-artifacts.test.mjs",
  "tests/kiosk-runtime.test.mjs",
];

export function discoverWebTests(root = process.cwd()) {
  const groups = [
    { directory: "tests", extension: ".test.mjs", options: [] },
    { directory: "tests-ts", extension: ".test.ts", options: ["--experimental-strip-types"] },
  ].map(({ directory, extension, options }) => {
    const files = readdirSync(join(root, directory), { recursive: true })
      .map((file) => directory + "/" + file.replaceAll("\\", "/"))
      .filter((file) => file.endsWith(extension))
      .sort();
    return { options, files };
  });
  const discovered = new Set(groups.flatMap(({ files }) => files));
  for (const file of kioskOnlyTests) {
    if (!discovered.has(file)) {
      throw new Error("Missing kiosk suite: " + file + ". Review the web test selection.");
    }
  }
  return groups.map(({ options, files }) => {
    const selected = files.filter((file) => !kioskOnlyTests.includes(file));
    if (!selected.length) throw new Error("Web test selection must include both JavaScript and TypeScript tests.");
    return { options, files: selected };
  });
}

export function runWebTests({ root = process.cwd(), list = false } = {}) {
  const groups = discoverWebTests(root);
  console.log("Web development coverage (not release verification):");
  for (const { files } of groups) {
    for (const file of files) console.log("  " + file);
  }
  console.log("Physical kiosk suites reserved for verify:kiosk and full release verification:");
  for (const file of kioskOnlyTests) console.log("  " + file);
  if (list) return 0;

  for (const { options, files } of groups) {
    const result = spawnSync(process.execPath, [...options, "--test", ...files], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error("Web tests failed" + (result.signal ? " (" + result.signal + ")" : "") + ".");
      return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--list")) {
      throw new Error("Usage: node scripts/run-web-tests.mjs [--list]");
    }
    process.exitCode = runWebTests({ list: args[0] === "--list" });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
