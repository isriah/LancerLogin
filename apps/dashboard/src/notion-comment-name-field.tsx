import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import "./notion-integration-settings.css";

type CommentName = { moduleId: string; label: string; name: string };

/**
 * The name Notion shows on a module's comments, for an Admin-only module settings page. Core stores the name and puts
 * it on every comment the module posts through `services.notion`; left blank, comments carry the module's label. The
 * module must declare `comments.create` on one of its Notion databases. The plugin only places this card.
 */
export function NotionCommentNameField({ moduleId }: { moduleId: string }) {
  const id = useId();
  const [stored, setStored] = useState<CommentName>(); const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false); const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const path = `/admin/modules/${encodeURIComponent(moduleId)}/notion-comment-name`;
  useEffect(() => {
    let current = true;
    void api<CommentName>(path).then((result) => { if (current) { setStored(result); setValue(result.name); } }).catch((error: Error) => { if (current) setNotice({ tone: "error", text: error.message }); });
    return () => { current = false; };
  }, [path]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!stored || saving) return; setSaving(true); setNotice(undefined);
    try {
      const result = await api<CommentName>(path, { method: "PUT", body: JSON.stringify({ name: value.trim() }) });
      setStored(result); setValue(result.name);
      setNotice({ tone: "success", text: result.name ? `Comments in Notion now show ${result.name}.` : `Comments in Notion now show ${result.label}.` });
    }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  }
  return <article className="ui-card notion-binding-card" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Notion comments</h2>
    {!stored ? !notice && <p className="ui-status" role="status">Loading the name shown on comments…</p> : <form className="ui-form notion-binding" onSubmit={(event) => void save(event)}>
      <div className="notion-binding-fields"><label htmlFor={`${id}-name`}>Name shown on comments<input id={`${id}-name`} className="ui-control" type="text" autoComplete="off" maxLength={100} placeholder={stored.label} aria-describedby={`${id}-hint`} disabled={saving} value={value} onChange={(event) => { setValue(event.target.value); setNotice(undefined); }} /></label></div>
      <p id={`${id}-hint`} className="notion-note">Leave blank to use the module's name.</p>
      <div className="notion-actions"><button className="ui-button ui-button--primary" type="submit" disabled={saving || value.trim() === stored.name}>{saving ? "Saving…" : "Save"}</button></div>
    </form>}
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
  </article>;
}
