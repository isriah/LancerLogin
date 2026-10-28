import { useEffect, useId, useRef, useState } from "react";
import { useModalFocus } from "./modal-focus";
import { IdentityConfirmation, request, RequestError, type PluginState } from "./plugin-management";

type ProviderState = "missing" | "unsupported" | "disabled" | "setup-required" | "ready";
export type ModuleAccessUse = {
  consumer: { id: string; label: string; phase: string | null };
  provider: { id: string; label: string | null; state: ProviderState };
  interface: { id: string; version: number; label: string | null };
  required: boolean;
  reason: string;
  operations: Array<{ id: string; label: string | null; grantable: boolean }>;
  grantable: string[];
  grant: { id: string; operations: string[]; grantedAt: string; grantedBy: string | null; current: boolean } | null;
};
export type ModuleAccessState = { uses: ModuleAccessUse[]; reauthentication: PluginState["reauthentication"] };
type Review = { action: "grant" | "revoke"; use: ModuleAccessUse };

const providerName = (use: ModuleAccessUse) => use.provider.label ?? use.provider.id;
const operationName = (operation: ModuleAccessUse["operations"][number]) => operation.label ?? operation.id;
const providerText: Record<ProviderState, (use: ModuleAccessUse) => string> = {
  missing: (use) => `${providerName(use)} is not installed, so this access is unavailable.`,
  unsupported: (use) => `${providerName(use)} does not offer what ${use.consumer.label} asks for (version ${use.interface.version}), so this access is unavailable.`,
  disabled: (use) => `${providerName(use)} is not enabled, so this access is unavailable until it is.`,
  "setup-required": (use) => `${providerName(use)} setup is not complete, so this access is unavailable until it is.`,
  ready: () => "",
};
function grantText(use: ModuleAccessUse) {
  if (use.grant) {
    const granted = `Granted by ${use.grant.grantedBy ?? "a former Admin"} on ${new Date(use.grant.grantedAt).toLocaleString()}.`;
    return use.grant.current ? granted : `${granted} ${use.consumer.label} now asks for more than this grant covers. Grant again to include it.`;
  }
  return use.grantable.length ? `Not granted. Signed-in people with access to ${providerName(use)} can still use it from ${use.consumer.label}.` : `Cannot be granted. Only signed-in people with access to ${providerName(use)} can use it from ${use.consumer.label}.`;
}
const canGrant = (use: ModuleAccessUse) => !["missing", "unsupported"].includes(use.provider.state) && use.grantable.length > 0 && !use.grant?.current;

function AccessDialog({ review, state, freshUntil, onFresh, onReload, onClose, onDone }: { review: Review; state: ModuleAccessState; freshUntil: number | null; onFresh: (until: number | null) => void; onReload: () => void; onClose: () => void; onDone: (message: string, next: ModuleAccessState) => void }) {
  const { action, use } = review;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const id = useId();
  useModalFocus(dialog, true, busy, onClose);
  const fresh = Boolean(freshUntil && freshUntil > Date.now());
  const granted = use.operations.filter((operation) => action === "grant" ? use.grantable.includes(operation.id) : use.grant?.operations.includes(operation.id));
  const excluded = action === "grant" ? use.operations.filter((operation) => !use.grantable.includes(operation.id)) : [];
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError("");
    try { await operation(); return true; }
    catch (cause) {
      setError((cause as Error).message);
      if ((cause as RequestError).code === "reauthentication_required") onFresh(null);
      // The request changed or the grant was already revoked elsewhere: refresh the list behind the dialog for review.
      else if ((cause as RequestError).code === "grant_changed") onReload();
      return false;
    }
    finally { setBusy(false); }
  }
  const confirmIdentity = (password: string) => run(async () => { onFresh((await request<{ freshUntil: number | null }>("/admin/plugins/reauthenticate", { password, purpose: "module_access" })).freshUntil); });
  const submit = () => run(async () => {
    const next = action === "grant"
      ? await request<ModuleAccessState>("/admin/modules/grants", { consumer: use.consumer.id, interface: use.interface.id, version: use.interface.version, operations: use.grantable })
      : await request<ModuleAccessState>("/admin/modules/grants/revoke", { grantId: use.grant!.id });
    onDone(action === "grant" ? `${use.consumer.label} can now use ${providerName(use)} without a signed-in user.` : `Revoked ${use.consumer.label}'s access to ${providerName(use)}.`, next);
  });
  const title = `${action === "grant" ? "Grant" : "Revoke"} ${use.consumer.label} access`;
  return <div className="dialog-backdrop"><section ref={dialog} className="ui-dialog plugin-change-dialog module-access-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
    <div className="dialog-heading"><div><h2 id={`${id}-title`}>{title}</h2><p>{action === "grant" ? `${use.consumer.label} will be able to do this on its own, for example from scheduled work or a public page, without a signed-in user:` : `${use.consumer.label} will no longer be able to do this without a signed-in user. A call already running stops at its next step:`}</p></div>
      <button type="button" className="ui-button" aria-label="Close module access dialog" disabled={busy} onClick={onClose}>×</button></div>
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    <ul className="module-access-operations">{granted.map((operation) => <li key={operation.id}>{operationName(operation)}</li>)}</ul>
    {excluded.length > 0 && <p className="field-help">Not included: {excluded.map(operationName).join(", ")}. Only signed-in people with access to {providerName(use)} can do this.</p>}
    <dl className="plugin-review-details">
      <div><dt>Reason</dt><dd>{use.reason}</dd></div>
      <div><dt>Provided by</dt><dd>{providerName(use)}{use.interface.label ? `, ${use.interface.label}` : ""} (version {use.interface.version})</dd></div>
    </dl>
    <IdentityConfirmation options={state.reauthentication} freshUntil={freshUntil} busy={busy} action="change module access" onConfirm={confirmIdentity} />
    <div className="module-actions">
      <button className={`ui-button ui-button--primary primary-button${action === "revoke" ? " ui-button--danger" : ""}`} type="button" disabled={busy || !fresh} onClick={() => void submit()}>{busy ? "Saving…" : action === "grant" ? "Grant access" : "Revoke access"}</button>
      <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </section></div>;
}

/**
 * Settings > Modules: what each module asks to use from another module, and the standing grants that let it do so without a
 * signed-in user. Hidden when no installed module declares a use.
 */
export function ModuleAccessGrants() {
  const [state, setState] = useState<ModuleAccessState>();
  const [freshUntil, setFreshUntil] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<Review>();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  function apply(next: ModuleAccessState) { setState(next); setFreshUntil(next.reauthentication.freshUntil); }
  const load = () => request<ModuleAccessState>("/admin/modules/grants").then((next) => { apply(next); setError(""); }, (cause: Error) => setError(`Module access could not be loaded. ${cause.message}`));
  useEffect(() => { void load(); }, []);
  // The dialog returns focus to its button; after a change that button may be gone, so the result takes focus instead.
  function done(message: string, next: ModuleAccessState) { setReview(undefined); setNotice(message); apply(next); window.requestAnimationFrame(() => noticeRef.current?.focus()); }
  if (!state?.uses.length) return error ? <p className="ui-status" data-tone="error" role="alert">{error}</p> : null;
  return <section className="module-controls module-access" aria-labelledby={`${id}-title`}>
    <div className="panel-heading"><div><h2 id={`${id}-title`}>Module access</h2><p>Some modules ask to use another module's data. Signed-in people can always use what their own access allows. A grant lets a module do it on its own, for example from scheduled work, without anyone signed in. Grant only what you expect it to need.</p></div></div>
    {notice && <p ref={noticeRef} className="ui-status settings-notice" data-tone="success" role="status" tabIndex={-1}>{notice}</p>}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    <ul className="plugin-list">{state.uses.map((use) => {
      const name = `${use.consumer.label} access to ${providerName(use)}`;
      const status = use.grant ? use.grant.current ? "granted" : "outdated" : "not-granted";
      return <li key={`${use.consumer.id}:${use.interface.id}:${use.interface.version}`} className="plugin-row module-access-row" data-status={status} data-provider={use.provider.state}>
        <div><strong>{use.consumer.label} asks to use {providerName(use)}</strong>
          <ul className="module-access-operations">{use.operations.map((operation) => <li key={operation.id}>{operationName(operation)}{operation.label && !operation.grantable ? " (signed-in people only)" : ""}</li>)}</ul>
          <small>Reason: {use.reason}</small>
          {use.required && <small>{use.consumer.label} cannot be enabled without {providerName(use)}.</small>}
          {use.provider.state !== "ready" && <small>{providerText[use.provider.state](use)}</small>}
          <span className="module-access-status">{grantText(use)}</span></div>
        <div className="module-actions">
          {canGrant(use) && <button className="ui-button ui-button--primary primary-button" type="button" aria-label={`${use.grant ? "Grant again" : "Grant"} ${name}`} onClick={() => { setNotice(""); setReview({ action: "grant", use }); }}>{use.grant ? "Grant again" : "Grant"}</button>}
          {use.grant && <button className="ui-button" type="button" aria-label={`Revoke ${name}`} onClick={() => { setNotice(""); setReview({ action: "revoke", use }); }}>Revoke</button>}
        </div></li>;
    })}</ul>
    {review && <AccessDialog review={review} state={state} freshUntil={freshUntil} onFresh={setFreshUntil} onReload={() => void load()} onClose={() => setReview(undefined)} onDone={done} />}
  </section>;
}
