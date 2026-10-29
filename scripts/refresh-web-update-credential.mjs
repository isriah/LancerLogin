import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { resolveDatabaseName } from "./database-identity.mjs";
import { reportFailure } from "./workflow-annotations.mjs";

/**
 * GitHub adds this header to every API response for a request authenticated with an expiring personal access token,
 * for example "2026-11-05 00:00:00 UTC". A token without an expiry gets no header.
 */
export const tokenExpirationHeader = "github-authentication-token-expiration";
/** ISO-8601 UTC expiry from the header value, or undefined for a token that does not expire. */
export function parseTokenExpiration(value) {
  if (value === null || value === undefined || String(value).trim() === "") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i.exec(String(value).trim());
  if (!match) throw new Error("token_expiration_unreadable");
  const zone = !match[3] || /^(?:utc|gmt|z)$/i.test(match[3]) ? "Z" : match[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const time = Date.parse(`${match[1]}T${match[2]}${zone}`);
  if (!Number.isFinite(time)) throw new Error("token_expiration_unreadable");
  return new Date(time).toISOString();
}
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/**
 * Reads the private repository with a token. Rejection (HTTP 401) and an expiry already passed throw the rejected code;
 * any other refusal throws the access code. Returns the repository and the token's expiry from GitHub's header.
 */
async function readRepositoryWith(token, repo, request, { rejected, denied }) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10" };
  const get = async (path) => {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) throw new Error(rejected);
    if (!response.ok) throw new Error(denied);
    return response;
  };
  const response = await get("");
  const expiresAt = parseTokenExpiration(response.headers.get(tokenExpirationHeader));
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error(rejected);
  return { repository: await response.json(), expiresAt, get: async (path) => (await get(path)).json() };
}

/** Returns the dispatch token's expiry (undefined when the token does not expire). */
export async function verifyDispatchCredential(env, request = fetch) {
  const repo = env.LANCERLOGIN_UPDATE_REPOSITORY;
  if (!repositoryPattern.test(repo ?? "") || repo.toLowerCase() === "isriah/lancerlogin") throw new Error("private_repository_required");
  if (!env.LANCERLOGIN_WEB_UPDATE_TOKEN) throw new Error("dispatch_credential_required");
  const { repository, expiresAt, get } = await readRepositoryWith(env.LANCERLOGIN_WEB_UPDATE_TOKEN, repo, request, { rejected: "dispatch_credential_rejected", denied: "dispatch_credential_access_denied" });
  if (repository.private !== true) throw new Error("private_repository_required");
  const workflow = await get("/actions/workflows/upgrade-web.yml");
  if (workflow.state !== "active" || workflow.path !== ".github/workflows/upgrade-web.yml") throw new Error("reviewed_workflow_required");
  // GitHub read preflight cannot prove Actions write; the installer must grant that permission.
  return { expiresAt };
}
/**
 * The optional plugin selection credential lets the Worker commit lancerlogin.modules.json for dashboard plugin management.
 * It must be a separate fine-grained token (Contents write on only this private repository), never the dispatch token.
 * Returns false when it is not configured; the dashboard then shows plugin management as unavailable. Otherwise returns
 * the token's expiry (undefined when the token does not expire).
 */
export async function verifySelectionCredential(env, request = fetch) {
  if (!env.LANCERLOGIN_MODULE_SELECTION_TOKEN) return false;
  const repo = env.LANCERLOGIN_UPDATE_REPOSITORY;
  if (!repositoryPattern.test(repo ?? "") || repo.toLowerCase() === "isriah/lancerlogin") throw new Error("private_repository_required");
  if (env.LANCERLOGIN_MODULE_SELECTION_TOKEN === env.LANCERLOGIN_WEB_UPDATE_TOKEN) throw new Error("selection_credential_must_be_distinct");
  const { repository, expiresAt, get } = await readRepositoryWith(env.LANCERLOGIN_MODULE_SELECTION_TOKEN, repo, request, { rejected: "selection_credential_rejected", denied: "selection_credential_access_denied" });
  if (repository.private !== true) throw new Error("private_repository_required");
  await get("/contents/?ref=main");
  // A read preflight cannot prove Contents write; the installer must grant that permission.
  return { expiresAt };
}
export async function verifyCredentialTarget(env, request = fetch) {
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(env.INSTALLATION_SLUG ?? "") || !/^[0-9a-f-]{36}$/.test(env.DATABASE_ID ?? "") || !/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN?.startsWith("cfat_")) throw new Error("fixed_account_resources_required");
  if (env.API_URL) {
    let url;
    try { url = new URL(env.API_URL); } catch { throw new Error("fixed_account_resources_required"); }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash || !url.hostname.startsWith(`${env.INSTALLATION_SLUG}-api.`) || !url.hostname.endsWith(".workers.dev")) throw new Error("fixed_account_resources_required");
  }
  const get = async (path) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("credential_target_unavailable");
    const document = await response.json(); if (document.success !== true) throw new Error("credential_target_unavailable"); return document.result;
  };
  if ((await get("/tokens/verify")).status !== "active") throw new Error("account_token_invalid");
  const database = await get(`/d1/database/${env.DATABASE_ID}`);
  if (database.uuid !== env.DATABASE_ID || database.name !== resolveDatabaseName(env.INSTALLATION_SLUG, env.DATABASE_NAME)) throw new Error("database_identity_mismatch");
  const worker = await get(`/workers/scripts/${env.INSTALLATION_SLUG}-api/settings`);
  if (!worker.bindings?.some((binding) => binding.name === "DB" && binding.type === "d1" && binding.id === env.DATABASE_ID)) throw new Error("worker_database_mismatch");
}

/**
 * The Worker secrets for the verified credentials. An expiry is stored only for a token that expires; staleExpiries lists
 * the expiry secrets to delete, so a previous token's expiry is never applied to a token without one.
 */
export function credentialSecrets(env, dispatch, selection) {
  const secrets = { WEB_UPDATE_TOKEN: env.LANCERLOGIN_WEB_UPDATE_TOKEN, ...(dispatch.expiresAt ? { WEB_UPDATE_TOKEN_EXPIRES_AT: dispatch.expiresAt } : {}) };
  // Without a configured selection credential, any previously uploaded one is retained unchanged.
  if (selection) Object.assign(secrets, { MODULE_SELECTION_TOKEN: env.LANCERLOGIN_MODULE_SELECTION_TOKEN, ...(selection.expiresAt ? { MODULE_SELECTION_TOKEN_EXPIRES_AT: selection.expiresAt } : {}) });
  const staleExpiries = [...(dispatch.expiresAt ? [] : ["WEB_UPDATE_TOKEN_EXPIRES_AT"]), ...(selection && !selection.expiresAt ? ["MODULE_SELECTION_TOKEN_EXPIRES_AT"] : [])];
  return { secrets, staleExpiries };
}

const secretsWorkflow = (env) => `https://github.com/${env.LANCERLOGIN_UPDATE_REPOSITORY ?? "<owner>/<repository>"}/actions/workflows/refresh-web-update-credential.yml`;
/** Cause and fix for each fixed code, printed as the run's error annotation. */
export const credentialHelp = (env = {}) => ({
  private_installation_required: "Run this workflow from the adopter-owned private deployment repository, which must stay private.",
  installation_slug_required: "Set the production environment variable LANCERLOGIN_INSTALLATION_SLUG to the installation slug, as listed in the run summary of Install or upgrade LancerLogin.",
  private_repository_required: "The dashboard update tokens must belong to this private deployment repository: keep the repository private and run the workflow from it, never from isriah/LancerLogin.",
  dispatch_credential_required: `LANCERLOGIN_WEB_UPDATE_TOKEN is not set: create a fine-grained token scoped to this repository with Actions: Read and write, store it as the production environment secret LANCERLOGIN_WEB_UPDATE_TOKEN, then run Refresh web update credential (${secretsWorkflow(env)}).`,
  dispatch_credential_rejected: "The GitHub token for dashboard updates has expired or been revoked: create a new fine-grained token, replace LANCERLOGIN_WEB_UPDATE_TOKEN, then run Refresh web update credential.",
  dispatch_credential_access_denied: "LANCERLOGIN_WEB_UPDATE_TOKEN cannot read this repository: give the fine-grained token access to this repository with Actions: Read and write, then run this workflow again.",
  reviewed_workflow_required: "The Upgrade LancerLogin web workflow (.github/workflows/upgrade-web.yml) is missing or disabled in this repository: restore and enable it on main, then run this workflow again.",
  selection_credential_must_be_distinct: "LANCERLOGIN_MODULE_SELECTION_TOKEN must be a separate token from LANCERLOGIN_WEB_UPDATE_TOKEN: create a second fine-grained token with Contents: Read and write on only this repository.",
  selection_credential_rejected: "The GitHub token for plugin management has expired or been revoked: create a new fine-grained token, replace LANCERLOGIN_MODULE_SELECTION_TOKEN, then run Refresh web update credential.",
  selection_credential_access_denied: "LANCERLOGIN_MODULE_SELECTION_TOKEN cannot read this repository's main branch: give the fine-grained token access to this repository with Contents: Read and write, then run this workflow again.",
  token_expiration_unreadable: "GitHub reported a token expiry in an unexpected format, so it was not stored: run this workflow again later, and report it if it persists.",
  fixed_account_resources_required: "Set the production environment variables LANCERLOGIN_INSTALLATION_SLUG, LANCERLOGIN_DATABASE_ID and LANCERLOGIN_API_URL from the run summary of Install or upgrade LancerLogin, and the secrets CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (an Account API token that starts with cfat_).",
  credential_target_unavailable: "Cloudflare did not return the installation's D1 database or Worker: check CLOUDFLARE_ACCOUNT_ID, LANCERLOGIN_DATABASE_ID and LANCERLOGIN_INSTALLATION_SLUG, and that CLOUDFLARE_API_TOKEN has Workers Scripts and D1 permissions in that account.",
  account_token_invalid: "CLOUDFLARE_API_TOKEN is not active: create a new Account API token in the Cloudflare dashboard (Manage account > Account API tokens) and replace the secret.",
  database_identity_mismatch: "LANCERLOGIN_DATABASE_ID does not name this installation's D1 database: copy the database ID from the run summary of Install or upgrade LancerLogin, and check LANCERLOGIN_DATABASE_NAME.",
  worker_database_mismatch: "The installation's Worker is not bound to LANCERLOGIN_DATABASE_ID: check the variable against the run summary of Install or upgrade LancerLogin.",
  credential_upload_failed: "Cloudflare did not accept the Worker secrets: check that CLOUDFLARE_API_TOKEN has Workers Scripts: Edit, then run this workflow again.",
});

function wrangler(args, input) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), ...args, "--name", `${process.env.INSTALLATION_SLUG}-api`, ...(process.env.WEB_UPDATE_CONFIG ? ["--config", process.env.WEB_UPDATE_CONFIG] : [])], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" } });
    let output = "";
    // Output is kept only for listing secret names; an upload's output is discarded even if a provider echoes a value.
    child.stdout.on("data", (data) => { if (input === undefined && output.length < 65_536) output += data; }); child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("credential_upload_failed")));
    child.stdin.on("error", () => reject(new Error("credential_upload_failed")));
    child.on("exit", (code) => code === 0 ? done(output) : reject(new Error("credential_upload_failed")));
    child.stdin.end(input ?? "");
  });
}
const expiryText = (label, expiry) => expiry ? `${label} expires ${expiry}.` : `${label} has no expiration date.`;
async function main() {
  if (process.env.REPOSITORY_PRIVATE !== "true") throw new Error("private_installation_required");
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(process.env.INSTALLATION_SLUG ?? "")) throw new Error("installation_slug_required");
  const dispatch = await verifyDispatchCredential(process.env);
  const selection = await verifySelectionCredential(process.env);
  console.log([expiryText("The dashboard update token", dispatch.expiresAt), ...(selection ? [expiryText("The plugin selection token", selection.expiresAt)] : [])].join(" "));
  if (process.argv.includes("--verify-only")) return;
  const target = { ...process.env };
  if (process.env.WEB_UPDATE_CONFIG) target.DATABASE_ID = JSON.parse(await readFile(process.env.WEB_UPDATE_CONFIG, "utf8")).d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
  await verifyCredentialTarget(target);
  const { secrets, staleExpiries } = credentialSecrets(process.env, dispatch, selection);
  await wrangler(["secret", "bulk"], JSON.stringify(secrets));
  if (staleExpiries.length) {
    let names;
    try { names = new Set(JSON.parse(await wrangler(["secret", "list", "--format", "json"])).map((entry) => entry.name)); } catch { throw new Error("credential_upload_failed"); }
    for (const name of staleExpiries.filter((name) => names.has(name))) await wrangler(["secret", "delete", name]);
  }
  console.log(`Private dispatch credential${selection ? " and plugin selection credential" : ""} and expiry refreshed. Data and installation encryption/session secrets retained.`);
}
if (process.argv[1]?.endsWith("refresh-web-update-credential.mjs")) main().catch((error) => {
  reportFailure(error, credentialHelp(process.env), "credential_refresh_failed", "Credential refresh stopped. Check the private workflow, both token scopes, and the exact Worker through secure provider interfaces.");
  console.error("Credential refresh stopped. Check the private workflow, both token scopes and expiries, and the exact Worker through secure provider interfaces.");
  process.exitCode = 1;
});
