export type WebUpdateRequest = {
  requestId: string; targetTag: string; targetCommit: string; releaseNotes: string; releaseUrl: string;
  previousVersion: string; state: "prepared" | "dispatching" | "queued" | "awaiting_approval" | "running" | "verifying" | "succeeded" | "failed" | "recovery_required" | "expired";
  stage: string; createdAt: string; expiresAt: string; updatedAt: string; backupExported: boolean;
  maintenance: boolean; errorCode: string | null; runUrl: string | null; reloadReady: boolean;
};
export type WebUpdateResponse = { releaseVersion: string; workflowUrl: string; request: WebUpdateRequest | null };

const errors: Record<string, string> = {
  not_configured: "Web updates need one-time setup in the private deployment repository. Ask your installation operator to configure them securely.",
  credential_required: "The web update credential is missing. Your installation operator must provision it securely.",
  credential_expired: "The web update credential has expired. Your installation operator must renew it securely before preparing another update.",
  not_private: "The deployment repository must be private before web updates can run.",
  workflow_required: "The private web update workflow needs to be installed by your installation operator.",
  cooldown: "GitHub or this installation is limiting update requests. Try again after the cooldown clears. If an update was recently started, wait at least two minutes from that start; provider limits may take longer.",
  already_current: "This installation is current.",
  release_unavailable: "A complete official stable release is unavailable. Try preparing again later.",
  invalid_request: "The update request is invalid. Refresh status before continuing.",
  request_missing: "The prepared update could not be found. Refresh status before preparing again.",
  request_expired: "This prepared update expired. Prepare a new update and download its associated backup.",
  backup_required: "Download this update's entire-installation backup and confirm that the file was saved before starting.",
  provider_unavailable: "GitHub is temporarily unavailable. Refresh status before trying again.",
  run_mismatch: "The workflow run could not be matched safely. Ask your installation operator to inspect it; do not dispatch again.",
  dispatch_ambiguous: "GitHub's dispatch response was uncertain. LancerLogin is reconciling this request; do not start another update.",
  dispatch_unresolved: "No unique workflow run could be proved. Manual investigation is required; do not dispatch again.",
};
export function webUpdateError(code?: string | null, fallback = "The web update could not be completed.") { return code ? errors[code] ?? fallback : fallback; }
export function webUpdateStatus(request: WebUpdateRequest) {
  const statuses: Record<WebUpdateRequest["state"], string> = {
    prepared: "Release pinned. Download the backup, then confirm that you saved the file.",
    dispatching: "Submitting this update to GitHub. Dispatch alone does not confirm installation.",
    queued: "Update queued in GitHub. Waiting for the workflow to start.",
    awaiting_approval: "Waiting for production approval in GitHub. An authorized reviewer must approve the run there.",
    running: "Update running. Builds and recovery checkpoints precede deployment.",
    verifying: "Verifying the API, dashboard and installation health. Completion is not yet confirmed.",
    succeeded: request.reloadReady ? "Update verified successfully. Both web releases and installation health are confirmed." : "Workflow completed. Waiting for verified installation health before reloading.",
    failed: "Update failed. Inspect the diagnostic run before deliberately preparing another update.",
    recovery_required: "Recovery required. Do not start another update. Your installation operator must inspect and repair the installation with explicit recovery authorization.",
    expired: "This prepared update expired. Prepare a new update and download its associated backup.",
  };
  return `${statuses[request.state]}${request.errorCode ? ` ${webUpdateError(request.errorCode)}` : ""}${request.maintenance ? " Installation writes are paused; kiosk scans remain queued for replay." : ""}`;
}
export function canReloadWebUpdate(request: WebUpdateRequest, bundledVersion: string) {
  return request.state === "succeeded" && request.reloadReady === true && request.targetTag.replace(/^v/, "") !== bundledVersion.replace(/^v/, "");
}
export function diagnosticUrl(value?: string | null) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
