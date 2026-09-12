import { verifyCredentialTarget } from "./refresh-web-update-credential.mjs";

/** Deliberate operator recovery, never a dashboard parameter or automatic rollback. */
export async function recoverWebUpdate(row, io, { confirmation, schemaCompatibilityReviewed = false } = {}) {
  if (!row || row.state !== "recovery_required" || confirmation !== `RECOVER WEB UPDATE ${row.id}` || !schemaCompatibilityReviewed) throw new Error("explicit_recovery_review_required");
  if (!row.run_id || !await io.runCompleted(row.run_id)) throw new Error("workflow_completion_required");
  const version = await io.verifiedHealthyVersion();
  if (![row.previous_version, row.release_tag.slice(1)].includes(version)) throw new Error("recovery_release_mismatch");
  await io.finalize(version === row.release_tag.slice(1) ? "succeeded" : "failed");
  return { state: version === row.release_tag.slice(1) ? "succeeded" : "failed", maintenance: false, automaticDatabaseRestore: false };
}
async function main() {
  const env = process.env; const id = env.RECOVERY_REQUEST_ID;
  if (env.REPOSITORY_PRIVATE !== "true" || !/^[0-9a-f-]{36}$/.test(id ?? "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY ?? "") || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") throw new Error("fixed_private_recovery_required");
  await verifyCredentialTarget(env);
  const cfOrigin = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/query`;
  const query = async (sql, params) => {
    const response = await fetch(cfOrigin, { method: "POST", headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ sql, params }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("database_request_failed"); const result = await response.json();
    if (!result.success || result.result?.some((entry) => entry.success === false)) throw new Error("database_request_failed"); return result.result;
  };
  const row = (await query("SELECT * FROM web_update_requests WHERE installation_id = 'primary' AND id = ?", [id]))[0]?.results?.[0];
  const json = async (url, headers = {}) => { const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error("provider_request_failed"); return response.json(); };
  await recoverWebUpdate(row, {
    async runCompleted(runId) {
      const run = await json(`https://api.github.com/repos/${env.UPDATE_REPOSITORY}/actions/runs/${runId}`, { authorization: `Bearer ${env.LANCERLOGIN_WEB_UPDATE_TOKEN}`, "user-agent": "LancerLogin", accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" });
      return run.status === "completed" && run.display_title === `LancerLogin web update ${id}` && [".github/workflows/upgrade-web.yml", ".github/workflows/upgrade-web.yml@main"].includes(run.path) && run.event === "workflow_dispatch";
    },
    async verifiedHealthyVersion() {
      const api = await json(`${env.API_URL.replace(/\/$/, "")}/health`);
      const pagesOrigin = `https://${env.INSTALLATION_SLUG}-dashboard.pages.dev`;
      const pages = await json(`${pagesOrigin}/__lancerlogin-release`); const proxy = await json(`${pagesOrigin}/api/health`);
      if (api.ok !== true || api.mode !== "ready" || proxy.ok !== true || api.releaseVersion !== pages.releaseVersion || pages.releaseVersion !== proxy.releaseVersion) throw new Error("recovery_health_required");
      return api.releaseVersion;
    },
    async finalize(state) {
      const result = await query("UPDATE web_update_requests SET state = ?, stage = 'operator_recovered', maintenance = 0, error_code = NULL, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'recovery_required'", [state, new Date().toISOString(), id]);
      if (result[0]?.meta?.changes !== 1) throw new Error("request_state_conflict");
    },
  }, { confirmation: env.RECOVERY_CONFIRMATION, schemaCompatibilityReviewed: env.RECOVERY_SCHEMA_COMPATIBILITY_REVIEWED === "yes" });
  console.log("Reviewed healthy web deployment recovered. No database restore or code rollback performed.");
}
if (process.argv[1]?.endsWith("recover-web-update.mjs")) main().catch(() => { console.error("Recovery stopped. Verify workflow completion, both releases/health, schema compatibility and explicit authorization. Unresolved dispatch requires manual provider investigation; its lock remains retained."); process.exitCode = 1; });
