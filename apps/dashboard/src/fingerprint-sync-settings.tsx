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
  return <><article className="task-card ui-form fingerprint-settings-card" aria-labelledby="fingerprint-sync-title">
    <h2 id="fingerprint-sync-title">Fingerprint sync</h2>
    <p>Optional, off by default. Newly enrolled fingerprints can sync across networks between approved kiosks. These peer transfers are encrypted for the destination kiosk; the peer relay cannot decrypt them. Cloud storage below is a separate option with server-managed keys.</p>
    <p>Enable and approve each peer using the physical kiosk's local settings PIN. Existing unidentified fingerprints are not automatically exported. Turning sync off does not erase fingerprints already stored on readers.</p>
    <p role="status">Installation sync: {enabled === undefined ? "Unavailable" : enabled ? "On" : "Off"}</p>
    <div className="kiosk-actions">
      <button className="ui-button ui-button--primary" type="button" disabled={busy || enabled === undefined} onClick={() => void toggle()}>{busy ? "Please wait…" : enabled ? "Disable fingerprint sync" : "Enable fingerprint sync"}</button>
      <button className="ui-button" type="button" disabled={busy} onClick={() => void load()}>Refresh sync settings</button>
    </div>
    {notice && <p className="ui-status" data-tone={failed ? "error" : "success"} role={failed ? "alert" : "status"}>{notice}</p>}
  </article><FingerprintVaultSettings /></>;
}
