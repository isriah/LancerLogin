import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { credentialLinkKinds, credentialSteps, deploymentLinks, dispatchSecretName, fixLinks, missingRepositoryPermission, permissionSteps, refreshFailureText, repositoryPermissions, selectionSecretName, webUpdateError, type CredentialStatus, type FixLink, type RefreshRun, type RepositoryFiles, type RepositoryFilesProposal, type SetupStep, type UpdateSetup } from "./web-update";

type Tone = "success" | "warning" | "error" | "neutral";
const formatDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export const notSetUpTitle = "Dashboard updates are not set up yet";
export const manualUpgradeText = "This installation can still be updated: run the \"Install or upgrade LancerLogin\" workflow with operation \"upgrade\" in the private deployment repository.";
export const enableDashboardUpdatesText = "To update from this page instead, set up the dashboard update token:";

export function FixLinks({ links, label }: { links: FixLink[]; label: string }) {
  if (!links.length) return null;
  return <ul className="update-fix-links" aria-label={label}>{links.map((link) => <li key={link.href}><a href={link.href} target="_blank" rel="noreferrer">{link.label}</a></li>)}</ul>;
}

/** Numbered setup steps, each with the link to the page it happens on. */
export function SetupSteps({ steps, label }: { steps: SetupStep[]; label: string }) {
  return <ol className="update-setup-steps" aria-label={label}>{steps.map((step) => <li key={step.text}><span>{step.text}</span>{step.link && <> <a href={step.link.href} target="_blank" rel="noreferrer">{step.link.label}</a></>}</li>)}</ol>;
}

/** Without WEB_UPDATE_TOKEN the installation is healthy; updates run from the deployment repository instead. */
export function DashboardUpdatesNotSetUp({ repository }: { repository: string | null }) {
  return <div className="update-not-set-up" role="group" aria-labelledby="update-not-set-up-title">
    <p id="update-not-set-up-title"><strong>{notSetUpTitle}</strong></p>
    <p>{manualUpgradeText}</p>
    <FixLinks label="Update from the deployment repository" links={fixLinks(["install"], repository)} />
    <p>{enableDashboardUpdatesText}</p>
    <SetupSteps label="Set up dashboard updates" steps={credentialSteps("dispatch", repository)} />
  </div>;
}

/** recheck: the row offers Check again, which rereads it from GitHub instead of the API cache. */
type Row = { id: string; label: string; badge: string; tone: Tone; detail: string; links: FixLink[]; steps?: SetupStep[]; content?: ReactNode; recheck?: boolean };
function credentialRow(id: "dispatch" | "selection", label: string, status: CredentialStatus, secret: string, missing: string, repository: string | null): Row {
  const expiry = status.expiresAt ? `Expires ${formatDate(status.expiresAt)}.` : "No expiry.";
  const renew = `Replace the production environment secret ${secret} with a new token, then run the "Refresh web update credential" workflow.`;
  const steps = credentialSteps(id, repository);
  switch (status.state) {
    case "ready": return { id, label, badge: "Ready", tone: "success", detail: expiry, links: [] };
    case "expiring": return { id, label, badge: "Expiring soon", tone: "warning", detail: `${expiry} ${renew}`, links: fixLinks(credentialLinkKinds, repository) };
    case "expired": return { id, label, badge: "Expired", tone: "error", detail: `${status.expiresAt ? `Expired ${formatDate(status.expiresAt)}. ` : ""}Replace it with a new token:`, links: [], steps };
    case "rejected": return { id, label, badge: "Rejected by GitHub", tone: "error", detail: `GitHub rejected ${secret}: it was revoked, regenerated or has expired. Replace it with a new token:`, links: [], steps };
    default: return { id, label, badge: "Not set up", tone: "neutral", detail: missing, links: [], steps };
  }
}

const proposalPath = "/admin/web-updates/repository-files";
/** Settings > Updates > Setup status: the deployment repository's own workflow files against the installed release. */
function RepositoryFilesContent({ files, repository }: { files: RepositoryFiles; repository: string | null }) {
  const [busy, setBusy] = useState(false); const [proposal, setProposal] = useState<RepositoryFilesProposal>();
  const [error, setError] = useState<{ code: string; message: string }>();
  const pullRequest = proposal?.pullRequest ?? files.pullRequest;
  async function propose() {
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`${apiBaseUrl}${proposalPath}`, { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json().catch(() => ({})) as RepositoryFilesProposal & { code?: string; error?: string };
      if (!response.ok) throw Object.assign(new Error(webUpdateError(result.code, result.error ?? "The repository files could not be updated. Try again later.")), { code: result.code ?? "" });
      setProposal(result);
    } catch (cause) { setError({ code: (cause as { code?: string }).code ?? "", message: (cause as Error).message }); }
    finally { setBusy(false); }
  }
  const permission = missingRepositoryPermission(error?.code);
  if (pullRequest) return <div className="update-repository-files">
    <p>A pull request with this release's workflow files is open in the deployment repository. Nothing changes until you merge it.</p>
    <a className="update-repository-files-link" href={pullRequest.url} target="_blank" rel="noreferrer">Review and merge it on GitHub</a>
  </div>;
  return <div className="update-repository-files">
    <p className="field-help">Opens a pull request in {repository ?? "the deployment repository"} with {files.release}'s versions of {files.outdated.length === 1 ? "1 file" : `${files.outdated.length} files`}. Nothing changes until you review and merge it. The dashboard update token needs Contents, Pull requests and Workflows: Read and write.</p>
    <details className="update-repository-files-list"><summary>Files to update</summary><ul>{files.outdated.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>
    <div><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void propose()}>{busy ? "Opening pull request…" : "Update repository files"}</button></div>
    {error && <p className="ui-status" data-tone="error" role="alert">{error.message}</p>}
    {permission && <SetupSteps label="Add the missing permission" steps={permissionSteps([permission])} />}
  </div>;
}
const checkable = (setup: UpdateSetup) => setup.dispatchCredential.state === "ready" || setup.dispatchCredential.state === "expiring";
/** States that change on GitHub without this page knowing, so returning to the tab checks them again. */
const settling = (setup: UpdateSetup) => checkable(setup) && (["outdated", "unknown"].includes(setup.repositoryFiles?.state ?? "") || ["failed", "running", "unknown"].includes(setup.refreshRun?.state ?? ""));
function repositoryFilesRow(files: RepositoryFiles, setup: UpdateSetup): Row {
  const base = { id: "repository-files", label: "Repository workflow files", links: [], recheck: checkable(setup) && Boolean(files.release) };
  switch (files.state) {
    case "current": return { ...base, badge: "Up to date", tone: "success", detail: `The deployment repository's workflow files match ${files.release}.` };
    case "outdated": return { ...base, badge: "Update available", tone: "warning", detail: `Your repository's workflow files are older than ${files.release}.`, content: <RepositoryFilesContent files={files} repository={setup.repository} /> };
    case "permission_required": return { ...base, badge: "Needs permission", tone: "neutral", detail: `Web updates never change the deployment repository, so its workflow files can fall behind ${files.release ?? "the installed release"}. To check them and update them from here, give the dashboard update token more permissions:`, steps: permissionSteps(repositoryPermissions, "Come back to this page and choose Check again.") };
    default: return { ...base, badge: "Not checked", tone: "neutral", detail: !files.release ? "This build is not an official release, so there is nothing to compare." : setup.dispatchCredential.state === "ready" || setup.dispatchCredential.state === "expiring" ? "GitHub could not be reached. This is checked again shortly." : "The files are checked with the dashboard update credential once that credential is ready." };
  }
}
function refreshRunRow(run: RefreshRun, setup: UpdateSetup): Row {
  const base = { id: "refresh-run", label: "Latest credential refresh", recheck: checkable(setup) };
  const refresh = deploymentLinks(setup.repository).refresh;
  const runLink: FixLink[] = run.runUrl ? [{ label: "Open the run on GitHub", href: run.runUrl }] : [];
  const rerun: FixLink[] = refresh ? [{ label: "Run Refresh web update credential", href: refresh }] : [];
  switch (run.state) {
    case "none": return { ...base, badge: "Not run yet", tone: "neutral", detail: "\"Refresh web update credential\" has not run in the deployment repository yet.", links: rerun };
    case "running": return { ...base, badge: "Running", tone: "neutral", detail: "\"Refresh web update credential\" is running. Its result appears here when it finishes.", links: runLink };
    case "succeeded": return { ...base, badge: "Succeeded", tone: "success", detail: run.finishedAt ? `The last run finished ${new Date(run.finishedAt).toLocaleString()}.` : "The last run succeeded.", links: runLink };
    case "failed": return { ...base, badge: "Failed", tone: "error", detail: refreshFailureText(run, setup.repositoryFiles?.state === "current"), links: [...runLink, ...rerun] };
    default: return { ...base, badge: "Not checked", tone: "neutral", detail: setup.dispatchCredential.state === "ready" || setup.dispatchCredential.state === "expiring" ? "GitHub could not be reached. This is checked again shortly." : "The latest run is checked with the dashboard update credential once that credential is ready.", links: [] };
  }
}
export function setupRows(setup: UpdateSetup): Row[] {
  const repository = setup.repository;
  const controllerLinks = fixLinks(["controller"], repository);
  const controller: Row = setup.controller === "current" ? { id: "controller", label: "Update controller workflow", badge: "Ready", tone: "success", detail: "upgrade-web.yml in the deployment repository supports stable and beta updates.", links: [] }
    : setup.controller === "upgrade_required" ? { id: "controller", label: "Update controller workflow", badge: "Update needed", tone: "warning", detail: "Stable updates work. Beta updates need the current controller: use Update repository files below, or replace .github/workflows/upgrade-web.yml in the deployment repository with this release's version and commit it to main.", links: controllerLinks }
    : setup.controller === "missing" ? { id: "controller", label: "Update controller workflow", badge: "Missing", tone: "error", detail: "upgrade-web.yml is missing or disabled in the deployment repository, or the dashboard update credential cannot read it. Copy .github/workflows/upgrade-web.yml from this release's template, commit it to main and enable it.", links: controllerLinks }
    : { id: "controller", label: "Update controller workflow", badge: "Not checked", tone: "neutral", detail: "The controller is checked with the dashboard update credential once that credential is ready.", links: [] };
  return [
    credentialRow("dispatch", "Dashboard update credential", setup.dispatchCredential, dispatchSecretName, `Optional. ${manualUpgradeText} ${enableDashboardUpdatesText}`, repository),
    controller,
    credentialRow("selection", "Module management credential", setup.selectionCredential, selectionSecretName, "Optional. Without it, edit lancerlogin.modules.json in the deployment repository to add, update or remove modules. To do that from Settings > Modules instead, set up the module management token:", repository),
    ...(setup.refreshRun ? [refreshRunRow(setup.refreshRun, setup)] : []),
    ...(setup.repositoryFiles ? [repositoryFilesRow(setup.repositoryFiles, setup)] : []),
  ];
}

const recheckPath = "/admin/web-updates/setup/recheck";
/** Settings > Updates: readiness of each piece dashboard updates depend on, with the fix for any that is not ready. */
export function UpdateSetupPanel({ setup, onSetup }: { setup?: UpdateSetup; onSetup?: (setup: UpdateSetup) => void }) {
  const [checking, setChecking] = useState(false); const [checkError, setCheckError] = useState<{ row: string; message: string }>();
  const flight = useRef(false); const lastCheck = useRef(0); const latest = useRef(setup); latest.current = setup;
  // row is the row whose Check again was chosen; automatic checks on returning to the tab stay quiet when they fail.
  async function recheck(row?: string) {
    if (flight.current) return;
    flight.current = true; lastCheck.current = Date.now(); setChecking(true); setCheckError(undefined);
    try {
      const response = await fetch(`${apiBaseUrl}${recheckPath}`, { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json().catch(() => ({})) as { setup?: UpdateSetup; code?: string; error?: string };
      if (!response.ok || !result.setup) throw new Error(webUpdateError(result.code, result.error ?? "The setup checks could not run. Try again later."));
      onSetup?.(result.setup);
    } catch (cause) { if (row) setCheckError({ row, message: (cause as Error).message }); }
    finally { flight.current = false; setChecking(false); }
  }
  // Returning to the tab after merging a pull request or running a workflow on GitHub checks unsettled rows again, at most once a minute.
  useEffect(() => { function visible() { const current = latest.current; if (!document.hidden && current && settling(current) && Date.now() - lastCheck.current >= 60_000) void recheck(); } document.addEventListener("visibilitychange", visible); return () => document.removeEventListener("visibilitychange", visible); }, []);
  if (!setup) return null;
  return <section className="ui-card update-setup-card" aria-labelledby="update-setup-title">
    <div className="panel-heading"><h2 id="update-setup-title">Setup status</h2></div>
    <ul className="update-setup-list">{setupRows(setup).map((row) => <li key={row.id} className="update-setup-row" data-setup={row.id} aria-labelledby={`update-setup-${row.id}`}>
      <div className="update-setup-row-heading"><strong id={`update-setup-${row.id}`}>{row.label}</strong><span className="ui-status update-setup-badge" data-tone={row.tone}>{row.badge}</span></div>
      <p>{row.detail}</p>
      {row.steps && <SetupSteps label={`Steps for ${row.label.toLowerCase()}`} steps={row.steps} />}
      {row.content}
      <FixLinks label={`Fix ${row.label.toLowerCase()}`} links={row.links} />
      {row.recheck && <div className="update-setup-recheck"><button className="ui-button" type="button" aria-describedby={`update-setup-${row.id}`} disabled={checking} onClick={() => void recheck(row.id)}>{checking ? "Checking…" : "Check again"}</button></div>}
      {checkError?.row === row.id && <p className="ui-status" data-tone="error" role="alert">{checkError.message}</p>}
    </li>)}</ul>
  </section>;
}

const dismissalKey = "lancerlogin-update-credential-warning-dismissed";
function readDismissal(): string { try { return localStorage.getItem(dismissalKey) ?? ""; } catch { return ""; } }
/** A dismissible warning while the dashboard update credential expires within 14 days. Dismissal lasts until the expiry changes. */
export function CredentialExpiryBanner({ setup }: { setup?: UpdateSetup }) {
  const [dismissed, setDismissed] = useState(readDismissal);
  const credential = setup?.dispatchCredential;
  if (credential?.state !== "expiring" || !credential.expiresAt || dismissed === credential.expiresAt) return null;
  const expiresAt = credential.expiresAt;
  return <div className="ui-status settings-notice update-credential-banner" data-tone="warning">
    <p role="status">The dashboard update credential expires {formatDate(expiresAt)}. Before then, replace the production environment secret {dispatchSecretName} with a new token and run the "Refresh web update credential" workflow, or updates from this page will stop working.</p>
    <FixLinks label="Renew the dashboard update credential" links={fixLinks(credentialLinkKinds, setup!.repository)} />
    <button className="ui-button" type="button" aria-label="Dismiss credential expiry warning" onClick={() => { try { localStorage.setItem(dismissalKey, expiresAt); } catch { /* per-viewer convenience only */ } setDismissed(expiresAt); }}>Dismiss</button>
  </div>;
}
export const credentialExpiryNotice = (credential?: CredentialStatus) => credential?.state === "expiring" && credential.expiresAt ? `The dashboard update credential expires ${formatDate(credential.expiresAt)}. Renew it before then.` : "";
