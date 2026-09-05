import { FormEvent, useEffect, useState } from "react";
import { api } from "./dashboard-api";
import type { Branding } from "./setup-workspace";
import { AdaptiveBrandLogo, type LogoBackdrop } from "./adaptive-brand-logo";
import { ColorEditor } from "./color-editor";
import type { MeetingWeightCategory } from "./meeting-management";

type Notice = { tone: "success" | "error" | "neutral"; text: string };

function MeetingWeightSettings() {
  const [categories, setCategories] = useState<MeetingWeightCategory[]>([]);
  const [name, setName] = useState(""); const [weight, setWeight] = useState("1"); const [minimumDuration, setMinimumDuration] = useState("");
  const [notice, setNotice] = useState<Notice>(); const [busy, setBusy] = useState("");
  async function load() { const result = await api<{ categories: MeetingWeightCategory[] }>("/admin/meeting-weight-categories"); setCategories(result.categories); }
  useEffect(() => { void load().catch((error: Error) => setNotice({ tone: "error", text: error.message })); }, []);
  const active = categories.filter((category) => Boolean(category.active)).sort((left, right) => left.position - right.position);
  const retired = categories.filter((category) => !category.active);
  const durationValue = (value: string) => value ? Number(value) : null;
  function change(id: string, patch: Partial<MeetingWeightCategory>) { setCategories((current) => current.map((category) => category.id === id ? { ...category, ...patch } : category)); }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy("create"); setNotice(undefined);
    try { await api("/admin/meeting-weight-categories", { method: "POST", body: JSON.stringify({ name, weight: Number(weight), minimumDurationMinutes: durationValue(minimumDuration) }) }); setName(""); setWeight("1"); setMinimumDuration(""); await load(); setNotice({ tone: "success", text: "Weight category added." }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(""); }
  }
  async function save(category: MeetingWeightCategory) {
    setBusy(category.id); setNotice(undefined);
    try { await api(`/admin/meeting-weight-categories/${encodeURIComponent(category.id)}`, { method: "PATCH", body: JSON.stringify({ name: category.name, weight: Number(category.weight), minimumDurationMinutes: category.minimumDurationMinutes ?? null }) }); await load(); setNotice({ tone: "success", text: `${category.name} saved. Existing meetings keep their saved weight.` }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(""); }
  }
  async function setActive(category: MeetingWeightCategory, enabled: boolean) {
    setBusy(category.id); setNotice(undefined);
    try { await api(`/admin/meeting-weight-categories/${encodeURIComponent(category.id)}`, { method: "PATCH", body: JSON.stringify({ active: enabled }) }); await load(); setNotice({ tone: "success", text: `${category.name} ${enabled ? "restored" : "retired"}. Existing meetings are unchanged.` }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(""); }
  }
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction; if (target < 0 || target >= active.length) return;
    const ordered = active.map((category) => category.id); [ordered[index], ordered[target]] = [ordered[target], ordered[index]]; setBusy("order"); setNotice(undefined);
    try { await api("/admin/meeting-weight-categories/order", { method: "PATCH", body: JSON.stringify({ orderedIds: ordered }) }); await load(); setNotice({ tone: "success", text: "Automatic rule priority updated." }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(""); }
  }
  return <section className="task-card meeting-weight-settings ui-card" aria-labelledby="meeting-weight-settings-title">
    <div className="panel-heading"><div><h2 id="meeting-weight-settings-title">Meeting weights</h2><p>The first matching active duration rule is selected when a meeting is created. Existing meetings keep their saved category name and weight.</p></div><span className="ui-status" data-tone="neutral">{active.length} active</span></div>
    {notice && <p className="ui-status settings-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
    <form className="meeting-weight-add" onSubmit={create}><h3>Add category</h3><div className="form-grid"><label>Name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label><label>Weight<input required type="number" min="0.1" max="100" step="0.1" value={weight} onChange={(event) => setWeight(event.target.value)} /></label><label>Minimum duration <span>(optional minutes)</span><input type="number" min="1" max="10080" step="1" value={minimumDuration} onChange={(event) => setMinimumDuration(event.target.value)} /></label></div><button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === "create" ? "Adding…" : "Add category"}</button></form>
    {active.length ? <ol className="meeting-weight-list">{active.map((category, index) => <li key={category.id}><div className="meeting-weight-priority"><strong>Priority {index + 1}</strong><div><button type="button" aria-label={`Move ${category.name} up`} disabled={Boolean(busy) || index === 0} onClick={() => void move(index, -1)}>↑</button><button type="button" aria-label={`Move ${category.name} down`} disabled={Boolean(busy) || index === active.length - 1} onClick={() => void move(index, 1)}>↓</button></div></div><div className="form-grid"><label>Name<input required maxLength={80} value={category.name} onChange={(event) => change(category.id, { name: event.target.value })} /></label><label>Weight<input required type="number" min="0.1" max="100" step="0.1" value={category.weight} onChange={(event) => change(category.id, { weight: Number(event.target.value) })} /></label><label>Minimum duration <span>(optional minutes)</span><input type="number" min="1" max="10080" step="1" value={category.minimumDurationMinutes ?? ""} onChange={(event) => change(category.id, { minimumDurationMinutes: event.target.value ? Number(event.target.value) : null })} /></label></div><div className="meeting-weight-actions"><button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void save(category)}>{busy === category.id ? "Saving…" : "Save"}</button><button className="danger-button" type="button" disabled={Boolean(busy)} onClick={() => void setActive(category, false)}>Retire</button></div></li>)}</ol> : <p className="empty-state">No weight categories yet. Meetings use the default 1× weight.</p>}
    {retired.length > 0 && <details className="retired-weight-categories"><summary>Retired categories ({retired.length})</summary><ul>{retired.map((category) => <li key={category.id}><span><strong>{category.name}</strong> · {category.weight}×</span><button type="button" disabled={Boolean(busy)} onClick={() => void setActive(category, true)}>Restore</button></li>)}</ul></details>}
  </section>;
}

export function OrganizationSettings({ initialBranding, onChanged }: { initialBranding: Branding; onChanged: (branding: Branding) => void }) {
  const [branding, setBranding] = useState(initialBranding); const [notice, setNotice] = useState<Notice>(); const [saving, setSaving] = useState(false);
  async function logo(file?: File) { if (!file) return; if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 131_072) { setNotice({ tone: "error", text: "Choose a PNG, JPEG, or WebP logo no larger than 128 KiB." }); return; } const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); setBranding({ ...branding, logoData: data }); setNotice({ tone: "neutral", text: "Logo selected. Save to store it in D1." }); }
  async function save(event: FormEvent) { event.preventDefault(); setSaving(true); try { await api("/admin/branding", { method: "PATCH", body: JSON.stringify(branding) }); onChanged(branding); setNotice({ tone: "success", text: "Organization and appearance saved." }); } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); } finally { setSaving(false); } }
  return <section className="settings-page settings-organization" aria-labelledby="organization-title"><div className="page-intro"><h1 id="organization-title">Organization</h1><p>Manage the identity, adopter-brand appearance, and reusable meeting weights.</p></div>{notice && <p className="ui-status settings-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}<form className="settings-form" onSubmit={save}><label>Organization name<input required maxLength={100} value={branding.organizationName} onChange={(event) => setBranding({ ...branding, organizationName: event.target.value })} /></label><label>Subtitle <span>(optional)</span><input maxLength={140} value={branding.subtitle ?? ""} onChange={(event) => setBranding({ ...branding, subtitle: event.target.value })} /></label><label>Logo image<input type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="organization-logo-help" onChange={(event) => void logo(event.target.files?.[0])} /><span id="organization-logo-help" className="field-help">PNG, JPEG, or WebP, up to 128 KiB.</span></label>{branding.logoData && <><div className="logo-preview-grid"><div data-preview-theme="light"><span>Light preview</span><AdaptiveBrandLogo src={branding.logoData} alt="Organization logo on light background" backdrop={branding.logoBackdrop} /></div><div data-preview-theme="dark"><span>Dark preview</span><AdaptiveBrandLogo src={branding.logoData} alt="Organization logo on dark background" backdrop={branding.logoBackdrop} /></div></div><fieldset className="logo-backdrop-options"><legend>Logo contrast background</legend><div>{([{ value: "auto", label: "Automatic" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "none", label: "None" }] as { value: LogoBackdrop; label: string }[]).map((option) => <label className={branding.logoBackdrop === option.value ? "selected" : ""} key={option.value}><input type="radio" name="logo-backdrop" checked={branding.logoBackdrop === option.value} onChange={() => setBranding({ ...branding, logoBackdrop: option.value })} />{option.label}</label>)}</div></fieldset><button className="quiet-button" type="button" onClick={() => setBranding({ ...branding, logoData: "" })}>Remove logo</button></>}<div className="color-grid"><ColorEditor label="Primary color" value={branding.primaryColor} onChange={(primaryColor) => setBranding({ ...branding, primaryColor })} /><ColorEditor label="Secondary color" value={branding.secondaryColor} onChange={(secondaryColor) => setBranding({ ...branding, secondaryColor })} /></div><p className="field-help">Theme choice is saved separately in each browser from the light/dark mode button.</p><button className="primary-button" disabled={saving} type="submit">{saving ? "Saving…" : "Save organization settings"}</button></form><MeetingWeightSettings /></section>;
}
