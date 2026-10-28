// Opt-in Git hooks for this checkout: `npm run hooks:install` points core.hooksPath at the tracked .githooks
// directory, `npm run hooks:uninstall` removes that setting. Nothing installs this automatically.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const hooksPath = ".githooks";
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const current = (root) => { try { return git(root, ["config", "--get", "core.hooksPath"]); } catch { return ""; } };

export function installHooks(root = defaultRoot) {
  const existing = current(root);
  if (existing && existing !== hooksPath) throw new Error(`core.hooksPath is already ${existing}; leaving it unchanged.`);
  git(root, ["config", "core.hooksPath", hooksPath]);
  return `Installed: pre-push runs the quick check. Bypass once with git push --no-verify; remove with npm run hooks:uninstall.`;
}

export function uninstallHooks(root = defaultRoot) {
  const existing = current(root);
  if (!existing) return "No hooks path is set.";
  if (existing !== hooksPath) throw new Error(`core.hooksPath is ${existing}, not ${hooksPath}; leaving it unchanged.`);
  git(root, ["config", "--unset", "core.hooksPath"]);
  return "Uninstalled the LancerLogin Git hooks.";
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || !["install", "uninstall"].includes(action)) throw new Error("Usage: node scripts/git-hooks.mjs install|uninstall");
    console.log(action === "install" ? installHooks() : uninstallHooks());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
