import { hasComparableStableVersions, isNewerRelease } from "./update-release.ts";

export type WebUpdateRequest = {
  requestId: string; targetTag: string; targetCommit: string; releaseNotes: string; releaseUrl: string;
  previousVersion: string; state: "prepared" | "dispatching" | "queued" | "awaiting_approval" | "running" | "verifying" | "succeeded" | "failed" | "recovery_required" | "expired";
  stage: string; createdAt: string; expiresAt: string; updatedAt: string; backupExported: boolean;
  maintenance: boolean; errorCode: string | null; runUrl: string | null; reloadReady: boolean;
  channel?: "stable" | "beta";
  /** release installs a newer official release; modules redeploys the installed release with changed plugins. */
  mode?: "release" | "modules";
};
/** missing: not set up. expiring: expires within 14 days. rejected: GitHub refused it on the Worker's last call. */
export type CredentialStatus = { state: "missing" | "ready" | "expiring" | "expired" | "rejected"; expiresAt: string | null };
/** Setup readiness the Worker reports with update status; absent from older Workers and from prepare and start responses. */
export type UpdateSetup = {
  repository: string | null; dispatchCredential: CredentialStatus; selectionCredential: CredentialStatus;
  controller: "current" | "upgrade_required" | "missing" | "unknown";
  /** Whether the deployment repository's own workflow files match the installed release; absent from older Workers. */
  repositoryFiles?: RepositoryFiles;
  /** The latest "Refresh web update credential" run; absent from older Workers. */
  refreshRun?: RefreshRun;
};
export type PullRequestLink = { number: number; url: string };
export type RepositoryFiles = { state: "current" | "outdated" | "permission_required" | "unknown"; release: string | null; outdated: string[]; pullRequest: PullRequestLink | null };
export type RefreshRun = {
  state: "none" | "running" | "succeeded" | "failed" | "unknown"; runUrl: string | null; finishedAt: string | null;
  code: string | null; reason: "coded" | "unexplained" | "unreadable" | null; failedStep: string | null;
};
export type RepositoryFilesProposal = { pullRequest: PullRequestLink; created: boolean; release: string; files: string[] };
export type WebUpdateResponse = { releaseVersion: string; workflowUrl: string; request: WebUpdateRequest | null; activeRequest?: WebUpdateRequest | null; latestCompletedRequest?: WebUpdateRequest | null; setup?: UpdateSetup };

export const isTerminalWebUpdate = (request: WebUpdateRequest) => ["succeeded", "failed", "expired"].includes(request.state);

export const tokenCreationUrl = "https://github.com/settings/personal-access-tokens/new";
export const dispatchSecretName = "LANCERLOGIN_WEB_UPDATE_TOKEN";
export const selectionSecretName = "LANCERLOGIN_MODULE_SELECTION_TOKEN";
/** Pages in the private deployment repository, when the Worker reported a valid repository. */
export function deploymentLinks(repository?: string | null) {
  const repo = repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? `https://github.com/${repository}` : undefined;
  return {
    environments: repo && `${repo}/settings/environments`,
    refresh: repo && `${repo}/actions/workflows/refresh-web-update-credential.yml`,
    install: repo && `${repo}/actions/workflows/provision-template.yml`,
    controller: repo && `${repo}/actions/workflows/upgrade-web.yml`,
  };
}
export type FixLink = { label: string; href: string };
/** One numbered setup step; link, when present, opens the page the step happens on. */
export type SetupStep = { text: string; link?: FixLink };
const repositoryName = (repository?: string | null) => repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : undefined;
/**
 * Numbered steps to create a credential and install it. The plugin management token needs Contents: Read and write and
 * must be a separate token; the dashboard update token needs Actions: Read and write.
 */
export function credentialSteps(kind: "dispatch" | "selection", repository?: string | null): SetupStep[] {
  const repo = repositoryName(repository); const links = deploymentLinks(repo);
  const [owner, name] = repo ? repo.split("/") : [];
  const secret = kind === "dispatch" ? dispatchSecretName : selectionSecretName;
  return [
    { text: "Create a new fine-grained personal access token on GitHub.", link: { label: "Create a GitHub fine-grained token", href: tokenCreationUrl } },
    { text: repo ? `Set Resource owner to ${owner}. Under Repository access, choose Only select repositories and pick ${name}.` : "Set Resource owner to the account that owns the deployment repository. Under Repository access, choose Only select repositories and pick the deployment repository." },
    kind === "dispatch"
      ? { text: "Under Repository permissions, set Actions to Read and write." }
      : { text: `Under Repository permissions, set Contents to Read and write. Use a different token from the dashboard update token (${dispatchSecretName}).` },
    { text: "Generate the token and copy it." },
    { text: `In the deployment repository's production environment, add it as an environment secret named ${secret}.`, ...(links.environments ? { link: { label: "Open the deployment repository's environments", href: links.environments } } : {}) },
    { text: "Run the \"Refresh web update credential\" workflow.", ...(links.refresh ? { link: { label: "Run Refresh web update credential", href: links.refresh } } : {}) },
  ];
}
export const tokenSettingsUrl = "https://github.com/settings/personal-access-tokens";
const permissionLabels = { contents: "Contents", pull_requests: "Pull requests", workflows: "Workflows" } as const;
export type RepositoryPermission = keyof typeof permissionLabels;
/** Steps to add repository permissions to the existing dashboard update token. Its value does not change. */
export function permissionSteps(permissions: readonly RepositoryPermission[], last = "Come back to this page and choose Update repository files again."): SetupStep[] {
  const names = permissions.map((permission) => permissionLabels[permission]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
  return [
    { text: `Open your fine-grained tokens on GitHub and choose the token stored as ${dispatchSecretName}.`, link: { label: "Open your fine-grained tokens", href: tokenSettingsUrl } },
    { text: `Under Repository permissions, set ${list} to Read and write, then save. The token itself does not change, so you do not need to replace the secret or run any workflow.` },
    { text: last },
  ];
}
export const repositoryPermissions: readonly RepositoryPermission[] = ["contents", "pull_requests", "workflows"];
const permissionErrors: Record<string, RepositoryPermission> = { repository_files_contents_permission: "contents", repository_files_pull_requests_permission: "pull_requests", repository_files_workflows_permission: "workflows" };
/** The permission a repository file update was refused for, if that is why it failed. */
export const missingRepositoryPermission = (code?: string | null): RepositoryPermission | undefined => code ? permissionErrors[code] : undefined;
type LinkKind = "token" | "environments" | "refresh" | "install" | "controller";
const linkLabels: Record<LinkKind, string> = {
  token: "Create a GitHub fine-grained token",
  environments: "Open the deployment repository's environments",
  refresh: "Run Refresh web update credential",
  install: "Run Install or upgrade LancerLogin",
  controller: "Open the update controller workflow",
};
export function fixLinks(kinds: readonly LinkKind[], repository?: string | null): FixLink[] {
  const links = { ...deploymentLinks(repository), token: tokenCreationUrl };
  return kinds.flatMap((kind) => links[kind] ? [{ label: linkLabels[kind], href: links[kind]! }] : []);
}
export const credentialLinkKinds: readonly LinkKind[] = ["token", "environments", "refresh"];

const dispatchTokenSteps = `Create a GitHub fine-grained token scoped to the deployment repository with Actions: Read and write, store it as the production environment secret ${dispatchSecretName}, then run the "Refresh web update credential" workflow.`;
const selectionTokenSteps = `Create a GitHub fine-grained token scoped to the deployment repository with Contents: Read and write, store it as the production environment secret ${selectionSecretName}, then run the "Refresh web update credential" workflow.`;
const manualUpgrade = `Until then, update by running the "Install or upgrade LancerLogin" workflow with operation "upgrade" in the deployment repository.`;
const diagnosticRun = "Open the diagnostic run in GitHub (Diagnostics and manual recovery below) to see the error";
const recoveryNeeded = `The installation needs recovery: ${diagnosticRun}, then follow Manual recovery in the installation guide. Do not start another update.`;
const errors: Record<string, string> = {
  not_configured: `Dashboard updates are not configured: this installation does not know its private deployment repository. Run the "Install or upgrade LancerLogin" workflow with operation "upgrade" in the deployment repository to record it.`,
  credential_required: `Dashboard updates are not set up: the Worker has no dashboard update credential, or the credential cannot read the deployment repository. ${dispatchTokenSteps} ${manualUpgrade}`,
  credential_expired: `The dashboard update credential (${dispatchSecretName}) has expired. ${dispatchTokenSteps}`,
  credential_expiring: `The dashboard update credential (${dispatchSecretName}) expires within 24 hours, too soon to finish an update safely. ${dispatchTokenSteps}`,
  dispatch_credential_rejected: `GitHub rejected the dashboard update credential (${dispatchSecretName}). It was revoked, regenerated or has expired. ${dispatchTokenSteps}`,
  credential_permission: `The dashboard update credential (${dispatchSecretName}) is missing a GitHub permission. Edit the fine-grained token so it covers the deployment repository with Actions: Read and write, then run the "Refresh web update credential" workflow.`,
  not_private: "Dashboard updates run only from a private deployment repository. Make the deployment repository private in its GitHub settings, then prepare the update again.",
  workflow_required: "The update controller workflow, .github/workflows/upgrade-web.yml, is missing or disabled in the deployment repository. Copy it from this release's template, commit it to main and enable it, then prepare the update again.",
  workflow_invalid: "GitHub refused to start the update controller workflow, upgrade-web.yml. Make .github/workflows/upgrade-web.yml on the main branch of the deployment repository match this release's template, then prepare the update again.",
  cooldown: "GitHub or this installation is limiting update requests. Try again after the cooldown clears. If an update was recently started, wait at least two minutes from that start; provider limits may take longer.",
  already_current: "This installation is current.",
  release_unavailable: "A complete official release on this update track is unavailable. Try preparing again later.",
  controller_upgrade_required: "Beta updates need the current update controller. Replace .github/workflows/upgrade-web.yml in the deployment repository with this release's version and commit it to main, then prepare the update again.",
  channel_changed: "The update track changed. Prepare a new update and download its associated backup.",
  invalid_request: "The update request is invalid. Refresh status before continuing.",
  request_missing: "The prepared update could not be found. Refresh status before preparing again.",
  request_expired: "This prepared update expired. Prepare a new update and download its associated backup.",
  backup_required: "Download this update's entire-installation backup and confirm that the file was saved before starting.",
  provider_unavailable: "GitHub is temporarily unavailable. Refresh status before trying again.",
  run_mismatch: "The workflow run could not be matched to this request safely, so its status is not trusted. Open the diagnostic run in GitHub and inspect it. Do not start another update.",
  dispatch_ambiguous: "GitHub's dispatch response was uncertain. LancerLogin is reconciling this request; do not start another update.",
  dispatch_unresolved: "No unique workflow run could be matched to this request. Open the update controller workflow's runs in GitHub to find out whether it ran. Do not start another update until you know.",
  selection_credential_required: `Module changes need the module selection credential. ${selectionTokenSteps}`,
  selection_credential_expired: `The module selection credential (${selectionSecretName}) has expired. ${selectionTokenSteps}`,
  selection_credential_rejected: `GitHub rejected the module selection credential (${selectionSecretName}). It was revoked, regenerated or has expired. ${selectionTokenSteps}`,
  selection_credential_permission: `The module selection credential (${selectionSecretName}) cannot access the deployment repository. Edit the fine-grained token so it covers the deployment repository with Contents: Read and write, then run the "Refresh web update credential" workflow.`,
  selection_unavailable: "The module selection could not be read from the private deployment repository. Try again later.",
  selection_invalid: "lancerlogin.modules.json in the deployment repository is invalid. Fix it on the main branch, then prepare the update again.",
  module_selection_changed: "The module selection changed after this update was prepared. Prepare it again and download its associated backup.",
  module_selection_preflight: "The module selection deployed by this update did not match the prepared one, so nothing changed. Prepare it again.",
  superseded_by_later_release: "A later reviewed release repaired this installation. The earlier update remains in history and no longer blocks writes.",
  preflight_failed: `The update stopped during its preflight checks, before anything changed. ${diagnosticRun}, fix what it reports, then prepare the update again.`,
  workflow_stopped_unchanged: `The update workflow was cancelled, timed out or failed before any migration or deployment, so nothing changed and writes resumed. ${diagnosticRun}, then prepare the update again.`,
  workflow_incomplete: `The update workflow finished without confirming a healthy installation. ${recoveryNeeded}`,
  build_failed: `The update failed while building, before any change. ${diagnosticRun}, then prepare the update again.`,
  maintenance_failed: `The update failed while pausing writes, before any migration or deployment. ${diagnosticRun}, then prepare the update again.`,
  checkpoint_failed: `The update failed while recording its recovery checkpoint, before any migration or deployment. ${diagnosticRun}, then prepare the update again.`,
  migrations_failed: `The update failed while applying database migrations. ${recoveryNeeded}`,
  api_deployment_failed: `The update failed while deploying the API Worker. ${recoveryNeeded}`,
  pages_deployment_failed: `The update failed while deploying the dashboard to Pages. ${recoveryNeeded}`,
  health_failed: `The update deployed but the installation health check failed. ${recoveryNeeded}`,
  repository_files_contents_permission: "The dashboard update credential needs Contents: Read and write to update the repository's workflow files.",
  repository_files_pull_requests_permission: "The dashboard update credential needs Pull requests: Read and write to open a pull request with the updated files.",
  repository_files_workflows_permission: "The dashboard update credential needs Workflows: Read and write, because the updated files include workflows.",
  repository_files_current: "The repository's workflow files already match the installed release.",
};

const refreshScriptOld = "This usually means the repository runs an older copy of the refresh workflow. Use Update repository files below, merge the pull request on GitHub, then run the workflow again.";
/** Plain explanations for the codes "Refresh web update credential" reports (scripts/refresh-web-update-credential.mjs). */
const refreshFailures: Record<string, string> = {
  private_installation_required: "The workflow ran outside the private deployment repository. Run it from the private deployment repository, which must stay private.",
  installation_slug_required: "The production environment variable LANCERLOGIN_INSTALLATION_SLUG is missing. Copy it from the run summary of Install or upgrade LancerLogin.",
  private_repository_required: "The tokens must belong to the private deployment repository. Keep it private and run the workflow from it.",
  dispatch_credential_required: `The secret ${dispatchSecretName} is missing. Add the dashboard update token as a production environment secret, then run the workflow again.`,
  dispatch_credential_rejected: `GitHub rejected ${dispatchSecretName}: it expired or was revoked. Create a new token, replace the secret, then run the workflow again.`,
  dispatch_credential_access_denied: `${dispatchSecretName} cannot read the deployment repository. Give the token access to this repository with Actions: Read and write, then run the workflow again.`,
  reviewed_workflow_required: "The update controller workflow (.github/workflows/upgrade-web.yml) is missing or disabled. Restore and enable it on main, then run the workflow again.",
  selection_credential_must_be_distinct: `${selectionSecretName} is the same token as ${dispatchSecretName}. Create a second token with Contents: Read and write on only this repository.`,
  selection_credential_rejected: `GitHub rejected ${selectionSecretName}: it expired or was revoked. Create a new token, replace the secret, then run the workflow again.`,
  selection_credential_access_denied: `${selectionSecretName} cannot read the deployment repository. Give the token access to this repository with Contents: Read and write, then run the workflow again.`,
  token_expiration_unreadable: "GitHub reported a token expiry in an unexpected format. Run the workflow again later.",
  fixed_account_resources_required: "Some production environment values are missing or wrong: LANCERLOGIN_INSTALLATION_SLUG, LANCERLOGIN_DATABASE_ID, LANCERLOGIN_API_URL, CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Copy them from the run summary of Install or upgrade LancerLogin.",
  credential_target_unavailable: "Cloudflare did not find this installation's database or Worker. Check CLOUDFLARE_ACCOUNT_ID, LANCERLOGIN_DATABASE_ID, LANCERLOGIN_INSTALLATION_SLUG and the permissions of CLOUDFLARE_API_TOKEN.",
  account_token_invalid: "CLOUDFLARE_API_TOKEN is not active. Create a new Cloudflare Account API token and replace the secret.",
  database_identity_mismatch: "LANCERLOGIN_DATABASE_ID does not match this installation's database. Copy it from the run summary of Install or upgrade LancerLogin.",
  worker_database_mismatch: "The installation's Worker is not bound to LANCERLOGIN_DATABASE_ID. Check the variable against the run summary of Install or upgrade LancerLogin.",
  credential_upload_failed: "Cloudflare did not accept the Worker secrets. Check that CLOUDFLARE_API_TOKEN has Workers Scripts: Edit, then run the workflow again.",
  run_cancelled: "The run was cancelled before it finished. Run the workflow again.",
  run_timed_out: "The run took too long and was stopped. Run the workflow again.",
  run_skipped: "The run was skipped. Run it from the main branch of the private deployment repository.",
};
/** What the latest "Refresh web update credential" failure means, in plain words. */
export function refreshFailureText(run: RefreshRun, filesCurrent = false): string {
  if (run.reason === "unreadable") return `The run failed${run.failedStep ? ` at the step "${run.failedStep}"` : ""}. To see the reason here, add Checks: Read-only to the dashboard update token, or open the run on GitHub.`;
  if (run.reason === "coded" && run.code) return refreshFailures[run.code] ?? `The run failed with the code ${run.code}. Open the run on GitHub to see how to fix it.`;
  return `The run stopped without saying why. ${filesCurrent ? "Open the run on GitHub to see the error." : refreshScriptOld}`;
}
export const refreshFailureCodes = Object.keys(refreshFailures);
const errorLinks: Record<string, readonly LinkKind[]> = {
  not_configured: ["install"],
  credential_required: [...credentialLinkKinds, "install"],
  credential_expired: credentialLinkKinds, credential_expiring: credentialLinkKinds, dispatch_credential_rejected: credentialLinkKinds,
  credential_permission: ["refresh"],
  selection_credential_required: credentialLinkKinds, selection_credential_expired: credentialLinkKinds, selection_credential_rejected: credentialLinkKinds,
  selection_credential_permission: ["refresh"],
  workflow_required: ["controller"], workflow_invalid: ["controller"], controller_upgrade_required: ["controller"], dispatch_unresolved: ["controller"],
};
/** Pages that fix the failure a code names, when the deployment repository is known. */
export function webUpdateErrorLinks(code: string | null | undefined, repository?: string | null): FixLink[] {
  return code && errorLinks[code] ? fixLinks(errorLinks[code]!, repository) : [];
}
const migrationLabels: Record<string, string> = { carpool: "Carpool", "hour-tracking": "Outreach Participation" };
export function webUpdateError(code?: string | null, fallback = "The web update could not be completed.") {
  if (code?.startsWith("module_migration_required")) {
    const names = code.split(":")[1]?.split(",").filter(Boolean).map((id) => migrationLabels[id] ?? id) ?? [];
    return `${names.length ? names.join(" and ") : "A module"} ${names.length > 1 ? "are" : "is"} in use and now a separate module. Nothing changed. Keep it by adding it in Settings > Modules, or turn it off there, then prepare the update again.`;
  }
  return code ? errors[code] ?? fallback : fallback;
}
export function webUpdateStatus(request: WebUpdateRequest) {
  const statuses: Record<WebUpdateRequest["state"], string> = {
    prepared: "Update prepared. Download the backup, then confirm that you saved the file.",
    dispatching: "Submitting this update to GitHub. Dispatch alone does not confirm installation.",
    queued: "Update queued in GitHub. Waiting for the workflow to start.",
    awaiting_approval: "Waiting for production approval in GitHub. An authorized reviewer must approve the run there.",
    running: "Update running. Builds and recovery checkpoints precede deployment.",
    verifying: "Verifying the API, dashboard and installation health. Completion is not yet confirmed.",
    succeeded: request.reloadReady ? "Update verified successfully. Both web releases and installation health are confirmed." : "Workflow completed. Waiting for verified installation health before reloading.",
    failed: "Update failed. Inspect the diagnostic run before deliberately preparing another update.",
    recovery_required: "Recovery required. Do not start another update. Open the diagnostic run in GitHub, then follow Manual recovery in the installation guide to repair the installation.",
    expired: "This prepared update expired. Prepare a new update and download its associated backup.",
  };
  const subject = request.mode === "modules" ? `Module changes for ${request.targetTag}` : `Update to ${request.targetTag}`;
  return `${subject}. ${statuses[request.state]}${request.errorCode ? ` ${webUpdateError(request.errorCode)}` : ""}${request.maintenance ? " Installation writes are paused; kiosk scans remain queued for replay." : ""}`;
}
/** A module-changes request keeps the release version, so a tab loaded before it finished needs a reload to use it. */
export function canReloadPluginChanges(request: WebUpdateRequest | undefined, loadedAt: number) {
  return Boolean(request && request.mode === "modules" && request.state === "succeeded" && request.reloadReady && !request.maintenance && Date.parse(request.updatedAt) > loadedAt);
}
export function canReloadWebUpdate(request: WebUpdateRequest, bundledVersion: string, installedVersion = request.targetTag) {
  return request.state === "succeeded" && request.reloadReady === true && !request.maintenance
    && isNewerRelease(request.targetTag, bundledVersion)
    && hasComparableStableVersions({ tag_name: request.targetTag, channel: request.channel, prerelease: request.targetTag.includes("-beta.") }, installedVersion)
    && !isNewerRelease(installedVersion, request.targetTag);
}
export function isCompletedWebUpdateHistory(request: WebUpdateRequest, installedVersion: string, bundledVersion: string) {
  if (request.state !== "succeeded" || !request.reloadReady || request.maintenance
    || !hasComparableStableVersions({ tag_name: request.targetTag, channel: request.channel, prerelease: request.targetTag.includes("-beta.") }, installedVersion)) return false;
  // A later manual deployment can supersede the last durable update request.
  return isNewerRelease(installedVersion, request.targetTag)
    || (installedVersion.replace(/^v/, "") === request.targetTag.replace(/^v/, "")
      && hasComparableStableVersions({ tag_name: request.targetTag, channel: request.channel, prerelease: request.targetTag.includes("-beta.") }, bundledVersion)
      && !isNewerRelease(request.targetTag, bundledVersion));
}
export function diagnosticUrl(value?: string | null) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
