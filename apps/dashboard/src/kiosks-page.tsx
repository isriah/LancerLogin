import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { hardwarePairingKey, kioskInstallerUrl } from "./hardware-pairing-key";
import { useModalFocus } from "./modal-focus";
import { useDashboardLoadingOverlay } from "./loading-overlay";

type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; readerOnline?: number; releaseVersion?: string; uptimeSeconds?: number; networkType?: "wifi" | "ethernet" | "offline"; networkSignal?: number | null; lastWifiScanAt?: string; pendingEvents?: number; lastSyncAt?: string; errorCategory?: string; pairedAt: string };
type Simulator = { name: string; active: number; online: number; lastSeenAt?: string; readerOnline: false; releaseVersion: string };
type Pairing = { code: string; expiresAt: string; workerApiUrl: string; kioskName: string };
type KioskCommand = "reload_display" | "restart_service" | "reboot" | "reset_network_pin" | "install_latest";

function formatUptime(seconds?: number) {
  if (!Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.floor(Number(seconds) / 60); const days = Math.floor(totalMinutes / 1_440); const hours = Math.floor(totalMinutes % 1_440 / 60); const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

function recoveryGuidance(kiosk: Kiosk, online: boolean) {
  if (!kiosk.readerOnline) return "Reader offline: check the R503 cable and power, then use the physical kiosk’s protected maintenance reader test.";
  if (!online || kiosk.networkType === "offline") return "Kiosk offline: check Ethernet or unlock local network settings from the physical kiosk’s network control.";
  if ((kiosk.pendingEvents ?? 0) > 0) return "Scans are queued safely and will sync in order when the cloud connection returns.";
  if (kiosk.errorCategory) return `Recovery: ${kiosk.errorCategory.replaceAll("_", " ")}. Check the physical kiosk status, then restart software if the issue persists.`;
  return "Healthy: no recovery action is needed.";
}

function PairKioskDialog({ active, onClose, onPaired }: { active?: Kiosk; onClose: () => void; onPaired: () => Promise<void> }) {
  const [name, setName] = useState(active ? `${active.name} replacement` : "Main kiosk");
  const [replace, setReplace] = useState(false);
  const [pairing, setPairing] = useState<Pairing>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, busy, onClose);

  async function generate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try { setPairing(await api<Pairing>("/admin/pairing-codes", { method: "POST", body: JSON.stringify({ kioskName: name, replaceExisting: active ? replace : false, purpose: "hardware" }) })); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  const key = pairing ? hardwarePairingKey(pairing.workerApiUrl, pairing.code, pairing.kioskName) : "";
  return <div className="dialog-backdrop"><div className="kiosk-pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-kiosk-title" tabIndex={-1} ref={dialog}>
    <form onSubmit={generate}>
      <div className="dialog-heading"><div><h2 id="pair-kiosk-title">{active ? "Replace physical kiosk" : "Add physical kiosk"}</h2><p>Install the kiosk software, then pair it without returning to onboarding.</p></div><button type="button" aria-label="Close pairing dialog" disabled={busy} onClick={onClose}>×</button></div>
      <a className="installer-link" href={kioskInstallerUrl}>Download the latest guided Pi installer</a>
      <label>Kiosk name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      {active && <label className="check"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /><span>I understand that redeeming this key retires <strong>{active.name}</strong>.</span></label>}
      <button className="primary-button" type="submit" disabled={busy || Boolean(active) && !replace}>{busy ? "Creating…" : "Create one-time pairing key"}</button>
      {notice && <p className="inline-messages error" role="alert">{notice}</p>}
      {pairing && <div className="pairing-key"><span>Paste this into the Pi’s local pairing page</span><code>{key}</code><small>Expires {new Date(pairing.expiresAt).toLocaleString()}.</small><button type="button" onClick={() => void navigator.clipboard.writeText(key).then(() => setNotice("Pairing key copied."), () => setNotice("Select and copy the displayed key manually."))}>Copy pairing key</button></div>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button>{pairing && <button className="primary-button" type="button" onClick={() => void onPaired().then(onClose)}>I paired it — refresh status</button>}</div>
    </form>
  </div></div>;
}

export function KiosksPage({ role }: { role: "admin" | "operator" }) {
  const [kiosks, setKiosks] = useState<Kiosk[]>([]);
  const [simulator, setSimulator] = useState<Simulator | null>(null);
  const [notice, setNotice] = useState("Loading kiosk status…");
  useDashboardLoadingOverlay(notice === "Loading kiosk status…", "Loading kiosk status…");
  const [pairing, setPairing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [maintenanceHelp, setMaintenanceHelp] = useState(false);
  const [name, setName] = useState("");

  async function load() {
    const [hardware, simulated] = await Promise.all([api<{ kiosks: Kiosk[] }>("/admin/kiosks"), role === "admin" ? api<{ simulator: Simulator | null }>("/admin/simulator") : Promise.resolve({ simulator: null })]);
    setKiosks(hardware.kiosks); setSimulator(simulated.simulator); setNotice("Kiosk status is current.");
  }
  useEffect(() => { void load().catch((error: Error) => setNotice(error.message)); const timer = window.setInterval(() => void load().catch(() => undefined), 30_000); return () => window.clearInterval(timer); }, [role]);
  const active = kiosks.find((kiosk) => kiosk.active === 1);
  const retired = kiosks.filter((kiosk) => kiosk.active !== 1);
  const online = Boolean(active?.lastSeenAt && Date.now() - Date.parse(active.lastSeenAt) < 90_000);

  async function rename() { if (!active) return; try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }); setEditing(false); setNotice("Kiosk renamed."); await load(); } catch (error) { setNotice((error as Error).message); } }
  async function retire() { if (!active || !window.confirm(`Retire ${active.name}? Its credential will stop working, but its history will remain.`)) return; try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}`, { method: "DELETE", body: JSON.stringify({ confirmation: "RETIRE KIOSK" }) }); setNotice("Kiosk retired. You can pair another device now."); await load(); } catch (error) { setNotice((error as Error).message); } }
  async function command(type: KioskCommand, label: string, confirmation?: string) { if (!active || confirmation && !window.confirm(confirmation)) return; try { await api(`/admin/kiosks/${encodeURIComponent(active.id)}/commands`, { method: "POST", body: JSON.stringify({ command: type }) }); setNotice(`${label} queued. The kiosk normally receives it within five seconds.`); } catch (error) { setNotice((error as Error).message); } }
  async function stopSimulator() { try { await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "stop" }) }); setNotice("Browser simulator stopped."); await load(); } catch (error) { setNotice((error as Error).message); } }

  return <section className="page-stack" aria-labelledby="kiosks-title">
    <div className="page-intro kiosk-page-heading"><h1 id="kiosks-title">Kiosks</h1>{role === "admin" && <button className="primary-button" type="button" onClick={() => setPairing(true)}>{active ? "Replace kiosk" : "Add kiosk"}</button>}</div>
    <p className="setup-status" role="status">{notice}</p>
    <div className="kiosk-grid">
      <article className="task-card">
        <h2>Physical kiosk</h2>
        <div className="kiosk-state"><strong>{active?.name ?? "No kiosk paired"}</strong><span className={`status-pill ${online ? "online" : "offline"}`}>{online ? "Online" : active ? "Offline" : "Not paired"}</span></div>
        {active ? <>
          <dl><div><dt>Fingerprint reader</dt><dd>{active.readerOnline ? "Online" : "Offline"}</dd></div><div><dt>Network</dt><dd>{active.networkType === "wifi" ? `Wi-Fi${active.networkSignal !== null && active.networkSignal !== undefined ? ` · ${active.networkSignal}% signal` : ""}` : active.networkType === "ethernet" ? "Ethernet" : active.networkType === "offline" ? "Offline" : "Unavailable"}</dd></div><div><dt>Last Wi-Fi scan</dt><dd>{active.lastWifiScanAt ? new Date(active.lastWifiScanAt).toLocaleString() : "Never"}</dd></div><div><dt>Uptime</dt><dd>{formatUptime(active.uptimeSeconds)}</dd></div><div><dt>Pending scans</dt><dd>{active.pendingEvents ?? 0}</dd></div><div><dt>Last successful sync</dt><dd>{active.lastSyncAt ? new Date(active.lastSyncAt).toLocaleString() : "Never"}</dd></div><div><dt>Release</dt><dd>{active.releaseVersion ?? "—"}</dd></div><div><dt>Last heartbeat</dt><dd>{active.lastSeenAt ? new Date(active.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>Paired</dt><dd>{new Date(active.pairedAt).toLocaleString()}</dd></div></dl>
          <p className={active.errorCategory || !active.readerOnline || !online || active.networkType === "offline" ? "warning-callout" : "settings-callout"} role="status"><strong>Recovery guidance</strong><br />{recoveryGuidance(active, online)}</p>
          {role === "admin" && <>
            <div className="kiosk-actions">
              {editing ? <><label>Device name<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="primary-button" type="button" onClick={() => void rename()}>Save name</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></> : <button type="button" onClick={() => { setName(active.name); setEditing(true); }}>Rename</button>}
              <button type="button" onClick={() => setMaintenanceHelp((value) => !value)}>Fingerprint maintenance</button>
              <button type="button" onClick={() => void command("reload_display", "Display reload")}>Reload display</button>
              <button type="button" onClick={() => void command("restart_service", "Software restart")}>Restart software</button>
              <button type="button" onClick={() => void command("reboot", "Device reboot", `Reboot ${active.name}? Attendance scanning will pause while the Pi restarts.`)}>Reboot Pi</button>
              <button type="button" onClick={() => void command("reset_network_pin", "Network PIN reset", `Reset the local settings PIN on ${active.name}? Anyone at the kiosk can then create a new PIN.`)}>Reset network PIN</button>
              <button className="primary-button" type="button" disabled={!online} onClick={() => void command("install_latest", "Latest stable kiosk update")}>Update to latest stable</button>
              <button className="danger-button" type="button" onClick={() => void retire()}>Retire kiosk</button>
            </div>
            {maintenanceHelp && <div className="settings-callout" role="status"><strong>Open maintenance on the physical kiosk</strong><p>Press and hold the organization name or logo for three seconds, then enter the local settings PIN. Enrollment, reader tests, slot suggestions, replacement warnings, and mapping removal are available there so fingerprint templates never leave the sensor.</p></div>}
          </>}
        </> : <p>Pair a Raspberry Pi to begin unattended fingerprint attendance. Pairing and replacement are managed here after onboarding.</p>}
      </article>
      <article className="task-card"><h2>Browser simulator</h2><div className="kiosk-state"><strong>{simulator?.name ?? "Not configured"}</strong><span className={`status-pill ${simulator?.active && simulator.online ? "online" : "offline"}`}>{simulator?.active ? simulator.online ? "Online" : "Offline" : "Not paired"}</span></div><p>Uses the kiosk scan surface with browser-selected simulated reads. Events are audited and do not count as physical kiosk activity.</p>{role === "admin" && simulator?.active === 1 && <div className="kiosk-actions"><a className="primary-button action-link" href="/simulator">Open simulator</a><button type="button" onClick={() => void stopSimulator()}>Stop simulator</button></div>}</article>
    </div>
    {retired.length > 0 && <article className="task-card"><h2>Device history</h2><div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Name</th><th scope="col">Paired</th><th scope="col">Last seen</th><th scope="col">Release</th></tr></thead><tbody>{retired.map((kiosk) => <tr key={kiosk.id}><td>{kiosk.name}</td><td>{new Date(kiosk.pairedAt).toLocaleString()}</td><td>{kiosk.lastSeenAt ? new Date(kiosk.lastSeenAt).toLocaleString() : "Never"}</td><td>{kiosk.releaseVersion ?? "—"}</td></tr>)}</tbody></table></div></article>}
    {pairing && <PairKioskDialog active={active} onClose={() => setPairing(false)} onPaired={load} />}
  </section>;
}
