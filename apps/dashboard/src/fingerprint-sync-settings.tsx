import { InfoTip } from "./info-tip";
import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { FingerprintVaultSettings } from "./fingerprint-vault-settings";

export function FingerprintSyncSettings() {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  async function load() {
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const result = await api<{ enabled: boolean }>("/admin/kiosks/fingerprint-sync");
      if (typeof result.enabled !== "boolean") throw new Error("Fingerprint sync settings are unavailable.");
      setEnabled(result.enabled);
    } catch (error) { setEnabled(undefined); setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function toggle() {
    if (enabled === undefined || busy) return;
    const next = !enabled;
    if (!window.confirm(next
      ? "Allow encrypted fingerprint template transfers between locally approved kiosks? Confirm your organization has permission to share these biometric templates. You must also enable sync and approve peers on each physical kiosk."
      : "Stop fingerprint transfers? Pending relay data and registrations will be cleared. Fingerprints already stored on readers will remain.")) return;
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const result = await api<{ enabled: boolean }>("/admin/kiosks/fingerprint-sync", { method: "PATCH", body: JSON.stringify({ enabled: next }) });
      if (result.enabled !== next) throw new Error("The sync setting was not confirmed. Refresh before trying again.");
      setEnabled(result.enabled);
      setNotice(next ? "Installation sync enabled. Enable sync and compare device fingerprints in each kiosk's PIN-protected maintenance screen." : "Fingerprint sync disabled. Existing reader fingerprints are unchanged.");
    } catch (error) { setEnabled(undefined); setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  return <><article className="ui-card ui-form fingerprint-settings-card" aria-labelledby="fingerprint-sync-title">
    <div className="fingerprint-control-heading"><h3 id="fingerprint-sync-title">Peer sync</h3><InfoTip label="About peer sync">Encrypted transfers between locally approved kiosks. Approve peers on each physical kiosk using its settings PIN. Turning sync off leaves existing reader copies. Cloud storage is configured separately.</InfoTip></div>
    <p role="status">Installation sync: {enabled === undefined ? "Unavailable" : enabled ? "On" : "Off"}</p>
    <div className="kiosk-actions">
      <button className="ui-button ui-button--primary" type="button" disabled={busy || enabled === undefined} onClick={() => void toggle()}>{busy ? "Please wait…" : enabled ? "Disable sync" : "Enable sync"}</button>
      <button className="ui-button" type="button" disabled={busy} aria-label="Refresh sync settings" title="Refresh sync settings" onClick={() => void load()}>↻</button>
    </div>
    {notice && <p className="ui-status" data-tone={failed ? "error" : "success"} role={failed ? "alert" : "status"}>{notice}</p>}
  </article><FingerprintVaultSettings /></>;
}
