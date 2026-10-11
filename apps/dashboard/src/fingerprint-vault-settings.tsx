import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type VaultSettings = { enabled: boolean; keyStatus: "ready" | "missing" | "changed"; storedFingerprints: number; serverManagedKeys: true };
function checked(value: VaultSettings): VaultSettings {
  if (typeof value?.enabled !== "boolean" || !["ready", "missing", "changed"].includes(value.keyStatus) || !Number.isSafeInteger(value.storedFingerprints) || value.storedFingerprints < 0 || value.serverManagedKeys !== true) throw new Error("Fingerprint cloud storage settings are unavailable.");
  return value;
}

export function FingerprintVaultSettings() {
  const [settings, setSettings] = useState<VaultSettings>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  async function load() {
    setBusy(true); setNotice(""); setFailed(false);
    try { setSettings(checked(await api<VaultSettings>("/admin/kiosks/fingerprint-vault"))); }
    catch (error) { setSettings(undefined); setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function toggle() {
    if (!settings || busy || !settings.enabled && settings.keyStatus !== "ready") return;
    const enabled = !settings.enabled;
    if (!window.confirm(enabled
      ? "Store fingerprint templates encrypted on this installation's server? The server manages the encryption key and can decrypt them for authorized kiosks. Identity-verified active-member fingerprints will upload automatically when a kiosk is online. Older unverified mappings require re-enrollment before sharing. New paired kiosks will receive verified templates automatically, even when other kiosks are offline. Confirm your organization has permission to store and share this biometric data."
      : "Disable fingerprint cloud storage and delete its cloud templates? Fingerprints already on readers remain. This does not disable separately approved peer-to-peer sync.")) return;
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const result = checked(await api<VaultSettings>("/admin/kiosks/fingerprint-vault", { method: "PATCH", body: JSON.stringify({ enabled, confirmation: enabled ? "ENABLE CLOUD FINGERPRINT STORAGE" : "DISABLE CLOUD FINGERPRINT STORAGE" }) }));
      if (result.enabled !== enabled) throw new Error("The cloud storage setting was not confirmed. Refresh before trying again.");
      setSettings(result); setNotice(enabled ? "Cloud storage enabled. Online fingerprint kiosks automatically backfill mapped active-member templates and receive missing templates." : "Cloud storage disabled and cloud templates deleted. Existing reader copies are unchanged.");
    } catch (error) { setSettings(undefined); setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  return <article className="task-card ui-form fingerprint-settings-card" aria-labelledby="fingerprint-vault-title">
    <h2 id="fingerprint-vault-title">Fingerprint cloud storage</h2>
    <p>Optional, off by default. Keep encrypted copies so a newly paired fingerprint kiosk can receive current enrollments while every other kiosk is offline. The installation server manages the key and can decrypt these copies.</p>
    <p>Online kiosks upload only fingerprints verified against an active member's immutable roster identity. Older mappings without that identity require re-enrollment while a kiosk is online. Member-ID lookup cannot approve an old fingerprint for sharing. Unknown reader slots are untouched, and imports never overwrite occupied slots. Cloud copies remain until the member is deactivated, their ID changes, storage is disabled, Attendance is disabled, or the installation is restored. Removing a local mapping does not delete cloud copies or copies on other readers.</p>
    <p role="status">Cloud storage: {settings ? settings.enabled ? "On" : "Off" : "Unavailable"}{settings && ` · ${settings.storedFingerprints} stored ${settings.storedFingerprints === 1 ? "fingerprint" : "fingerprints"}`}</p>
    {settings?.keyStatus !== "ready" && settings && <p className="ui-status" data-tone="error" role="alert">{settings.keyStatus === "changed" ? "The vault key changed. Preserve the cloud data and recover the original FINGERPRINT_VAULT_KEY before retrying. You can still disable storage to delete its cloud copies." : "The separate FINGERPRINT_VAULT_KEY is missing. Recover the original key for existing storage, or finish installation configuration before enabling new storage. You can still disable storage."}</p>}
    <div className="kiosk-actions">
      <button className="ui-button ui-button--primary" type="button" disabled={busy || !settings || !settings.enabled && settings.keyStatus !== "ready"} onClick={() => void toggle()}>{busy ? "Please wait…" : settings?.enabled ? "Disable cloud storage" : "Enable cloud storage"}</button>
      <button className="ui-button" type="button" disabled={busy} onClick={() => void load()}>Refresh cloud storage</button>
    </div>
    {notice && <p className="ui-status" data-tone={failed ? "error" : "success"} role={failed ? "alert" : "status"}>{notice}</p>}
  </article>;
}
