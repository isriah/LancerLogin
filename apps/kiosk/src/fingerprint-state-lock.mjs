import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const fail = () => { throw new Error("Fingerprint state lock requires protected local recovery"); };
const protectedDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;

// Linux flock belongs to the open file description. The child acquires it on
// an inherited descriptor; the parent keeps that same description open until
// release. SIGKILL and power loss cannot leave an acquired kernel lock behind.
// A persistent directory is created atomically, unlike a partially written
// marker file. Never remove its inode: that would split concurrent owners.
export async function acquireFingerprintStateLock(path) {
  if (process.platform !== "linux") {
    const file = await open(path, "wx", 0o600);
    return { close: async () => { await file.close(); await unlink(path); } };
  }
  const parent = await lstat(dirname(path));
  if (!protectedDirectory(parent)) return fail();
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  let file;
  try {
    const entry = await lstat(path);
    if (!protectedDirectory(entry)) return fail();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const actual = await file.stat();
    if (!protectedDirectory(actual) || actual.ino !== entry.ino || actual.dev !== entry.dev) return fail();
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", file.fd], timeout: 2000,
    });
    if (result.error || result.signal || result.status !== 0) throw new Error("Fingerprint state is busy or its operating-system lock is unavailable");
    const current = await lstat(path);
    if (current.ino !== actual.ino || current.dev !== actual.dev) return fail();
    return file;
  } catch (error) { await file?.close(); throw error; }
}
