import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const kioskArchitectures = ["arm64", "armv7"];

async function checksum(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
async function writeChecksum(directory, name) {
  await writeFile(join(directory, `${name}.sha256`), `${await checksum(join(directory, name))}  ${name}\n`);
}
async function checkChecksum(directory, name) {
  const expected = `${await checksum(join(directory, name))}  ${name}`;
  if ((await readFile(join(directory, `${name}.sha256`), "utf8")).trim() !== expected) throw new Error(`Checksum mismatch: ${name}`);
}

// Exercise the extracted service's real module graph and HTTP handlers with no
// checkout imports, pairing credentials, hardware access, or background polling.
function unprivilegedIdentity(required) {
  if (!required) return undefined;
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Unprivileged artifact verification requires Linux root to drop service privileges");
  const uid = Number(execFileSync("id", ["-u", "nobody"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "nobody"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) throw new Error("Artifact smoke requires a non-root service identity");
  return { uid, gid };
}

async function normalizePackageModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalizePackageModes(path);
    else await chmod(path, entry.name.endsWith(".sh") ? 0o755 : 0o644);
  }
}

async function checkPackageModes(directory, relative = ".") {
  if (process.platform === "win32") return; // Windows ACLs cannot establish Linux tar permission safety.
  const info = await stat(directory);
  const expected = info.isDirectory() || relative.endsWith(".sh") ? 0o755 : 0o644;
  if ((info.mode & 0o7777) !== expected) throw new Error(`Unsafe kiosk artifact mode: ${relative} must be ${expected.toString(8)}`);
  if (info.isDirectory()) for (const name of await readdir(directory)) await checkPackageModes(join(directory, name), `${relative}/${name}`);
}

export async function smokeKioskDirectory(directory, { requireUnprivileged = false } = {}) {
  const identity = unprivilegedIdentity(requireUnprivileged);
  const state = await mkdtemp(join(tmpdir(), "lancerlogin-kiosk-state-"));
  try {
    if (identity) await chown(state, identity.uid, identity.gid);
    const env = { NODE_ENV: "test", LANCERLOGIN_SENSOR_PATH: "disabled" };
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
    for (const key of ["CONFIG", "BRANDING", "NETWORK_PIN", "QUEUE", "MAPPINGS"]) env[`LANCERLOGIN_${key}`] = join(state, `${key}.json`);
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      if (${JSON.stringify(Boolean(identity))}) {
        assert.equal(process.getuid(), ${identity?.uid ?? 0});
        assert.equal(process.getgid(), ${identity?.gid ?? 0});
        process.chdir(${JSON.stringify(directory)});
        const { stat } = await import("node:fs/promises");
        assert.notEqual((await stat(".")).uid, process.getuid(), "runtime must be owned by a different account");
      }
      const { server } = await import(${JSON.stringify(pathToFileURL(join(directory, "src/service.mjs")).href)});
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      try {
        const base = "http://127.0.0.1:" + server.address().port;
        const health = await fetch(base + "/health");
        assert.equal(health.status, 200);
        assert.equal((await health.json()).paired, false);
        for (const path of ["/", "/app.js", "/styles.css", "/network.js", "/recovery.js"]) {
          const response = await fetch(base + path);
          assert.equal(response.status, 200, path);
          assert.ok((await response.text()).length > 0, path);
        }
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    `], { cwd: directory, env, ...identity, timeout: 15_000, stdio: "pipe" });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

export async function verifyKioskArtifacts({ artifacts, version, requireUnprivileged = false }) {
  for (const arch of kioskArchitectures) {
    const name = `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`;
    await checkChecksum(artifacts, name);
    const extracted = await mkdtemp(join(tmpdir(), "lancerlogin-kiosk-extracted-"));
    try {
      execFileSync("tar", ["-xzf", join(artifacts, name), "-C", extracted], { stdio: "pipe" });
      await checkPackageModes(extracted);
      for (const path of ["scripts/lancerlogin-install-release.sh", "systemd/lancerlogin-kiosk.service", "systemd/lancerlogin-update.service", "polkit/49-lancerlogin-network.rules", "polkit/49-lancerlogin-recovery.rules", "polkit/49-lancerlogin-update.rules"]) await readFile(join(extracted, path));
      await smokeKioskDirectory(extracted, { requireUnprivileged });
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  }
  await checkChecksum(artifacts, "install-lancerlogin.sh");
  if (process.platform !== "win32" && ((await stat(join(artifacts, "install-lancerlogin.sh"))).mode & 0o111) !== 0o111) throw new Error("Installer is not executable");
  const installer = await readFile(join(artifacts, "install-lancerlogin.sh"), "utf8");
  if (!installer.includes(`VERSION="\${LANCERLOGIN_VERSION:-${version}}"`)) throw new Error("Installer version mismatch");
}

export async function packageKioskArtifacts({ output, version, sourceRoot = repositoryRoot, requireUnprivileged = false }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid kiosk package version");
  // A new directory prevents leftover files from an earlier release being shipped.
  await mkdir(output);
  const staging = await mkdtemp(join(tmpdir(), "lancerlogin-kiosk-package-"));
  const artifacts = resolve(output);
  try {
    for (const directory of ["src", "scripts", "systemd", "polkit"]) await mkdir(join(staging, directory));
    const kiosk = join(sourceRoot, "apps/kiosk");
    for (const entry of await readdir(join(kiosk, "src"), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) await copyFile(join(kiosk, "src", entry.name), join(staging, "src", entry.name));
      if (entry.isDirectory()) throw new Error("Kiosk runtime subdirectories require explicit packaging support");
    }
    await copyFile(join(kiosk, "scripts/lancerlogin-install-release.sh"), join(staging, "scripts/lancerlogin-install-release.sh"));
    for (const [directory, suffix] of [["systemd", ".service"], ["polkit", ".rules"]]) {
      for (const name of await readdir(join(kiosk, directory))) if (name.endsWith(suffix)) await copyFile(join(kiosk, directory, name), join(staging, directory, name));
    }
    await normalizePackageModes(staging);
    for (const arch of kioskArchitectures) {
      const name = `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`;
      execFileSync("tar", ["-czf", join(artifacts, name), "-C", staging, "."], { stdio: "pipe" });
      await writeChecksum(artifacts, name);
    }
    const installer = (await readFile(join(kiosk, "scripts/install-lancerlogin.sh"), "utf8")).replace(/^VERSION=.*$/m, `VERSION="\${LANCERLOGIN_VERSION:-${version}}"`).replaceAll("\r\n", "\n");
    await writeFile(join(artifacts, "install-lancerlogin.sh"), installer);
    await chmod(join(artifacts, "install-lancerlogin.sh"), 0o755);
    await writeChecksum(artifacts, "install-lancerlogin.sh");
    await verifyKioskArtifacts({ artifacts, version, requireUnprivileged });
    return artifacts;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  const output = resolve(process.argv[2] ?? "release/artifacts");
  await mkdir(dirname(output), { recursive: true });
  await packageKioskArtifacts({ output, version, requireUnprivileged: process.argv.includes("--require-unprivileged") });
  console.log(`Packaged and verified both kiosk architectures for ${version}: ${output}`);
}
