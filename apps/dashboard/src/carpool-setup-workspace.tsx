import { FormEvent, useEffect, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";

type Props = { module: ModuleSnapshotItem; navigate: (path: string) => void; onReady: () => Promise<void> | void };
type SetupState = { moduleId: string; generation: number; ready: boolean; steps: Array<{ id: string; label: string; required: boolean; valid: boolean; outcome: "completed" | null }> };

export function CarpoolSetupWorkspace({ module, navigate, onReady }: Props) {
  const [state, setState] = useState<SetupState>(); const [title, setTitle] = useState(""); const [destination, setDestination] = useState(""); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  useEffect(() => { void api<SetupState>(`/admin/modules/${module.id}/setup`).then(setState).catch((error: Error) => setNotice(error.message)); }, [module.id, module.generation]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      await api("/module-setup/carpool/plan", { method: "POST", body: JSON.stringify({ title, destination }) });
      const next = await api<SetupState>(`/admin/modules/${module.id}/setup`, { method: "PUT", body: JSON.stringify({ generation: module.generation, stepId: "workspace", outcome: "completed" }) });
      setState(next); await onReady(); navigate("/carpool");
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  return <section className="module-onboarding" aria-labelledby="carpool-setup-title"><div className="page-intro"><p className="kicker">Carpool module</p><h1 id="carpool-setup-title">Set up Carpool</h1><p>Create the first independent ride plan. A roster member or event can be linked later, but neither is required.</p></div>{notice && <p className="ui-status settings-notice" data-tone="error" role="alert">{notice}</p>}<div className="module-setup-summary" role="status"><strong>{state?.ready ? "Setup complete" : "Setup required"}</strong><span>Step 1 of 1</span></div><form className="module-setup-card ui-form" onSubmit={submit}><div className="module-setup-card-heading"><div><p className="kicker">Step 1 - Required</p><h2>First Carpool plan</h2></div></div><label>Plan name<input required maxLength={150} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Regional competition" /></label><label>Destination <span>(optional)</span><input maxLength={300} value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Venue or destination" /></label><div className="module-actions"><button className="ui-button ui-button--primary" disabled={busy || !title.trim()} type="submit">{busy ? "Creating..." : "Create plan and finish setup"}</button></div></form></section>;
}
