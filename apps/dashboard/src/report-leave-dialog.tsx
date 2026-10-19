import { useRef, useState } from "react";
import { useModalFocus } from "./modal-focus";

export type ReportSaveResult = { ok: boolean; error?: string };
export type ReportEditorHandle = { save: () => Promise<ReportSaveResult> };

export function ReportLeaveDialog({ onSave, onLeave, onCancel }: {
  onSave: () => Promise<ReportSaveResult>;
  onLeave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [operation, setOperation] = useState<"saving" | "discarding">();
  const busy = operation !== undefined;
  const [error, setError] = useState("");
  useModalFocus(dialog, true, busy, onCancel);
  async function leave(save: boolean) {
    if (pending.current) return;
    pending.current = true; setOperation(save ? "saving" : "discarding"); setError("");
    try {
      if (save) {
        const result = await onSave();
        if (!result.ok) { setError(result.error ?? "The report could not be saved. Your changes are still here."); return; }
      }
      await onLeave();
    } catch (cause) { setError((cause as Error).message); }
    finally { pending.current = false; setOperation(undefined); }
  }
  return <div className="dialog-backdrop"><section ref={dialog} className="ui-dialog report-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="report-leave-title" aria-describedby="report-leave-help" aria-busy={busy} tabIndex={-1}>
    <h2 id="report-leave-title">Save changes before leaving?</h2>
    <p id="report-leave-help">Save this report, discard unsaved changes, or cancel to keep working.</p>
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="ui-button" type="button" disabled={busy} data-modal-initial-focus onClick={onCancel}>Cancel</button>
      <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void leave(false)}>Discard changes</button>
      <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void leave(true)}>{operation === "saving" ? "Saving…" : "Save"}</button>
    </div>
  </section></div>;
}
