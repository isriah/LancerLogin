import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { credentialHelp, verifyCredentialTarget } from "./refresh-web-update-credential.mjs";
import { reportFailure } from "./workflow-annotations.mjs";

export const fingerprintVaultSecretName = "FINGERPRINT_VAULT_KEY";
export const fingerprintVaultStateSql = "SELECT COALESCE((SELECT MAX(enabled) FROM kiosk_fingerprint_vault_settings),0) AS enabled, (SELECT COUNT(*) FROM kiosk_fingerprint_vault_templates) AS stored";

/** Called only under the installation's exclusive provisioning/update lock. */
export async function ensureFingerprintVaultKey(io) {
  const names = await io.listSecretNames();
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw new Error("vault_secret_metadata_invalid");
  if (names.includes(fingerprintVaultSecretName)) return { status: "retained" };
  const state = await io.readVaultState();
  if (!state || ![0, 1].includes(state.enabled) || !Number.isSafeInteger(state.stored) || state.stored < 0) throw new Error("vault_state_unavailable");
  // A missing key with existing authority is recovery, never permission to rotate.
  if (state.enabled || state.stored) throw new Error("vault_original_key_recovery_required");
  const bytes = randomBytes(32);
  try {
    await io.putSecret(fingerprintVaultSecretName, bytes.toString("base64url"));
  } finally { bytes.fill(0); }
  const retained = await io.listSecretNames();
  if (!Array.isArray(retained) || !retained.includes(fingerprintVaultSecretName)) throw new Error("vault_secret_write_unconfirmed");
  return { status: "created" };
}

/** Fixed-resource CLI adapter; key material goes only to the child's stdin. */
export async function installFingerprintVaultKey(environment, { request = fetch, runWrangler = wranglerCommand, readConfig = (path) => readFile(path, "utf8") } = {}) {
  if (environment.REPOSITORY_PRIVATE !== "true") throw new Error("private_installation_required");
  const configPath = environment.WEB_UPDATE_CONFIG;
  if (!configPath) throw new Error("fixed_worker_configuration_required");
  const config = JSON.parse(await readConfig(configPath));
  const databases = config.d1_databases?.filter((binding) => binding.binding === "DB");
  if (config.name !== `${environment.INSTALLATION_SLUG}-api` || databases?.length !== 1) throw new Error("fixed_worker_configuration_required");
  const target = { ...environment, DATABASE_ID: databases[0].database_id };
  await verifyCredentialTarget(target, request);
  const args = ["--config", resolve(configPath)];
  const result = await ensureFingerprintVaultKey({
    listSecretNames: async () => {
      const document = JSON.parse(await runWrangler(["secret", "list", "--format", "json", ...args], target));
      if (!Array.isArray(document)) throw new Error("vault_secret_metadata_invalid");
      return document.map((entry) => entry.name);
    },
    readVaultState: async () => {
      const response = await request(`https://api.cloudflare.com/client/v4/accounts/${target.CLOUDFLARE_ACCOUNT_ID}/d1/database/${target.DATABASE_ID}/query`, {
        method: "POST", headers: { authorization: `Bearer ${target.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sql: fingerprintVaultStateSql }), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("vault_state_unavailable");
      const document = await response.json();
      if (document.success !== true || document.result?.length !== 1 || document.result[0].success !== true || document.result[0].results?.length !== 1) throw new Error("vault_state_unavailable");
      return document.result[0].results[0];
    },
    putSecret: (name, value) => runWrangler(["secret", "put", name, ...args], target, value),
  });
  return result;
}

function wranglerCommand(args, environment, input) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), ...args], {
      shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...environment, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" },
    });
    let output = "";
    const stop = setTimeout(() => { child.kill(); reject(new Error("vault_command_timeout")); }, 60_000);
    child.stdout.on("data", (data) => {
      // Mutation output is discarded even if a provider echoes a secret.
      if (input === undefined) { output += data; if (output.length > 65_536) { child.kill(); reject(new Error("vault_command_output_invalid")); } }
    });
    child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(stop); reject(new Error("vault_command_failed")); });
    child.on("close", (code) => { clearTimeout(stop); code === 0 ? done(output.trim()) : reject(new Error("vault_command_failed")); });
    if (input !== undefined) {
      child.stdin.on("error", () => { clearTimeout(stop); child.kill(); reject(new Error("vault_command_failed")); });
      child.stdin.end(`${input}\n`);
    }
  });
}

/** Cause and fix for each fixed code, printed as the run's error annotation. */
export const vaultHelp = {
  private_installation_required: "Run this workflow from the adopter-owned private deployment repository, which must stay private.",
  fixed_worker_configuration_required: "The generated Worker configuration does not name exactly this installation's Worker and D1 database: run this workflow again with the same slug.",
  vault_secret_metadata_invalid: "Cloudflare returned an unreadable Worker secret list: run this workflow again later.",
  vault_state_unavailable: "The fingerprint storage state could not be read from D1: check that CLOUDFLARE_API_TOKEN has D1: Edit and that the migrations were applied, then run this workflow again.",
  vault_original_key_recovery_required: "The Worker has lost FINGERPRINT_VAULT_KEY while cloud fingerprint storage holds enrollments: restore the original key as the Worker secret FINGERPRINT_VAULT_KEY. A new key cannot read the stored enrollments, so none was created.",
  vault_secret_write_unconfirmed: "Cloudflare did not confirm the new FINGERPRINT_VAULT_KEY Worker secret: run this workflow again.",
  vault_command_failed: "A Wrangler command for the fingerprint storage key failed: check that CLOUDFLARE_API_TOKEN has Workers Scripts: Edit, then run this workflow again.",
  vault_command_timeout: "A Wrangler command for the fingerprint storage key timed out: run this workflow again.",
  vault_command_output_invalid: "Wrangler returned unexpected output for the Worker secret list: run this workflow again.",
};

if (process.argv[1]?.endsWith("ensure-fingerprint-vault-key.mjs")) installFingerprintVaultKey(process.env)
  .then(({ status }) => console.log(`Fingerprint storage key ${status}. Cloud storage remains an Administrator opt-in.`))
  .catch((error) => {
    reportFailure(error, { ...credentialHelp(process.env), ...vaultHelp }, "vault_preparation_failed", "Fingerprint storage key preparation stopped: check the Worker and D1 database with the Cloudflare token, then run this workflow again.");
    console.error("Fingerprint storage key preparation stopped. Verify fixed resources and restore the original key if cloud enrollments already exist. No replacement key was authorized."); process.exitCode = 1;
  });
