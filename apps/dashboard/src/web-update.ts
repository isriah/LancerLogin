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
};
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
  selection_credential_required: `Plugin changes need the plugin selection credential. ${selectionTokenSteps}`,
  selection_credential_expired: `The plugin selection credential (${selectionSecretName}) has expired. ${selectionTokenSteps}`,
  selection_credential_rejected: `GitHub rejected the plugin selection credential (${selectionSecretName}). It was revoked, regenerated or has expired. ${selectionTokenSteps}`,
  selection_credential_permission: `The plugin selection credential (${selectionSecretName}) cannot access the deployment repository. Edit the fine-grained token so it covers the deployment repository with Contents: Read and write, then run the "Refresh web update credential" workflow.`,
  selection_unavailable: "The plugin selection could not be read from the private deployment repository. Try again later.",
  selection_invalid: "lancerlogin.modules.json in the deployment repository is invalid. Fix it on the main branch, then prepare the update again.",
  module_selection_changed: "The plugin selection changed after this update was prepared. Prepare it again and download its associated backup.",
  module_selection_preflight: "The plugin selection deployed by this update did not match the prepared one, so nothing changed. Prepare it again.",
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
};
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
    return `${names.length ? names.join(" and ") : "A module"} ${names.length > 1 ? "are" : "is"} in use and now a separate plugin. Nothing changed. Keep it by adding its plugin, or disable it in Settings > Modules, then prepare the update again.`;
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
  const subject = request.mode === "modules" ? `Plugin changes for ${request.targetTag}` : `Update to ${request.targetTag}`;
  return `${subject}. ${statuses[request.state]}${request.errorCode ? ` ${webUpdateError(request.errorCode)}` : ""}${request.maintenance ? " Installation writes are paused; kiosk scans remain queued for replay." : ""}`;
}
/** A plugin-changes request keeps the release version, so a tab loaded before it finished needs a reload to use it. */
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
