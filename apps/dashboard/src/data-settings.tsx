import { useRef, useState } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";

type Scope = "meetings" | "roster" | "installation";
type Dialog = { action: "restore" | "delete"; scope: Scope };

const details: Record<Scope, { title: string; backup: string; restore: string; deletion: string; confirmation: string }> = {
  meetings: { title: "Meetings and attendance", backup: "Meetings, check-ins, corrections, excuses, and attendance contests.", restore: "Replaces only meetings and attendance. Existing roster member IDs must match the backup.", deletion: "Deletes meetings and attendance while keeping roster, accounts, settings, integrations, and audit history.", confirmation: "DELETE ATTENDANCE" },
  roster: { title: "Roster", backup: "Roster identities, contact fields, Discord links, and active status. Dashboard credentials remain separate.", restore: "Restores the active roster state. Current historical members missing from the backup are retained as inactive when referenced.", deletion: "Deletes roster only. If attendance still references members, delete meetings and attendance first. Linked dashboard accounts become non-rostered.", confirmation: "DELETE ROSTER" },
  installation: { title: "Entire installation", backup: "All D1 state, including password hashes, encrypted integrations, kiosk credential hashes, settings, and audit history.", restore: "Replaces the entire D1 installation. It works only while the installation encryption secrets remain unchanged.", deletion: "Deletes the entire installation and returns to first-Admin setup.", confirmation: "DELETE INSTALLATION" },
};

async function errorMessage(result: Response) { const body = await result.json() as { error?: string; details?: string[] }; return body.details?.join(" ") ?? body.error ?? "Request failed"; }

export function DataSettings() {
  const [notice, setNotice] = useState("Choose a category to download a backup, restore a backup, or delete its data."); const [busy, setBusy] = useState<string>(); const [dialog, setDialog] = useState<Dialog>(); const [file, setFile] = useState<File>(); const [confirmation, setConfirmation] = useState(""); const [error, setError] = useState("");
  function open(action: Dialog["action"], scope: Scope) { setDialog({ action, scope }); setFile(undefined); setConfirmation(""); setError(""); }
  function close() { if (!busy) setDialog(undefined); }
  async function backup(scope: Scope) {
    setBusy(`backup-${scope}`);
    try { const result = await fetch(`${apiBaseUrl}/admin/data/backup?scope=${scope}`, { credentials: "include" }); if (!result.ok) throw new Error(await errorMessage(result)); const blob = await result.blob(); const name = result.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `lancerlogin-${scope}-backup.json`; const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); setNotice(`${details[scope].title} backup downloaded. Store it securely.`); } catch (caught) { setNotice((caught as Error).message); } finally { setBusy(undefined); }
  }
  async function restore(scope: Scope) {
    if (!file) { setError("Choose a backup file to validate before restoring."); return; }
    if (file.size > 10_485_760) { setError("Dashboard restore supports files up to 10 MiB; use the documented D1 workflow for larger backups."); return; }
    const expected = `RESTORE ${scope.toUpperCase()}`;
    if (confirmation.trim() !== expected) { setError(`Type ${expected} exactly to continue.`); return; }
    setError(""); setBusy(`restore-${scope}`);
    try { const backupDocument = JSON.parse(await file.text()) as unknown; const result = await fetch(`${apiBaseUrl}/admin/data/restore`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, confirmation, backup: backupDocument }) }); if (!result.ok) throw new Error(await errorMessage(result)); setNotice(`${details[scope].title} restored successfully.`); setDialog(undefined); if (scope === "installation") window.location.reload(); } catch (caught) { setError(caught instanceof SyntaxError ? "The selected backup is not valid JSON." : (caught as Error).message); } finally { setBusy(undefined); }
  }
  async function remove(scope: Scope) {
    const expected = details[scope].confirmation;
    if (confirmation.trim() !== expected) { setError(`Type ${expected} exactly to continue.`); return; }
    setError(""); setBusy(`delete-${scope}`);
    try { const result = await fetch(`${apiBaseUrl}/admin/data`, { method: "DELETE", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: scope === "meetings" ? "attendance" : scope, confirmation }) }); if (!result.ok) throw new Error(await errorMessage(result)); setNotice(`${details[scope].title} deleted.`); setDialog(undefined); if (scope === "installation") window.location.reload(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(undefined); }
  }
  return <section className="settings-page" aria-labelledby="data-title"><div className="page-intro"><p className="kicker">Settings</p><h2 id="data-title">Data management</h2></div><p className="setup-status" role="status">{notice}</p><div className="data-category-list">{(["meetings", "roster", "installation"] as const).map((scope) => <article className={scope === "installation" ? "data-category sensitive" : "data-category"} key={scope}><div><h3>{details[scope].title}</h3><p>{details[scope].backup}</p>{scope === "installation" && <strong className="sensitive-note">Sensitive backup: protect it like an administrator credential.</strong>}</div><div className="data-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void backup(scope)}>{busy === `backup-${scope}` ? "Preparing…" : "Download backup"}</button><button type="button" disabled={Boolean(busy)} onClick={() => open("restore", scope)}>Restore file</button><button className="danger-button" type="button" disabled={Boolean(busy)} onClick={() => open("delete", scope)}>Delete</button></div></article>)}</div>{dialog && <DataActionDialog dialog={dialog} file={file} confirmation={confirmation} error={error} busy={Boolean(busy)} onClose={close} onFile={setFile} onConfirmation={setConfirmation} onRestore={() => void restore(dialog.scope)} onDelete={() => void remove(dialog.scope)} />}</section>;
}

function DataActionDialog({ dialog, file, confirmation, error, busy, onClose, onFile, onConfirmation, onRestore, onDelete }: { dialog: Dialog; file?: File; confirmation: string; error: string; busy: boolean; onClose: () => void; onFile: (file?: File) => void; onConfirmation: (value: string) => void; onRestore: () => void; onDelete: () => void }) {
  const modal = useRef<HTMLElement>(null); const detail = details[dialog.scope]; const restoring = dialog.action === "restore"; const typedConfirmation = restoring ? `RESTORE ${dialog.scope.toUpperCase()}` : detail.confirmation;
  useModalFocus(modal, true, busy, onClose);
  return <div className="dialog-backdrop"><section className="data-action-dialog" role="dialog" aria-modal="true" aria-labelledby="data-action-title" tabIndex={-1} ref={modal}><div className="dialog-heading"><div><h2 id="data-action-title">{restoring ? `Restore ${detail.title}` : `Delete ${detail.title}`}</h2><p>{restoring ? detail.restore : detail.deletion}</p></div><button type="button" aria-label="Close data action dialog" disabled={busy} onClick={onClose}>×</button></div>{restoring ? <label className="file-picker">Backup file<input type="file" accept="application/json,.json" onChange={(event) => { onFile(event.target.files?.[0]); }} /><span>{file ? file.name : "Choose a JSON backup file"}</span></label> : <p className="warning-callout" role="alert">This action permanently deletes the selected category. Review the scope and download a backup first if you may need it.</p>}<label>Type <code>{typedConfirmation}</code> to confirm<input autoComplete="off" value={confirmation} onChange={(event) => onConfirmation(event.target.value)} aria-describedby={error ? "data-action-error" : undefined} /></label>{error && <p id="data-action-error" className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className={restoring ? "primary-button" : "danger-button"} type="button" disabled={busy || (restoring && !file)} onClick={restoring ? onRestore : onDelete}>{busy ? (restoring ? "Restoring…" : "Deleting…") : (restoring ? "Validate and restore" : `Delete ${detail.title.toLowerCase()}`)}</button></div></section></div>;
}
