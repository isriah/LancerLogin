import { FormEvent, useState } from "react";
import { api } from "./dashboard-api";
import type { Branding } from "./setup-workspace";

export function ConfigurationSettings({ initialBranding, onChanged }: { initialBranding: Branding; onChanged: (branding: Branding) => void }) {
  const [lateScanMinutes, setLateScanMinutes] = useState(String(initialBranding.lateScanMinutes));
  const [discordContestWindowHours, setDiscordContestWindowHours] = useState(String(initialBranding.discordContestWindowHours));
  const [notice, setNotice] = useState("Changes apply to every meeting after you save them."); const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); const next = { ...initialBranding, lateScanMinutes: lateScanMinutes.trim() === "" ? 0 : Number(lateScanMinutes), discordContestWindowHours: discordContestWindowHours.trim() === "" ? 24 : Number(discordContestWindowHours) };
    setSaving(true); try { await api("/admin/branding", { method: "PATCH", body: JSON.stringify(next) }); onChanged(next); setLateScanMinutes(String(next.lateScanMinutes)); setDiscordContestWindowHours(String(next.discordContestWindowHours)); setNotice("Attendance configuration saved."); } catch (error) { setNotice((error as Error).message); } finally { setSaving(false); }
  }
  return <section className="settings-page" aria-labelledby="configuration-title"><div className="page-intro"><h1 id="configuration-title">Configuration</h1></div><p className="setup-status" role="status">{notice}</p><form className="settings-form configuration-form" onSubmit={save}><div className="configuration-grid"><label>Late scan allowance (minutes)<input type="number" min={0} max={180} step={1} value={lateScanMinutes} placeholder="0" onChange={(event) => setLateScanMinutes(event.target.value)} /><span className="field-help">Scans close this many minutes after every meeting’s required end time.</span></label><label>Discord contest window (hours)<input type="number" min={1} max={168} step={1} value={discordContestWindowHours} placeholder="24" onChange={(event) => setDiscordContestWindowHours(event.target.value)} /><span className="field-help">An absence notice accepts contests for this many hours after delivery.</span></label></div><button className="primary-button" disabled={saving} type="submit">{saving ? "Saving…" : "Save configuration"}</button></form></section>;
}
