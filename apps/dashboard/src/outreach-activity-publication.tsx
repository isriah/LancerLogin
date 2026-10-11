import { useEffect, useState } from "react";
import type { CivilTimeOccurrence } from "@lancerlogin/shared/civil-time";
import { api } from "./dashboard-api";
import { OutreachClock } from "./outreach-clock";

export type OutreachEventSchedule = {
  eventStartLocal: string | null;
  eventEndLocal: string | null;
  eventStartOccurrence: CivilTimeOccurrence | null;
  eventEndOccurrence: CivilTimeOccurrence | null;
};

export type OutreachPublicationProviders = { google_calendar: boolean; discord: boolean };
export type OutreachActivityPublication = {
  activityId: string;
  revision: number;
  googleCalendar: boolean;
  discord: boolean;
  googleStatus: string | null;
  googleAction?: "publish" | "delete" | null;
  googleError: string | null;
  discordStatus: string | null;
  discordAction?: "publish" | "delete" | null;
  discordError: string | null;
};

type Notice = { tone: "success" | "error"; text: string };

export function OutreachEventScheduleFields({ date, timeZone, value, onChange, disabled }: { date: string; timeZone: string; value: OutreachEventSchedule; onChange: (value: OutreachEventSchedule) => void; disabled: boolean }) {
  const scheduled = Boolean(value.eventStartLocal && value.eventEndLocal);
  return <fieldset className="outreach-stack outreach-fieldset"><legend>Event times (optional)</legend><label className="settings-checkbox"><input className="ui-checkbox" type="checkbox" checked={scheduled} disabled={disabled} onChange={(event) => onChange(event.target.checked ? { eventStartLocal: "17:00", eventEndLocal: "18:00", eventStartOccurrence: null, eventEndOccurrence: null } : { eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null })} /> Set event times</label><p className="field-help">Planned start and end times are optional. Sharing an event externally requires both times; members record their actual participation separately.</p>{scheduled && <div className="outreach-time-grid"><OutreachClock label="Event start time" date={date} zone={timeZone} time={value.eventStartLocal!} occurrence={value.eventStartOccurrence ?? undefined} disabled={disabled} onTime={(eventStartLocal) => onChange({ ...value, eventStartLocal })} onOccurrence={(eventStartOccurrence) => onChange({ ...value, eventStartOccurrence: eventStartOccurrence ?? null })} /><OutreachClock label="Event end time" date={date} zone={timeZone} time={value.eventEndLocal!} occurrence={value.eventEndOccurrence ?? undefined} disabled={disabled} onTime={(eventEndLocal) => onChange({ ...value, eventEndLocal })} onOccurrence={(eventEndOccurrence) => onChange({ ...value, eventEndOccurrence: eventEndOccurrence ?? null })} /></div>}</fieldset>;
}

const providerDetails = [
  { key: "google_calendar", label: "Google Calendar", selected: "googleCalendar", status: "googleStatus", action: "googleAction", error: "googleError" },
  { key: "discord", label: "Discord", selected: "discord", status: "discordStatus", action: "discordAction", error: "discordError" },
] as const;

function statusLabel(configured: boolean, selected: boolean, status: string | null, action: "publish" | "delete" | null | undefined) {
  if (!configured) return "Not configured";
  if (!selected || !status) return "Not published";
  if (action === "delete") return status === "delivered" ? "Removed" : status === "failed" ? "Removal failed" : "Removal queued";
  if (status === "delivered") return "Published";
  if (status === "failed") return "Publication failed";
  if (status === "processing") return "Publishing";
  return "Queued";
}

export function ActivityPublicationControls({ activity, publication, providers, onChanged, setNotice }: { activity: { id: string; revision: number; serviceDate: string; archived?: boolean } & OutreachEventSchedule; publication?: OutreachActivityPublication; providers: OutreachPublicationProviders; onChanged: () => Promise<void>; setNotice: (notice: Notice) => void }) {
  const [saving, setSaving] = useState(false);
  const scheduled = Boolean(activity.eventStartLocal && activity.eventEndLocal);
  const configured = providers.google_calendar || providers.discord;
  async function publish() {
    setSaving(true);
    try {
      await api(`/admin/hours/activities/${encodeURIComponent(activity.id)}/publication`, { method: "POST", body: JSON.stringify({ activityRevision: activity.revision, publicationRevision: publication?.revision ?? null }) });
      await onChanged();
      setNotice({ tone: "success", text: publication ? "Event publication queued again for configured destinations." : "Event publication queued for configured destinations." });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  }
  async function retry(provider: "google_calendar" | "discord") {
    if (!publication) return;
    setSaving(true);
    try {
      await api(`/admin/hours/activities/${encodeURIComponent(activity.id)}/publication/retry`, { method: "POST", body: JSON.stringify({ revision: publication.revision, provider }) });
      await onChanged();
      setNotice({ tone: "success", text: "Failed publication delivery queued again." });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  }
  return <section className="outreach-stack" aria-label="Event publication"><div className="outreach-row"><div><strong>Publication</strong><p>{activity.archived ? "This archived Event is not eligible for publication. Any owned provider event is removed through the status actions below." : scheduled ? "Send this Event to every configured destination." : "Not ready to publish. Add a complete event schedule first."}</p></div>{!activity.archived && <button className="ui-button ui-button--primary" type="button" disabled={saving || !scheduled || !configured} onClick={() => void publish()}>{publication ? "Resend" : "Publish"}</button>}</div>{providerDetails.map((provider) => { const selected = Boolean(publication?.[provider.selected]); const status = publication?.[provider.status] ?? null; const action = publication?.[provider.action] ?? null; const error = publication?.[provider.error] ?? null; return <div className="outreach-row" key={provider.key}><div><strong>{provider.label}</strong><p>{statusLabel(providers[provider.key], selected, status, action)}</p>{error && <small>{error}</small>}</div>{status === "failed" && (!activity.archived || action === "delete") && <button className="ui-button" type="button" disabled={saving || !providers[provider.key]} onClick={() => void retry(provider.key)}>{action === "delete" ? "Retry removal" : `Resend ${provider.label}`}</button>}</div>; })}</section>;
}

export function OutreachAutomaticPublicationSetting() {
  const [setting, setSetting] = useState<{ automatic: boolean; revision: number }>();
  const [providers, setProviders] = useState<OutreachPublicationProviders>();
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => { void Promise.all([api<{ automatic: boolean; revision: number }>("/admin/hours/publication-settings"), api<OutreachPublicationProviders>("/admin/hours/publication-providers")]).then(([nextSetting, nextProviders]) => { setSetting(nextSetting); setProviders(nextProviders); }).catch((error) => setNotice({ tone: "error", text: (error as Error).message })).finally(() => setBusy(false)); }, []);
  async function change(automatic: boolean) {
    if (!setting) return;
    setBusy(true); setNotice(undefined);
    try {
      const next = await api<{ automatic: boolean; revision: number }>("/admin/hours/publication-settings", { method: "PATCH", body: JSON.stringify({ automatic, revision: setting.revision }) });
      setSetting(next); setNotice({ tone: "success", text: automatic ? "Automatic Event publication is on." : "Automatic Event publication is off." });
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  const destinations = providers ? [providers.google_calendar ? "Google Calendar" : "", providers.discord ? "Discord" : ""].filter(Boolean) : [];
  return <article className="ui-card outreach-stack" aria-labelledby="automatic-outreach-publication-title"><div><h2 id="automatic-outreach-publication-title">Automatic activity publication</h2><p>Off by default. When on, saving a future Event with a complete schedule queues every configured destination. Team Support and Other Service activities are never published.</p></div>{setting && <label className="settings-checkbox"><input className="ui-checkbox" type="checkbox" checked={setting.automatic} disabled={busy} onChange={(event) => void change(event.target.checked)} /> Automatically publish scheduled Events</label>}<p className="field-help">Configured destinations: {destinations.length ? destinations.join(" and ") : "None. Configure Google Calendar or Discord in Integrations."}</p>{busy && !setting && <p className="ui-status" role="status">Loading publication settings...</p>}{notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}</article>;
}
