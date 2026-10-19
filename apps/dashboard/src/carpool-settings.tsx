import { useEffect, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import { usePath } from "./router";
import { SettingsSectionNavigation, settingsSectionHref } from "./settings-section-navigation";

type Settings = { radiusMiles: number; preferredRadiusMiles: number; revision: number; geocodingConfigured: boolean; canSaveApiKey: boolean };

export function CarpoolSettings() {
  const { path, search, navigate } = usePath();
  const section = new URLSearchParams(search).get("section") === "location" ? "location" : "defaults";
  const [saved, setSaved] = useState<Settings>();
  const [maximum, setMaximum] = useState("12"); const [preferred, setPreferred] = useState("4");
  const [apiKey, setApiKey] = useState(""); const [removeApiKey, setRemoveApiKey] = useState(false);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  useEffect(() => { void api<Settings>("/admin/carpool/settings").then(value => { setSaved(value); setMaximum(String(value.radiusMiles)); setPreferred(String(value.preferredRadiusMiles)); }).catch((error: Error) => setNotice({ error: true, text: error.message })); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!saved) return; setBusy(true); setNotice(undefined);
    try {
      const value = await api<Settings>("/admin/carpool/settings", { method: "PUT", body: JSON.stringify({ radiusMiles: section === "defaults" ? Number(maximum) : saved.radiusMiles, preferredRadiusMiles: section === "defaults" ? Number(preferred) : saved.preferredRadiusMiles, revision: saved.revision, ...(section === "location" ? removeApiKey ? { removeApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {} : {}) }) });
      setSaved(value); if (section === "location") { setApiKey(""); setRemoveApiKey(false); } setNotice({ error: false, text: "Carpool settings saved." });
    } catch (error) { setNotice({ error: true, text: (error as Error).message }); } finally { setBusy(false); }
  }
  return <section className="settings-page outreach-stack" aria-labelledby="carpool-settings-title">
    <div className="page-intro"><h1 id="carpool-settings-title">Carpool</h1><p>Configure location lookup and the starting distances for new Carpool plans.</p></div>
    <SettingsSectionNavigation label="Carpool settings sections" currentHref={settingsSectionHref(path, search, section)} navigate={navigate} sections={[[settingsSectionHref(path, search, "defaults"), "Plan defaults"], [settingsSectionHref(path, search, "location"), "Location lookup"]]} />
    {notice && <p className="ui-status settings-notice" data-tone={notice.error ? "error" : "success"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {!saved && !notice && <p className="ui-status" role="status">Loading Carpool settings...</p>}
    <form className="ui-form outreach-stack" onSubmit={event => void save(event)}>
      {section === "defaults" ? <section className="ui-card outreach-stack" aria-labelledby="carpool-defaults-title"><h2 id="carpool-defaults-title">Plan defaults</h2><p>New plans start with these distances. Staff can change either distance within an individual plan.</p>
        <div className="form-grid"><label>Default preferred radius (miles)<input className="ui-control" required type="number" min="0.5" max={maximum} step="0.5" disabled={busy || !saved} value={preferred} onChange={event => setPreferred(event.target.value)} /></label>
        <label>Default maximum radius (miles)<input className="ui-control" required type="number" min="0.5" max="250" step="0.5" disabled={busy || !saved} value={maximum} onChange={event => setMaximum(event.target.value)} /></label></div>
      </section> : <section className="ui-card outreach-stack" aria-labelledby="carpool-lookup-title"><h2 id="carpool-lookup-title">Location lookup</h2><p>Geoapify resolves participant addresses. Manual coordinates remain available without an API key.</p>
        <p className="ui-status" role="status">{saved?.geocodingConfigured ? "Location lookup is configured." : "No location lookup API key is configured."}</p>
        <label>Geoapify API key<input className="ui-control" type="password" autoComplete="new-password" maxLength={1000} disabled={busy || !saved?.canSaveApiKey || removeApiKey} value={apiKey} onChange={event => setApiKey(event.target.value)} aria-describedby="carpool-key-help" /></label>
        <p id="carpool-key-help">The key is stored encrypted. Leave this field blank to keep the current key.</p>
        {saved && !saved.canSaveApiKey && <p className="ui-status" data-tone="warning">Credential encryption must be configured before saving an API key.</p>}
        {saved?.geocodingConfigured && <label className="checkbox-field"><input className="ui-checkbox" type="checkbox" disabled={busy} checked={removeApiKey} onChange={event => { setRemoveApiKey(event.target.checked); setApiKey(""); }} /> Remove the current API key and use manual coordinates</label>}
      </section>}
      <div className="module-actions"><button className="ui-button ui-button--primary" disabled={busy || !saved} type="submit">{busy ? "Saving..." : "Save Carpool settings"}</button></div>
    </form>
  </section>;
}
