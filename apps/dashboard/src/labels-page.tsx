import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "./dashboard-api";
import { InfoHeading, InfoTip } from "./info-tip";
import { useModalFocus } from "./modal-focus";
import { AttendanceSettingsSections } from "./settings-section-navigation";
import { RouteLink, usePath } from "./router";
import type { LabelData } from "./member-labels";
import { sortDiscordRoles } from "./discord-roles";
import { DiscordLabelReconciliation, type ReconciliationConfirmInput, type ReconciliationPreview } from "./discord-label-reconciliation";

type LabelsData = LabelData & { rules?: { labelId: string }[]; meetingCounts?: Record<string, number> };
type SyncState = "never_synced" | "label_changes" | "no_label_changes";
type SyncDirection = "to_discord" | "two_way";
type Mapping = { labelId: string; labelName: string; roleId: string; roleName: string; health: string; healthDetail?: string; syncState?: SyncState; syncDirection?: SyncDirection; twoWayCheckedAt?: string | null; twoWayError?: string | null; twoWayPaused?: boolean; latestJob?: { id: string; status: string; updatedAt: string; completedAt?: string } };
type Role = { id: string; name: string; manageable: boolean; problem?: string; labelId?: string; labelName?: string };
type Person = { discordUserId: string; displayName: string; memberId?: string };
type Preview = { previewId: string; expiresAt: string; labelId: string; labelName?: string; roleName: string; memberCount: number; additions: Person[]; removals: Person[]; unpaired: { memberId: string; name: string }[]; absent: { memberId: string; name: string; discordUserId: string }[]; inactive: { memberId: string; name: string; discordUserId?: string }[] };
type Job = { id: string; labelId?: string; status: string; updatedAt: string; items: { discordUserId: string; action: "add" | "remove"; status: string; attempts: number; lastError?: string }[] };
const running = (job: Job) => ["pending", "running"].includes(job.status);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const healthText: Record<string, string> = { ready: "Ready to sync", retired: "Label is retired", integration_unavailable: "Discord is not enabled and verified", different_server: "Linked in a different Discord server", unavailable: "Cannot sync" };

/** Current holders of each label: the latest dated change on or before today is an addition. */
function holderCounts(data: LabelData) {
  const latest = new Map<string, LabelData["history"][number]>();
  for (const change of data.history) { if (change.effectiveDate > data.today) continue; const key = change.memberId + ":" + change.labelId; const prior = latest.get(key); if (!prior || prior.effectiveDate < change.effectiveDate || prior.effectiveDate === change.effectiveDate && prior.createdAt <= change.createdAt) latest.set(key, change); }
  const counts = new Map<string, number>(); for (const change of latest.values()) if (change.action === "add") counts.set(change.labelId, (counts.get(change.labelId) ?? 0) + 1);
  return counts;
}

/** Shown after label changes are applied when a changed label is linked to a Discord role. */
export function DiscordSyncReminder({ labels }: { labels: string[] }) {
  const { path, navigate } = usePath();
  if (!labels.length) return null;
  return <p className="ui-status" data-tone="warning" role="status">Discord roles for {labels.join(", ")} may now be out of date. <RouteLink href="/settings/labels" currentPath={path} navigate={navigate}>Review role sync</RouteLink></p>;
}

function RolePreview({ preview }: { preview: Preview }) {
  return <section className="discord-role-preview" aria-label={`Role changes for ${preview.labelName ?? preview.roleName}`}><h4>{preview.labelName ? `${preview.labelName} → ${preview.roleName}` : preview.roleName}</h4><p><strong>{plural(preview.additions.length, "addition")}</strong> and <strong>{plural(preview.removals.length, "removal")}</strong>. Unpaired Discord accounts holding this role appear in removals.</p>
    <h5>Add role</h5>{preview.additions.length ? <ul className="compact-list">{preview.additions.map((person) => <li key={person.discordUserId}>{person.displayName} · {person.memberId ?? person.discordUserId}</li>)}</ul> : <p>None</p>}
    <h5>Remove role</h5>{preview.removals.length ? <ul className="compact-list">{preview.removals.map((person) => <li key={person.discordUserId}>{person.displayName} · {person.discordUserId}</li>)}</ul> : <p>None</p>}
    <h5>Roster exceptions</h5><p>{preview.unpaired.length} labeled members are unpaired, {preview.absent.length} are absent from the server, and {preview.inactive.length} are inactive.</p>{preview.unpaired.length + preview.absent.length + preview.inactive.length > 0 && <ul className="compact-list">{preview.unpaired.map((person) => <li key={`unpaired-${person.memberId}`}>{person.name} ({person.memberId}) · unpaired</li>)}{preview.absent.map((person) => <li key={`absent-${person.memberId}`}>{person.name} ({person.memberId}) · not in server</li>)}{preview.inactive.map((person) => <li key={`inactive-${person.memberId}`}>{person.name} ({person.memberId}) · inactive</li>)}</ul>}
  </section>;
}

type SyncIconState = "synced" | "changed" | "syncing" | "failed" | "never" | "info";
/** Stroke icons for a label's Discord sync state; the info glyph explains an empty role cell. */
function SyncIcon({ state }: { state: SyncIconState }) {
  return <svg className="sync-icon" viewBox="0 0 24 24" aria-hidden="true">{state === "synced" ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></> : state === "failed" ? <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></> : state === "never" ? <circle cx="12" cy="12" r="9" strokeDasharray="3 3" /> : state === "info" ? <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></> : <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></>}</svg>;
}
const autoSyncText = "Two-way labels sync automatically every 5 minutes";
const twoWayPausedText = "Two-way sync paused after a restore. Review differences to turn it back on.";
const syncedAt = (mapping: Mapping) => mapping.latestJob ? ` Last synced ${new Date(mapping.latestJob.completedAt ?? mapping.latestJob.updatedAt).toLocaleString()}.` : "";
/** What a linked label's sync icon shows: a running job first, then the link's health, the last job's outcome and label changes since. */
function syncStatus(mapping: Mapping, job?: Job): { state: SyncIconState; text: string; detail: string } {
  if (job && running(job)) return { state: "syncing", text: "Syncing", detail: `${job.items.filter((item) => item.status === "completed").length} of ${plural(job.items.length, "change")} done.` };
  if (mapping.twoWayPaused) return { state: "changed", text: "Two-way, needs reconciliation", detail: `${twoWayPausedText}${mapping.health === "ready" ? "" : ` ${healthText[mapping.health] ?? "Cannot sync"}${mapping.healthDetail ? `: ${mapping.healthDetail}` : ""}.`}` };
  if (mapping.health !== "ready") return { state: "failed", text: healthText[mapping.health] ?? "Cannot sync", detail: mapping.healthDetail ? `${mapping.healthDetail}.` : "" };
  if (mapping.latestJob?.status === "partial") return { state: "failed", text: "Last sync failed for some members", detail: `Retry the failed changes, or open View last sync for details.${syncedAt(mapping)}` };
  if (mapping.syncDirection === "two_way") return mapping.twoWayError ? { state: "failed", text: "Two-way check failed", detail: `${mapping.twoWayError} It is retried every 5 minutes.` } : { state: "synced", text: "Two-way sync", detail: `Discord is checked every 5 minutes. Role changes in Discord change the label, and label changes reach Discord.${mapping.twoWayCheckedAt ? ` Last checked ${new Date(mapping.twoWayCheckedAt).toLocaleString()}.` : ""}` };
  if (mapping.latestJob?.status === "stale") return { state: "failed", text: "Last sync stopped", detail: "Roster labels or pairing changed during the sync. Sync again." };
  if (mapping.syncState === "never_synced") return { state: "never", text: "Never synced", detail: "Sync to Discord to give this role to the label's members." };
  if (mapping.syncState === "label_changes") return { state: "changed", text: "Label changes since last sync", detail: `Sync to Discord to update the role.${syncedAt(mapping)}` };
  return { state: "synced", text: "In sync", detail: `No label changes since the last sync. Pairing changes aren't tracked here.${syncedAt(mapping)}` };
}

type MenuItem = { label: string; onSelect: () => void; danger?: boolean };
/** A row's More menu. It is positioned against the viewport so the table's scroll container never clips it. */
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const rect = trigger.current!.getBoundingClientRect(); const height = list.current?.offsetHeight ?? 0; const below = rect.bottom + 4; setPosition({ top: below + height > window.innerHeight - 8 ? Math.max(8, rect.top - 4 - height) : below, right: document.documentElement.clientWidth - rect.right }); };
    place(); list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", close); window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  function key(event: KeyboardEvent) {
    if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const entries = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []); const index = entries.indexOf(document.activeElement as HTMLElement);
    event.preventDefault(); entries[(index + (event.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length]?.focus();
  }
  const choose = (item: MenuItem) => { setOpen(false); trigger.current?.focus(); item.onSelect(); };
  return <span className="row-menu" ref={root} onKeyDown={key}><button ref={trigger} className="ui-button" type="button" aria-label={`More actions for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>More <span aria-hidden="true">▾</span></button>
    {open && <span ref={list} className="row-menu-list" role="menu" aria-label={`Actions for ${label}`} style={{ top: position.top, right: position.right }}>{items.map((item) => <button key={item.label} type="button" role="menuitem" data-danger={item.danger || undefined} onClick={() => choose(item)}>{item.label}</button>)}</span>}</span>;
}

function LabelDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, false, onClose);
  return <div className="dialog-backdrop"><div className="member-dialog label-dialog" role="dialog" aria-modal="true" aria-labelledby="label-dialog-title" tabIndex={-1} ref={dialog}><div className="dialog-heading"><div><h2 id="label-dialog-title">{title}</h2></div><button type="button" aria-label={`Close ${title}`} onClick={onClose}>×</button></div>{children}</div></div>;
}

/** The latest sync job for one label, with its failed changes and, for Admins, a retry. */
function JobDialog({ labelName, job, admin, busy, onRetry, onClose }: { labelName: string; job: Job; admin: boolean; busy: boolean; onRetry: () => void; onClose: () => void }) {
  const count = (status: string) => job.items.filter((item) => item.status === status).length;
  return <LabelDialog title={`Last sync: ${labelName}`} onClose={onClose}><p><strong>Sync {job.status}</strong> · {count("completed")} completed, {count("pending")} pending, {count("failed")} failed. Updated {new Date(job.updatedAt).toLocaleString()}.</p>{count("failed") > 0 && <ul className="compact-list">{job.items.filter((item) => item.status === "failed").map((item) => <li key={item.discordUserId}>{item.action} {item.discordUserId}: {item.lastError}</li>)}</ul>}{job.status === "stale" && <p>Roster labels or pairing changed during sync. Review a fresh preview before continuing.</p>}<div className="dialog-actions"><button className="ui-button" type="button" onClick={onClose}>Close</button>{admin && job.status === "partial" && <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={onRetry}>Retry failed changes</button>}</div></LabelDialog>;
}

export function LabelsPage({ role }: { role: "admin" | "operator" }) {
  const admin = role === "admin";
  const { path, navigate } = usePath();
  const [data, setData] = useState<LabelsData>();
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [available, setAvailable] = useState(false);
  const [roles, setRoles] = useState<Role[]>();
  const [rolesError, setRolesError] = useState("");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [importIds, setImportIds] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Preview[]>();
  const [skipped, setSkipped] = useState<{ labelName: string; reason: string }[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [viewing, setViewing] = useState<{ job: Job; labelName: string }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reconciling, setReconciling] = useState<ReconciliationPreview>();
  const previewSection = useRef<HTMLElement>(null);
  const reconcileSection = useRef<HTMLDivElement>(null);
  async function load() {
    const [labels, discord] = await Promise.all([api<LabelsData>("/labels"), api<{ mappings: Mapping[]; integrationAvailable: boolean }>("/admin/integrations/discord/label-roles")]);
    setData(labels); setMappings(discord.mappings); setAvailable(discord.integrationAvailable);
    if (admin && discord.integrationAvailable) await api<{ roles: Role[] }>("/admin/integrations/discord/roles").then((result) => { setRoles(sortDiscordRoles(result.roles)); setRolesError(""); }).catch((error: Error) => { setRoles(undefined); setRolesError(error.message); });
  }
  useEffect(() => { void load().catch((error: Error) => setNotice(error.message)); }, []);
  useEffect(() => {
    if (!jobs.some(running)) return;
    const timer = window.setInterval(() => { void Promise.all(jobs.map((job) => running(job) ? api<Job>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(job.id)}${admin ? "/advance" : ""}`, admin ? { method: "POST", body: "{}" } : undefined).then((next) => ({ ...next, labelId: next.labelId ?? job.labelId })) : job)).then((next) => { setJobs(next.filter(running)); if (next.some((job) => !running(job))) void load(); }).catch((error: Error) => setNotice(error.message)); }, 4000);
    return () => window.clearInterval(timer);
  }, [jobs.map((job) => job.id + job.status).join(), admin]);
  // A preview opens below the table, so bring it into view from whichever row asked for it.
  useEffect(() => { if (previews) previewSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [previews]);
  useEffect(() => { if (reconciling) reconcileSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [reconciling?.previewId]);
  async function act(work: () => Promise<string | void>) { setBusy(true); setNotice(""); try { const message = await work(); if (message) setNotice(message); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } }
  const createLabel = (event: FormEvent) => { event.preventDefault(); void act(async () => { await api("/labels", { method: "POST", body: JSON.stringify({ name }) }); setName(""); await load(); return "Label created."; }); };
  const rename = (event: FormEvent) => { event.preventDefault(); if (!renaming) return; void act(async () => { await api("/labels/" + encodeURIComponent(renaming.id), { method: "PATCH", body: JSON.stringify({ name: renaming.name }) }); setRenaming(undefined); await load(); return "Label renamed. Linked Discord roles keep their own names."; }); };
  const setActive = (label: { id: string; name: string }, active: boolean) => { if (!active && !window.confirm(`Retire ${label.name}? It stops appearing when you assign labels or add attendance rules, and its Discord role can't be synced. Past attendance, label history and audit records stay. You can restore it later.`)) return; void act(async () => { await api("/labels/" + encodeURIComponent(label.id), { method: "PATCH", body: JSON.stringify({ active }) }); await load(); return active ? `${label.name} restored.` : `${label.name} retired. Historical attendance and audit records are preserved.`; }); };
  const link = (labelId: string, roleId: string) => void act(async () => { const result = await api<{ mapping: { labelName: string; roleName: string } }>("/admin/integrations/discord/label-roles", { method: "POST", body: JSON.stringify({ labelId, roleId }) }); await load(); return `Linked ${result.mapping.labelName} to ${result.mapping.roleName}. Nobody's roles change until you sync.`; });
  const unlink = (mapping: Mapping) => { if (!window.confirm(`Unlink ${mapping.labelName} from ${mapping.roleName}? Existing Discord role assignments will stay in place.`)) return; void act(async () => { await api(`/admin/integrations/discord/label-roles/${encodeURIComponent(mapping.labelId)}`, { method: "DELETE" }); setPreviews(undefined); await load(); return "Role unlinked. Existing Discord assignments were not changed."; }); };
  const importRoles = () => void act(async () => { const result = await api<{ linked: { created: boolean }[] }>("/admin/integrations/discord/label-roles/from-roles", { method: "POST", body: JSON.stringify({ roleIds: importIds }) }); setImportIds([]); await load(); const created = result.linked.filter((item) => item.created).length; return `${plural(created, "label")} created and ${result.linked.length} linked. Nobody's roles change until you sync.`; });
  const previewOne = (labelId: string) => void act(async () => { setSkipped([]); setPreviews([await api<Preview>("/admin/integrations/discord/label-roles/preview", { method: "POST", body: JSON.stringify({ labelId }) })]); });
  const previewAll = () => void act(async () => { const result = await api<{ previews: Preview[]; skipped: { labelName: string; reason: string }[] }>("/admin/integrations/discord/label-roles/preview-all", { method: "POST", body: "{}" }); setPreviews(result.previews); setSkipped(result.skipped); });
  const applyPreviews = () => { if (!previews) return; void act(async () => {
    const result = await api<{ jobs: { jobId: string; labelId: string }[]; failed: { error: string }[] }>("/admin/integrations/discord/label-roles/apply-all", { method: "POST", body: JSON.stringify({ previewIds: previews.map((preview) => preview.previewId) }) });
    setPreviews(undefined); setJobs((await Promise.all(result.jobs.map(async (job) => ({ ...await api<Job>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(job.jobId)}`), labelId: job.labelId })))).filter(running)); await load();
    return result.failed.length ? `${result.jobs.length} role syncs started. ${result.failed.length} need a fresh preview: ${result.failed.map((item) => item.error).join(" ")}` : "Discord role sync started. Each label's icon shows its progress.";
  }); };
  // Two-way sync starts only after the review card is confirmed; switching back needs no review.
  const changeDirection = (mapping: Mapping, direction: SyncDirection) => {
    if (direction === "two_way") return void act(async () => { setPreviews(undefined); setReconciling(await api<ReconciliationPreview>("/admin/integrations/discord/label-roles/two-way/preview", { method: "POST", body: JSON.stringify({ labelId: mapping.labelId }) })); });
    if (!window.confirm(mapping.twoWayPaused ? `Sync ${mapping.labelName} from the dashboard to Discord only? Two-way sync stays off, and Sync to Discord works again. Nobody's label or role changes now.` : `Sync ${mapping.labelName} from the dashboard to Discord only? Role changes made in Discord will no longer change the label. Nobody's label or role changes now.`)) return;
    void act(async () => { await api(`/admin/integrations/discord/label-roles/${encodeURIComponent(mapping.labelId)}/direction`, { method: "PUT", body: JSON.stringify({ direction: "to_discord" }) }); await load(); return `${mapping.labelName} now syncs from the dashboard to Discord.`; });
  };
  const confirmTwoWay = async (input: ReconciliationConfirmInput) => {
    const result = await api<{ jobId?: string; labelId: string }>("/admin/integrations/discord/label-roles/two-way/confirm", { method: "POST", body: JSON.stringify(input) });
    if (result.jobId) { const job = { ...await api<Job>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(result.jobId)}`), labelId: result.labelId }; if (running(job)) setJobs((old) => [...old.filter((item) => item.labelId !== result.labelId), job]); }
    await load();
  };
  const showJob = (id: string, labelId: string, labelName: string) => void act(async () => { setViewing({ job: { ...await api<Job>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(id)}`), labelId }, labelName }); });
  const retry = (id: string, labelId: string) => { if (!window.confirm("Retry only failed role changes that are still needed?")) return; void act(async () => { const result = await api<{ jobId?: string; retried: number }>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }); const next = result.jobId ? { ...await api<Job>(`/admin/integrations/discord/label-role-jobs/${encodeURIComponent(result.jobId)}`), labelId } : undefined; setViewing(undefined); setJobs((old) => [...old.filter((job) => job.labelId !== labelId), ...(next && running(next) ? [next] : [])]); await load(); return result.retried ? `Retrying ${result.retried} role changes.` : "No failed changes are still needed."; }); };

  const counts = data ? holderCounts(data) : new Map<string, number>();
  const active = data?.labels.filter((label) => label.active) ?? [];
  const retired = data?.labels.filter((label) => !label.active) ?? [];
  const mappingFor = (labelId: string) => mappings.find((mapping) => mapping.labelId === labelId);
  const linkable = roles?.filter((item) => !item.labelId) ?? [];
  const importable = linkable.filter((item) => item.manageable);
  const noLinkableReason = roles ? [roles.length - linkable.length ? `${plural(roles.length - linkable.length, "role")} already linked` : "", linkable.length ? `${plural(linkable.length, "role")} the bot can't manage` : ""].filter(Boolean).join(" · ") || "The server has no other roles" : "";
  const syncable = mappings.filter((mapping) => mapping.health === "ready" && mapping.syncDirection !== "two_way" && !mapping.twoWayPaused);
  const paused = mappings.filter((mapping) => mapping.twoWayPaused);
  return <section className="settings-page settings-labels" aria-labelledby="labels-title"><div className="page-intro"><h1 id="labels-title">Labels</h1><p>{admin ? "Create member labels, link them to Discord roles, and keep those roles in sync. Assign labels to members in Roster." : "View member labels, their Discord roles, and role sync status."}</p></div><AttendanceSettingsSections role={role} />
    {notice && <p className="ui-status settings-notice" role="status">{notice}</p>}
    <section className="task-card ui-card member-labels-panel" aria-labelledby="labels-list-title"><InfoHeading id="labels-list-title" info="Members can hold several labels. Labels decide attendance requirements, meeting audiences, report filters and Discord roles.">Member labels</InfoHeading>
      {admin && <form className="form-grid" onSubmit={createLabel}><label>New label name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="ui-button ui-button--primary" type="submit" disabled={busy}>Create label</button></form>}
      {!data ? <p className="ui-status" role="status">Loading labels…</p> : active.length ? <div className="table-scroll"><table className="data-table labels-table"><thead><tr><th scope="col">Label</th><th scope="col">Members</th><th scope="col">Attendance rule</th><th scope="col">Meetings</th><th scope="col">Discord role</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead><tbody>{active.map((label) => {
        const mapping = mappingFor(label.id); const holders = counts.get(label.id) ?? 0; const meetings = data.meetingCounts?.[label.id] ?? 0;
        const job = jobs.find((item) => item.labelId === label.id); const status = mapping && syncStatus(mapping, job);
        const twoWay = mapping?.syncDirection === "two_way"; const pausedTwoWay = Boolean(mapping?.twoWayPaused);
        const primary = !admin || !mapping || !status ? undefined : status.state === "syncing" ? <button className="ui-button label-primary-action" type="button" disabled>Syncing…</button> : mapping.latestJob?.status === "partial" && mapping.health === "ready" ? <button className="ui-button label-primary-action" type="button" disabled={busy} onClick={() => retry(mapping.latestJob!.id, label.id)}>Retry failed</button> : pausedTwoWay ? <button className="ui-button label-primary-action" type="button" disabled={busy || mapping.health !== "ready"} onClick={() => changeDirection(mapping, "two_way")}>Review differences</button> : twoWay ? <><span className="label-auto-sync" role="note" title={autoSyncText} aria-describedby={`label-auto-sync-${label.id}`}><SyncIcon state="syncing" /><span>Every 5 min</span></span><span id={`label-auto-sync-${label.id}`} hidden>{autoSyncText}</span></> : <button className="ui-button label-primary-action" type="button" disabled={busy || mapping.health !== "ready"} onClick={() => previewOne(label.id)}>Sync to Discord</button>;
        const menu: MenuItem[] = [...(admin ? [{ label: "Rename", onSelect: () => setRenaming({ id: label.id, name: label.name }) }] : []), ...(mapping?.latestJob ? [{ label: "View last sync", onSelect: () => showJob(mapping.latestJob!.id, label.id, label.name) }] : []), ...(admin && mapping ? [{ label: "Unlink role", danger: true, onSelect: () => unlink(mapping) }] : []), ...(admin ? [{ label: "Retire label", danger: true, onSelect: () => setActive(label, false) }] : [])];
        return <tr key={label.id}>
          <th scope="row">{label.name}</th>
          <td data-label="Members"><RouteLink href={`/roster?label=${encodeURIComponent(label.id)}&scope=all`} currentPath={path} navigate={navigate}>{plural(holders, "member")}</RouteLink></td>
          <td data-label="Attendance rule">{data.rules?.some((rule) => rule.labelId === label.id) ? <RouteLink href="/settings/attendance" currentPath={path} navigate={navigate}>Has a rule</RouteLink> : "None"}</td>
          <td data-label="Meetings">{plural(meetings, "meeting")}</td>
          <td data-label="Discord role">{mapping && status ? <div className="label-discord-role"><InfoTip label={`Sync status for ${label.name}: ${status.text}`} glyph={<SyncIcon state={status.state} />} tone={status.state}>{status.text}. {status.detail}</InfoTip><strong>{mapping.roleName}</strong><span className="label-sync-text">{status.text}</span>{admin && (mapping.health === "ready" || twoWay || pausedTwoWay) && <select className="label-sync-direction" aria-label={`Sync direction for ${label.name}`} value={pausedTwoWay ? "paused" : mapping.syncDirection ?? "to_discord"} disabled={busy || status.state === "syncing"} onChange={(event) => changeDirection(mapping, event.target.value as SyncDirection)}><option value="to_discord">Dashboard to Discord</option>{pausedTwoWay && <option value="paused" disabled>Two-way, needs reconciliation</option>}<option value="two_way">{pausedTwoWay ? "Two-way (review differences)" : "Two-way"}</option></select>}{primary && <span className="label-role-action">{primary}</span>}</div>
            : admin && roles && !importable.length ? <div className="label-discord-role" data-muted="true"><InfoTip label="Why no roles can be linked" glyph={<SyncIcon state="info" />}>{noLinkableReason}.</InfoTip><span>No roles left to link</span></div>
            : admin && roles ? <select className="label-role-select" aria-label={`Discord role for ${label.name}`} value="" disabled={busy} onChange={(event) => { if (event.target.value) link(label.id, event.target.value); }}><option value="">Link a Discord role…</option>{linkable.map((item) => <option key={item.id} value={item.id} disabled={!item.manageable}>{item.manageable ? item.name : `${item.name} (${item.problem})`}</option>)}</select> : <span className="label-discord-role" data-muted="true">Not linked</span>}</td>
          <td className="label-actions"><div className="label-row-actions">{menu.length > 0 ? <RowMenu label={label.name} items={menu} /> : <span className="label-menu-slot" aria-hidden="true" />}</div></td>
        </tr>;
      })}</tbody></table></div> : <p>No labels are configured.</p>}
      {retired.length > 0 && <details className="settings-disclosure"><summary>Retired labels ({retired.length})</summary><ul className="compact-list label-period-list">{retired.map((label) => <li key={label.id}><span>{label.name}</span>{admin && <button className="ui-button" type="button" disabled={busy} onClick={() => setActive(label, true)}>Restore</button>}</li>)}</ul></details>}
    </section>
    <section className="task-card ui-card member-labels-panel" aria-labelledby="discord-label-role-title"><InfoHeading id="discord-label-role-title" info={<>{admin ? "Link a label to a Discord role here, or with " : "Admins link labels to Discord roles here, or with "}<code>/label @ROLE</code> in Discord. Linking alone changes nobody's roles. Sync to Discord previews every change first, and removes the role from anyone in the server who doesn't hold the label. A Two-way label is checked every 5 minutes instead: a role added or removed in Discord changes the label, and label changes reach Discord.</>}>Discord roles</InfoHeading>
      {!available ? <p className="ui-status" data-tone="warning">Enable and verify Discord in Settings → Integrations to link, preview or sync roles.</p> : <>
        {admin && rolesError && <p className="ui-status" data-tone="warning" role="status">Discord roles could not be loaded: {rolesError}</p>}
        <p>{mappings.length ? `${mappings.length} ${mappings.length === 1 ? "label is" : "labels are"} linked to Discord roles. Label and pairing changes reach Discord only when you sync.` : "No labels are linked to Discord roles. Choose a role in the Discord role column above."}</p>
        {paused.map((mapping) => <div className="ui-status label-two-way-paused" data-tone="warning" role="status" key={mapping.labelId}><p><strong>{mapping.labelName}:</strong> {twoWayPausedText}{admin ? "" : " Ask an Admin to review it."}</p>{admin && <div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => changeDirection(mapping, "to_discord")}>Switch to Dashboard to Discord</button><button className="ui-button ui-button--primary" type="button" disabled={busy || mapping.health !== "ready"} onClick={() => changeDirection(mapping, "two_way")}>{`Review differences for ${mapping.labelName}`}</button></div>}</div>)}
        {admin && <div className="dialog-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy || !syncable.length} onClick={previewAll}>Sync all linked roles</button></div>}
        {admin && importable.length > 0 && <details className="settings-disclosure"><summary>Create labels from Discord roles</summary><p>Creates a label named after each role and links them. An existing unlinked label with the same name is linked instead.</p><div className="quick-label-options">{importable.map((item) => <label className="checkbox-field" key={item.id}><input type="checkbox" checked={importIds.includes(item.id)} onChange={(event) => setImportIds((old) => event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} />{item.name}</label>)}</div><button className="ui-button ui-button--primary" type="button" disabled={busy || !importIds.length} onClick={importRoles}>{`Create and link ${plural(importIds.length, "label")}`}</button></details>}
      </>}
      {previews && <section ref={previewSection} className="discord-role-preview-set" aria-labelledby="discord-role-preview-title"><h3 id="discord-role-preview-title">Review Discord role changes</h3>{previews[0] && <p>Discord returned {previews[0].memberCount} server members. This preview expires at {new Date(previews[0].expiresAt).toLocaleTimeString()}.</p>}{skipped.length > 0 && <ul className="compact-list">{skipped.map((item) => <li key={item.labelName}>{item.labelName}: skipped. {item.reason}</li>)}</ul>}{previews.map((preview) => <RolePreview key={preview.previewId} preview={preview} />)}
        <div className="dialog-actions"><button className="ui-button" type="button" onClick={() => setPreviews(undefined)}>Cancel</button><button className="ui-button ui-button--primary" type="button" disabled={busy || !previews.length} onClick={applyPreviews}>{previews.length === 1 ? "Confirm full-server sync" : `Confirm ${previews.length} full-server syncs`}</button></div></section>}
    </section>
    {reconciling && <div ref={reconcileSection}><DiscordLabelReconciliation key={reconciling.previewId} preview={reconciling} busy={busy} onConfirm={confirmTwoWay} onCancel={() => setReconciling(undefined)} /></div>}
    {renaming && <LabelDialog title="Rename label" onClose={() => setRenaming(undefined)}><form className="form-grid" onSubmit={rename}><label>Label name<input required maxLength={80} value={renaming.name} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} autoFocus /></label><p className="field-help">Linked Discord roles keep their own names.</p><div className="dialog-actions"><button className="ui-button" type="button" onClick={() => setRenaming(undefined)}>Cancel</button><button className="ui-button ui-button--primary" type="submit" disabled={busy}>Save name</button></div></form></LabelDialog>}
    {viewing && <JobDialog labelName={viewing.labelName} job={viewing.job} admin={admin} busy={busy} onRetry={() => retry(viewing.job.id, viewing.job.labelId!)} onClose={() => setViewing(undefined)} />}
  </section>;
}
