import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; readerOnline?: number; releaseVersion?: string; pairedAt: string };
type Simulator = { name: string; active: number; online: number; lastSeenAt?: string; readerOnline: false; releaseVersion: string };

export function KiosksPage({ role, openSetup }: { role: "admin" | "operator"; openSetup: () => void }) {
  const [kiosks, setKiosks] = useState<Kiosk[]>([]); const [simulator, setSimulator] = useState<Simulator | null>(null); const [notice, setNotice] = useState("Loading kiosk status…");
  async function load() {
    const [hardware, simulated] = await Promise.all([api<{ kiosks: Kiosk[] }>("/admin/kiosks"), role === "admin" ? api<{ simulator: Simulator | null }>("/admin/simulator") : Promise.resolve({ simulator: null })]);
    setKiosks(hardware.kiosks); setSimulator(simulated.simulator); setNotice("Kiosk status is current.");
  }
  useEffect(() => { void load().catch((error: Error) => setNotice(error.message)); const timer = window.setInterval(() => void load().catch(() => undefined), 30_000); return () => window.clearInterval(timer); }, [role]);
  const active = kiosks.find((kiosk) => kiosk.active === 1); const online = Boolean(active?.lastSeenAt && Date.now() - Date.parse(active.lastSeenAt) < 90_000);
  return <section className="page-stack" aria-labelledby="kiosks-title"><div className="page-intro"><h1 id="kiosks-title">Kiosks</h1></div><p className="setup-status" role="status">{notice}</p><div className="kiosk-grid"><article className="task-card"><h2>Physical kiosk</h2><strong>{active?.name ?? "No kiosk paired"}</strong><span className={`status-pill ${online ? "online" : "offline"}`}>{online ? "Online" : active ? "Offline" : "Not paired"}</span><dl><div><dt>Fingerprint reader</dt><dd>{active ? active.readerOnline ? "Online" : "Offline" : "—"}</dd></div><div><dt>Release</dt><dd>{active?.releaseVersion ?? "—"}</dd></div><div><dt>Last heartbeat</dt><dd>{active?.lastSeenAt ? new Date(active.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>Paired</dt><dd>{active?.pairedAt ? new Date(active.pairedAt).toLocaleString() : "—"}</dd></div></dl>{role === "admin" && <button className="primary-button" type="button" onClick={openSetup}>{active ? "Replace or retest kiosk" : "Pair a kiosk"}</button>}</article><article className="task-card"><h2>Browser simulator</h2><strong>{simulator?.name ?? "Not configured"}</strong><span className={`status-pill ${simulator?.active && simulator.online ? "online" : "offline"}`}>{simulator?.active ? simulator.online ? "Online" : "Offline" : "Not paired"}</span><p>The guided setup simulator sends test-meeting attendance events without fingerprint hardware.</p>{role === "admin" && <button className="primary-button" type="button" onClick={openSetup}>{simulator?.active ? "Open simulator test" : "Set up simulator"}</button>}</article></div></section>;
}
