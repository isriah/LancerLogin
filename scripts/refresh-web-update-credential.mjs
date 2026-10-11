import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { resolveDatabaseName } from "./database-identity.mjs";

export async function verifyDispatchCredential(env, request = fetch) {
  const repo = env.LANCERLOGIN_UPDATE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || repo.toLowerCase() === "isriah/lancerlogin") throw new Error("private_repository_required");
  if (!env.LANCERLOGIN_WEB_UPDATE_TOKEN || !(Date.parse(env.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "") > Date.now())) throw new Error("dispatch_credential_required");
  const headers = { authorization: `Bearer ${env.LANCERLOGIN_WEB_UPDATE_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10" };
  const get = async (path) => {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("dispatch_credential_access_denied");
    return response.json();
  };
  if ((await get("")).private !== true) throw new Error("private_repository_required");
  const workflow = await get("/actions/workflows/upgrade-web.yml");
  if (workflow.state !== "active" || workflow.path !== ".github/workflows/upgrade-web.yml") throw new Error("reviewed_workflow_required");
  // GitHub read preflight cannot prove Actions write; the installer must grant that permission.
}
export async function verifyCredentialTarget(env, request = fetch) {
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(env.INSTALLATION_SLUG ?? "") || !/^[0-9a-f-]{36}$/.test(env.DATABASE_ID ?? "") || !/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN?.startsWith("cfat_")) throw new Error("fixed_account_resources_required");
  if (env.API_URL) {
    const url = new URL(env.API_URL);
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
async function main() {
  if (process.env.REPOSITORY_PRIVATE !== "true" || !/^[a-z][a-z0-9-]{2,40}$/.test(process.env.INSTALLATION_SLUG ?? "")) throw new Error("private_installation_required");
  await verifyDispatchCredential(process.env);
  if (process.argv.includes("--verify-only")) return;
  const target = { ...process.env };
  if (process.env.WEB_UPDATE_CONFIG) target.DATABASE_ID = JSON.parse(await readFile(process.env.WEB_UPDATE_CONFIG, "utf8")).d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
  await verifyCredentialTarget(target);
  const secretDocument = JSON.stringify({ WEB_UPDATE_TOKEN: process.env.LANCERLOGIN_WEB_UPDATE_TOKEN, WEB_UPDATE_TOKEN_EXPIRES_AT: process.env.WEB_UPDATE_TOKEN_EXPIRES_AT });
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "secret", "bulk", "--name", `${process.env.INSTALLATION_SLUG}-api`, ...(process.env.WEB_UPDATE_CONFIG ? ["--config", process.env.WEB_UPDATE_CONFIG] : [])], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" } });
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("credential_upload_failed")));
    child.stdin.on("error", () => reject(new Error("credential_upload_failed")));
    child.on("exit", (code) => code === 0 ? done() : reject(new Error("credential_upload_failed")));
    child.stdin.end(secretDocument);
  });
  console.log("Private dispatch credential and expiry refreshed. Data and installation encryption/session secrets retained.");
}
if (process.argv[1]?.endsWith("refresh-web-update-credential.mjs")) main().catch(() => { console.error("Credential refresh stopped. Check the private workflow, token scope, expiry and exact Worker through secure provider interfaces."); process.exitCode = 1; });
