import { InfoTip } from "./info-tip";
import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type Enrollment = { fingerprintId: string; vaultId: string; rosterId: string; memberId: string; firstName: string; lastName: string; createdAt: number };
type VaultSettings = { enabled: boolean; keyStatus: "ready" | "missing" | "changed"; storedFingerprints: number; serverManagedKeys: true };
function checked(value: VaultSettings): VaultSettings {
  if (typeof value?.enabled !== "boolean" || !["ready", "missing", "changed"].includes(value.keyStatus) || !Number.isSafeInteger(value.storedFingerprints) || value.storedFingerprints < 0 || value.serverManagedKeys !== true) throw new Error("Fingerprint cloud storage settings are unavailable.");
  return value;
}

export function FingerprintVaultSettings() {
  const [enrollments, setEnrollments] = useState<Enrollment[]>();
  const [more, setMore] = useState(false);
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
      : "Disable fingerprint cloud storage and delete its cloud templates? Fingerprints already on readers remain.")) return;
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const result = checked(await api<VaultSettings>("/admin/kiosks/fingerprint-vault", { method: "PATCH", body: JSON.stringify({ enabled, confirmation: enabled ? "ENABLE CLOUD FINGERPRINT STORAGE" : "DISABLE CLOUD FINGERPRINT STORAGE" }) }));
      if (result.enabled !== enabled) throw new Error("The cloud storage setting was not confirmed. Refresh before trying again.");
      setSettings(result); setNotice(enabled ? "Cloud storage enabled. Online fingerprint kiosks automatically backfill mapped active-member templates and receive missing templates." : "Cloud storage disabled and cloud templates deleted. Existing reader copies are unchanged.");
    } catch (error) { setSettings(undefined); setNotice((error as Error).message); setFailed(true); }
    finally { setBusy(false); }
  }
  async function loadEnrollments(append = false) {
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const after = append ? enrollments?.at(-1)?.fingerprintId : undefined;
      const value = await api<{ enrollments: Enrollment[] }>("/admin/kiosks/fingerprint-vault/enrollments" + (after ? "?after=" + encodeURIComponent(after) : ""));
      if (!Array.isArray(value.enrollments)) throw new Error("Enrollments are unavailable.");
      setEnrollments(previous => append ? [...(previous ?? []), ...value.enrollments] : value.enrollments); setMore(value.enrollments.length === 50);
    } catch (error) { setFailed(true); setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  async function retire(entry: Enrollment) {
    if (busy || !window.confirm("Retire this enrollment for " + entry.firstName + " " + entry.lastName + " everywhere? Its cloud copy will be deleted and compatible online kiosks will remove its attendance mapping. Offline kiosks apply this when they reconnect. Reader templates remain stored. Other enrollments and historical duplicates are unchanged.")) return;
    setBusy(true); setFailed(false);
    try {
      const result = await api<{ retired: boolean }>("/admin/kiosks/fingerprint-vault/enrollments/" + encodeURIComponent(entry.fingerprintId), { method: "DELETE", body: JSON.stringify({ vaultId: entry.vaultId, rosterId: entry.rosterId, confirmation: "RETIRE ENROLLMENT EVERYWHERE" }) });
      if (result.retired !== true) throw new Error("Retirement was not confirmed. Refresh before retrying.");
      setEnrollments(previous => previous?.filter(row => row.fingerprintId !== entry.fingerprintId));
      setSettings(previous => previous ? { ...previous, storedFingerprints: Math.max(0, previous.storedFingerprints - 1) } : previous);
      setNotice("Enrollment retired. Compatible kiosks remove its mapping when they sync; reader templates are retained.");
    } catch (error) { setFailed(true); setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  return <article className="ui-card ui-form fingerprint-settings-card" aria-labelledby="fingerprint-vault-title">
    <div className="fingerprint-control-heading"><h3 id="fingerprint-vault-title">Cloud storage</h3><InfoTip label="About cloud storage">Encrypted cloud copies let kiosks receive enrollments while peers are offline. The installation server manages the key and can decrypt these copies. Only verified active-member enrollments are shared. Disabling storage deletes cloud copies and leaves reader copies intact.</InfoTip></div>
    <p role="status">Cloud storage: {settings ? settings.enabled ? "On" : "Off" : "Unavailable"}{settings && ` · ${settings.storedFingerprints} stored ${settings.storedFingerprints === 1 ? "fingerprint" : "fingerprints"}`}</p>
    {settings?.keyStatus !== "ready" && settings && <p className="ui-status" data-tone="error" role="alert">{settings.keyStatus === "changed" ? "The vault key changed. Preserve the cloud data and recover the original FINGERPRINT_VAULT_KEY before retrying. You can still disable storage to delete its cloud copies." : "The separate FINGERPRINT_VAULT_KEY is missing. Recover the original key for existing storage, or finish installation configuration before enabling new storage. You can still disable storage."}</p>}
    <div className="kiosk-actions">
      <button className="ui-button ui-button--primary" type="button" disabled={busy || !settings || !settings.enabled && settings.keyStatus !== "ready"} onClick={() => void toggle()}>{busy ? "Please wait…" : settings?.enabled ? "Disable cloud storage" : "Enable cloud storage"}</button>
      <button className="ui-button" type="button" disabled={busy} aria-label="Refresh cloud storage" title="Refresh cloud storage" onClick={() => void load()}>↻</button>
    </div>
    {notice && <p className="ui-status" data-tone={failed ? "error" : "success"} role={failed ? "alert" : "status"}>{notice}</p>}
    {settings?.enabled && <section className="fingerprint-enrollment-list" aria-label="Cloud enrollments">
      <button className="ui-button" type="button" disabled={busy} onClick={() => void loadEnrollments()}>Review cloud enrollments</button>
      {enrollments && <>
        <p>Local removal affects one kiosk. Retirement here removes access to one enrollment across compatible cloud-sync kiosks when they sync. Historical imported copies, stored reader templates and other enrollments are retained.</p>
        <ul>{enrollments.map(entry => <li key={entry.fingerprintId}>
          <span>{entry.firstName} {entry.lastName}  /  {entry.memberId}  /  {new Date(entry.createdAt).toLocaleDateString()}  /  {entry.fingerprintId.slice(0, 8)}</span>{" "}
          <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void retire(entry)}>Retire everywhere</button>
        </li>)}</ul>
        {!enrollments.length && <p>No cloud enrollments.</p>}
        {more && <button className="ui-button" type="button" disabled={busy} onClick={() => void loadEnrollments(true)}>Load more enrollments</button>}
      </>}
    </section>}
  </article>;
}
