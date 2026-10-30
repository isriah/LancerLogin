import { FormEvent, Fragment, useEffect, useRef, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { readModuleSnapshot } from "./module-client";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { InfoHeading } from "./info-tip";

// Keeps password managers from filling the signed-in Admin's own sign-in details into fields for another account.
const passwordManagerIgnore = { "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" } as const;

export type RosterMember = { id: string; memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string; active: boolean | number; attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null; hasDashboardAccess?: boolean | number };
type User = { id: string; email?: string | null; localUsername?: string | null; memberId?: string | null; memberExternalId?: string; memberFirstName?: string; memberLastName?: string; role: "admin" | "operator"; active: boolean | number; createdAt: string };
type Assignments = { userId: string; revision: number; capabilities: string[] };
/** Module grants for one account: loading, loaded, or unavailable. */
type Grants = { state: "loading" } | { state: "ready"; value: Assignments } | { state: "error"; message: string };
type Draft = { role: User["role"]; memberId: string; email: string; capabilities: string[] };

const roleLabel = (role: User["role"]) => role === "admin" ? "Admin" : "Operator";
const accountName = (user: User) => user.memberId ? `${user.memberFirstName} ${user.memberLastName}` : user.email?.toLowerCase() ?? user.localUsername ?? "account";
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every((item) => right.includes(item));
/** Admins first, then Operators, alphabetical by name within each role. */
const sortAccounts = (users: User[]) => [...users].sort((left, right) => (left.role === right.role ? 0 : left.role === "admin" ? -1 : 1) || accountName(left).localeCompare(accountName(right), undefined, { sensitivity: "base" }));
const draftFor = (user: User, grants?: Grants): Draft => ({ role: user.role, memberId: user.memberId ?? "", email: user.email?.toLowerCase() ?? "", capabilities: grants?.state === "ready" ? grants.value.capabilities : [] });

/** Module labels covered by an Operator's grants, for the Modules column. */
function moduleSummary(capabilities: string[], modules: ModuleSnapshotItem[]) {
  const labels = modules.filter((module) => module.permissions.some((permission) => capabilities.includes(permission.id))).map((module) => module.label);
  return labels.length ? labels.join(", ") : "None";
}

export function UserSettings({ members }: { members: RosterMember[] }) {
  const [users, setUsers] = useState<User[]>([]); const [loading, setLoading] = useState(true); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [modules, setModules] = useState<ModuleSnapshotItem[]>([]); const [grants, setGrants] = useState<Record<string, Grants>>({});
  const [creating, setCreating] = useState(false); const [method, setMethod] = useState<"local" | "google">("local"); const [identifier, setIdentifier] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [role, setRole] = useState<"admin" | "operator">("operator"); const [memberId, setMemberId] = useState("");
  const [editing, setEditing] = useState<string>(); const [draft, setDraft] = useState<Draft>(); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(""); const [panelError, setPanelError] = useState(""); const [confirmingActive, setConfirmingActive] = useState(false); const [inactiveOpen, setInactiveOpen] = useState(false);
  const editingRef = useRef<string>(undefined); editingRef.current = editing;
  const grantButton = useRef<HTMLButtonElement>(null); const statusLine = useRef<HTMLParagraphElement>(null); const savedTimer = useRef<number>(undefined);
  useDashboardLoadingOverlay(loading, "Loading dashboard access…");

  async function loadGrants(user: User) {
    setGrants((current) => ({ ...current, [user.id]: { state: "loading" } }));
    try { const value = await api<Assignments>(`/admin/modules/assignments/${encodeURIComponent(user.id)}`); setGrants((current) => ({ ...current, [user.id]: { state: "ready", value } })); return value; }
    catch (caught) { setGrants((current) => ({ ...current, [user.id]: { state: "error", message: (caught as Error).message } })); return undefined; }
  }
  async function load() {
    const result = await api<{ users: User[] }>("/admin/users"); setUsers(result.users); setLoading(false);
    const operators = result.users.filter((user) => user.role === "operator");
    if (operators.length) void api<unknown>("/platform/modules").then((value) => setModules([...readModuleSnapshot(value).modules])).catch(() => undefined);
    for (const user of operators) void loadGrants(user);
    return result.users;
  }
  useEffect(() => { void load().catch((caught: Error) => { setLoading(false); setError(caught.message); }); return () => window.clearTimeout(savedTimer.current); }, []);
  function announce(message: string) { setNotice(message); window.requestAnimationFrame(() => statusLine.current?.focus()); }
  function showError(message: string) { setError(message); window.requestAnimationFrame(() => document.getElementById("dashboard-access-error")?.focus()); }

  function toggleCreate() {
    setError("");
    if (creating) { setCreating(false); grantButton.current?.focus(); return; }
    setCreating(true); window.requestAnimationFrame(() => document.getElementById("access-new-member")?.focus());
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setError(""); if (method === "local" && password !== confirmation) { showError("Temporary password confirmation does not match."); return; }
    try { await api("/admin/users", { method: "POST", body: JSON.stringify(method === "local" ? { localUsername: identifier, localPassword: password, memberId: memberId || null, role } : { email: identifier, memberId: memberId || null, role }) }); setIdentifier(""); setPassword(""); setConfirmation(""); setMemberId(""); setCreating(false); await load(); setNotice("Dashboard access created and audited."); grantButton.current?.focus(); }
    catch (caught) { showError((caught as Error).message); }
  }

  function closeEditor(focusRow = true) { const userId = editing; setEditing(undefined); setDraft(undefined); setPanelError(""); setSaved(""); setConfirmingActive(false); if (focusRow && userId) window.requestAnimationFrame(() => document.getElementById(`access-edit-button-${userId}`)?.focus()); }
  /** One edit panel at a time: opening another account discards the open panel's unsaved changes. */
  function openEditor(user: User) {
    if (editing === user.id) { closeEditor(); return; }
    setEditing(user.id); setDraft(draftFor(user, grants[user.id])); setPanelError(""); setSaved(""); setConfirmingActive(false);
    // Admin rows have no grants loaded yet; read them so switching the role to Operator shows the stored assignments.
    if (grants[user.id]?.state !== "ready") void loadGrants(user).then((value) => { if (value && editingRef.current === user.id) setDraft((current) => current && { ...current, capabilities: value.capabilities }); });
    window.requestAnimationFrame(() => document.getElementById(`access-role-${user.id}`)?.focus());
  }
  async function save(event: FormEvent, user: User) {
    event.preventDefault(); if (!draft || saving) return;
    const patch: { role?: User["role"]; memberId?: string | null; email?: string | null } = {};
    if (draft.role !== user.role) patch.role = draft.role;
    if ((draft.memberId || null) !== (user.memberId ?? null)) patch.memberId = draft.memberId || null;
    const email = draft.email.trim().toLowerCase() || null; if (email !== (user.email?.toLowerCase() ?? null)) patch.email = email;
    const stored = grants[user.id]; const modulesChanged = draft.role === "operator" && stored?.state === "ready" && !sameSet(stored.value.capabilities, draft.capabilities);
    setPanelError(""); setSaved("");
    if (!Object.keys(patch).length && !modulesChanged) { setSaved("No changes to save."); return; }
    setSaving(true);
    try {
      if (Object.keys(patch).length) await api(`/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (modulesChanged && stored?.state === "ready") { const value = await api<Assignments>(`/admin/modules/assignments/${encodeURIComponent(user.id)}`, { method: "PUT", body: JSON.stringify({ capabilities: draft.capabilities, revision: stored.value.revision }) }); setGrants((current) => ({ ...current, [user.id]: { state: "ready", value } })); }
      await load(); setDraft((current) => current && { ...current, email: email ?? "" }); setSaved("Saved");
      window.clearTimeout(savedTimer.current); savedTimer.current = window.setTimeout(() => setSaved(""), 4_000);
    } catch (caught) {
      setPanelError((caught as Error).message); window.requestAnimationFrame(() => document.getElementById(`access-edit-error-${user.id}`)?.focus());
      // A role or roster change may have saved before a later step failed; show what the server now holds.
      void load().catch(() => undefined);
    } finally { setSaving(false); }
  }
  async function changeActive(user: User) {
    setSaving(true); setPanelError("");
    try { await api(`/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ active: !user.active }) }); closeEditor(false); await load(); announce(user.active ? `${accountName(user)} was deactivated and signed out.` : `${accountName(user)} was reactivated.`); }
    catch (caught) { setPanelError((caught as Error).message); window.requestAnimationFrame(() => document.getElementById(`access-edit-error-${user.id}`)?.focus()); }
    finally { setSaving(false); }
  }

  const available = members.filter((member) => member.active && !users.some((user) => user.memberId === member.id));
  const sorted = sortAccounts(users); const active = sorted.filter((user) => user.active); const inactive = sorted.filter((user) => !user.active);
  const operatorPermissions = modules.flatMap((module) => module.permissions.filter((permission) => permission.operator).map((permission) => ({ module, permission })));
  const modulesCell = (user: User) => { if (user.role === "admin") return "All"; const value = grants[user.id]; return !value || value.state === "loading" ? "Loading…" : value.state === "error" ? "Unavailable" : moduleSummary(value.value.capabilities, modules); };

  function editPanel(user: User) {
    if (!draft) return null; const name = accountName(user); const grant = grants[user.id];
    return <form id={`access-edit-${user.id}`} className="access-edit-panel" autoComplete="off" aria-label={`Edit ${name}`} onSubmit={(event) => void save(event, user)}>
      <div className="access-edit-fields">
        <label htmlFor={`access-role-${user.id}`}>Role<select id={`access-role-${user.id}`} aria-label={`Role for ${user.email?.toLowerCase() ?? user.localUsername}`} value={draft.role} disabled={saving} onChange={(event) => setDraft({ ...draft, role: event.target.value as User["role"] })}><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
        <label htmlFor={`access-member-${user.id}`}>Roster link<select id={`access-member-${user.id}`} aria-label={`Roster link for ${user.email?.toLowerCase() ?? user.localUsername}`} value={draft.memberId} disabled={saving} onChange={(event) => setDraft({ ...draft, memberId: event.target.value })}><option value="">Not on roster</option>{members.filter((member) => member.id === user.memberId || !users.some((item) => item.memberId === member.id)).map((member) => <option key={member.id} value={member.id}>{member.firstName} {member.lastName} · {member.memberId}</option>)}</select></label>
        <div className="access-readonly-field"><span id={`access-username-label-${user.id}`}>Local username</span><output aria-labelledby={`access-username-label-${user.id}`} className="account-identifier">{user.localUsername ?? "None"}</output><p className="field-help">Usernames cannot be changed.</p></div>
        <div className="access-email-field"><label htmlFor={`access-google-email-${user.id}`}>Google email<input id={`access-google-email-${user.id}`} name={`access-google-email-${user.id}`} type="email" autoComplete="off" autoCapitalize="off" spellCheck={false} {...passwordManagerIgnore} aria-label={`Google email for ${name}`} aria-invalid={Boolean(panelError)} aria-describedby={`access-email-help-${user.id}`} value={draft.email} disabled={saving} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label><p id={`access-email-help-${user.id}`} className="field-help">Used for Sign in with Google. Leave it empty to remove it.</p></div>
      </div>
      <fieldset className="access-module-fieldset"><legend>Module access</legend>{draft.role === "admin" ? <p className="module-grants-summary">Admins can use every enabled module.</p> : !grant || grant.state === "loading" ? <p className="module-grants-summary" role="status">Loading module assignments…</p> : grant.state === "error" ? <p className="ui-status" data-tone="error" role="alert">Module assignments could not be loaded. {grant.message}</p> : <><p className="field-help">Operators need an explicit assignment for each module. Core roster and account access remain available without one.</p>{!user.active && <p className="field-help">Inactive Operators cannot use module workflows until reactivated.</p>}{operatorPermissions.length ? <div className="access-module-choices">{operatorPermissions.map(({ module, permission }) => <label className="module-choice" key={permission.id}><input type="checkbox" checked={draft.capabilities.includes(permission.id)} disabled={saving || module.phase === "deleting" || module.phase === "deleted"} onChange={() => setDraft({ ...draft, capabilities: draft.capabilities.includes(permission.id) ? draft.capabilities.filter((item) => item !== permission.id) : [...draft.capabilities, permission.id] })} /><span>{permission.label}<small>{module.enabled ? "Module enabled" : "Assignment retained while module is disabled"}</small></span></label>)}</div> : <p className="module-grants-summary">No enabled module offers Operator access.</p>}</>}</fieldset>
      {panelError && <p id={`access-edit-error-${user.id}`} className="inline-messages error" role="alert" tabIndex={-1}>{panelError}</p>}
      <div className="access-edit-actions">
        <div className="access-edit-danger">{confirmingActive ? <div className="access-confirm" role="group" aria-label={user.active ? "Confirm deactivation" : "Confirm reactivation"}><p>{user.active ? `Deactivate ${name}? They are signed out everywhere and cannot sign in until reactivated.` : `Reactivate ${name}? They can sign in again with their existing role.`}</p><button id={`access-confirm-active-${user.id}`} className={user.active ? "danger-button" : "primary-button"} type="button" disabled={saving} onClick={() => void changeActive(user)}>{user.active ? "Confirm deactivate" : "Confirm reactivate"}</button><button type="button" disabled={saving} onClick={() => { setConfirmingActive(false); window.requestAnimationFrame(() => document.getElementById(`access-active-${user.id}`)?.focus()); }}>Keep as is</button></div> : <button id={`access-active-${user.id}`} className="danger-button" type="button" disabled={saving} onClick={() => { setConfirmingActive(true); window.requestAnimationFrame(() => document.getElementById(`access-confirm-active-${user.id}`)?.focus()); }}>{user.active ? "Deactivate account" : "Reactivate account"}</button>}</div>
        <div className="access-edit-save">{saved && <span className="ui-status" data-tone={saved === "Saved" ? "success" : "neutral"} role="status">{saved}</span>}<button type="button" disabled={saving} onClick={() => closeEditor()}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
      </div>
    </form>;
  }
  function accountTable(rows: User[], label: string) {
    return <table className="access-table"><caption className="visually-hidden">{label}</caption><thead><tr><th scope="col">Name</th><th scope="col">Sign-in</th><th scope="col">Role</th><th scope="col">Modules</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead><tbody>{rows.map((user) => { const name = accountName(user); const open = editing === user.id; return <Fragment key={user.id}><tr className="settings-account" data-open={open}>
      <td data-label="Name"><strong className={user.memberId ? "" : "account-identifier"}>{name}</strong><small>{user.memberId ? user.memberExternalId : "Not on roster"}</small></td>
      <td data-label="Sign-in" className="account-identifier">{user.localUsername && <span>{user.localUsername} (local)</span>}{user.email && <span>{user.email.toLowerCase()}</span>}</td>
      <td data-label="Role"><span className="access-role-badge" data-role={user.role}>{roleLabel(user.role)}</span></td>
      <td data-label="Modules">{modulesCell(user)}</td>
      <td className="access-row-action"><button id={`access-edit-button-${user.id}`} className="access-edit-button" type="button" aria-label={`${open ? "Close" : "Edit"} ${name} access`} aria-expanded={open} aria-controls={open ? `access-edit-${user.id}` : undefined} onClick={() => openEditor(user)}>{open ? "Close" : "Edit"}</button></td>
    </tr>{open && <tr className="access-edit-row"><td colSpan={5}>{editPanel(user)}</td></tr>}</Fragment>; })}</tbody></table>;
  }

  return <section className="user-section" aria-labelledby="access-workspace-title">
    <div className="access-header"><div className="section-intro"><InfoHeading id="access-workspace-title" info="Grant Admin or Operator credentials to a roster member or an independent staff account. Only Admins can grant dashboard access or change roles.">Accounts and roles</InfoHeading><p className="access-count">{loading ? "Loading accounts…" : `${active.length} active ${active.length === 1 ? "account" : "accounts"}`}</p></div><button ref={grantButton} className={creating ? "" : "primary-button"} type="button" aria-expanded={creating} aria-controls="access-create-form" onClick={toggleCreate}>{creating ? "Cancel" : "Grant access"}</button></div>
    {notice && <p ref={statusLine} className="ui-status settings-notice" data-tone="success" role="status" tabIndex={-1}>{notice}</p>}
    {error && <p id="dashboard-access-error" className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}
    <div className="user-layout">{creating && <form id="access-create-form" className="task-card grant-access" autoComplete="off" aria-label="Grant dashboard access" onSubmit={create}>
      <label><span>Roster link <span>(optional)</span></span><select id="access-new-member" value={memberId} onChange={(event) => { const next = event.target.value; setMemberId(next); const member = members.find((item) => item.id === next); if (method === "google" && member?.email) setIdentifier(member.email.toLowerCase()); }}><option value="">Non-rostered Admin or Operator</option>{available.map((member) => <option key={member.id} value={member.id}>{member.firstName} {member.lastName} · {member.memberId}</option>)}</select></label>
      <fieldset className="method-switch"><legend>Sign-in method</legend><div className="method-switch-options"><label className={method === "local" ? "selected" : ""}><input type="radio" name="user-method" checked={method === "local"} onChange={() => setMethod("local")} /> <span>Local login</span></label><label className={method === "google" ? "selected" : ""}><input type="radio" name="user-method" checked={method === "google"} onChange={() => setMethod("google")} /> <span>Google email</span></label></div></fieldset>
      <label>{method === "local" ? "Username" : "Google email"}<input id="access-new-identifier" name="access-new-identifier" required type={method === "google" ? "email" : "text"} autoComplete="off" autoCapitalize="off" spellCheck={false} {...passwordManagerIgnore} value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></label>
      {method === "local" && <><label>Temporary password<input id="access-new-password" name="access-new-password" required type="password" minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>Confirm temporary password<input id="access-new-password-confirmation" name="access-new-password-confirmation" required type="password" minLength={12} autoComplete="new-password" value={confirmation} aria-invalid={confirmation !== "" && password !== confirmation} aria-describedby={confirmation !== "" && password !== confirmation ? "password-confirmation-error" : undefined} onChange={(event) => setConfirmation(event.target.value)} /></label>{confirmation && password !== confirmation && <p id="password-confirmation-error" className="inline-messages error" role="alert">Passwords do not match.</p>}</>}
      <label>Role<select value={role} onChange={(event) => setRole(event.target.value as User["role"])}><option value="operator">Operator</option><option value="admin">Admin</option></select></label><button className="primary-button" type="submit">Create access</button>
    </form>}<div className="user-list">{!loading && !users.length ? <p className="empty-state">No dashboard accounts yet.</p> : accountTable(active, "Active accounts")}{inactive.length > 0 && <details className="settings-disclosure access-inactive" open={inactiveOpen} onToggle={(event) => setInactiveOpen(event.currentTarget.open)}><summary>Inactive accounts ({inactive.length})</summary>{accountTable(inactive, "Inactive accounts")}</details>}</div></div>
  </section>;
}
