import { readdir, readFile, lstat, mkdtemp, mkdir, copyFile, open, rename, chmod, chown, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Remove only stand-alone development version assignments. Other service
// settings are preserved; compound assignments require explicit local review.
export function withoutDevelopmentVersionOverrides(text) {
  return text.split(/(?<=\n)/).map(line => {
    if (!/^\s*Environment\s*=/.test(line) || !line.includes("LANCERLOGIN_VERSION=")) return line;
    const match = /^\s*Environment\s*=\s*(?:"LANCERLOGIN_VERSION=([^"\r\n]+)"|'LANCERLOGIN_VERSION=([^'\r\n]+)'|LANCERLOGIN_VERSION=([^\s"']+))\s*$/.exec(line);
    if (!match) throw new Error("Review the compound kiosk version override before installing");
    const value = match[1] ?? match[2] ?? match[3];
    return /^\d+\.\d+\.\d+-dev\.[a-z0-9.-]+$/.test(value) ? "" : line;
  }).join("");
}

export async function cleanDevelopmentVersionOverrides(directory, backupRoot) {
  const pending = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".conf") || name === "10-version.conf") continue;
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Review non-regular kiosk service overrides before installing");
    const before = await readFile(path, "utf8"), after = withoutDevelopmentVersionOverrides(before);
    if (after !== before) pending.push({ name, path, info, after });
  }
  if (!pending.length) return { changed: 0 };
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = await mkdtemp(join(backupRoot, "lancerlogin-version-overrides-"));
  await chmod(backup, 0o700);
  for (const item of pending) await copyFile(item.path, join(backup, item.name));
  for (const item of pending) {
    const temporary = item.path + ".version-update-" + randomUUID();
    try {
      const file = await open(temporary, "wx", item.info.mode & 0o777);
      try { await file.writeFile(item.after); await file.sync(); } finally { await file.close(); }
      if (process.platform !== "win32") await chown(temporary, item.info.uid, item.info.gid);
      await rename(temporary, item.path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  return { changed: pending.length, backup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error("Run the installer as root without helper arguments");
  const result = await cleanDevelopmentVersionOverrides("/etc/systemd/system/lancerlogin-kiosk.service.d", "/var/backups");
  if (result.changed) console.log(`Archived ${result.changed} obsolete development version overrides in ${result.backup}`);
}
