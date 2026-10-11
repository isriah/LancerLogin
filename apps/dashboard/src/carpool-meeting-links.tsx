import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { RouteLink } from "./router";
import "./carpool-meeting-links.css";

export type CarpoolMeetingLink = { meetingId: string; id: string; title: string };
export type RelatedMeeting = { id: string; title: string; startsAt: string; endsAt: string };

export function useCarpoolMeetingLinks(refreshIdentity: unknown) {
  const [links, setLinks] = useState<CarpoolMeetingLink[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setLinks([]);
    void api<{ available: boolean; links: CarpoolMeetingLink[] }>("/admin/carpool/meeting-links", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setLinks(result.available ? result.links : []); }).catch(() => { if (!controller.signal.aborted) setLinks([]); });
    return () => controller.abort();
  }, [refreshIdentity]);
  return links;
}

export function CarpoolMarker({ count }: { count: number }) {
  if (!count) return null;
  return <span className="carpool-meeting-marker" title={`${count} linked ${count === 1 ? "carpool" : "carpools"}`}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 9 2-5h10l2 5M4 9h16v9H4zM7 18v2m10-2v2M7 13h.01M17 13h.01" /></svg><span className="visually-hidden">{count} linked {count === 1 ? "carpool" : "carpools"}</span></span>;
}

export function MeetingCarpoolLinks({ links, navigate }: { links: CarpoolMeetingLink[]; navigate: (path: string) => void }) {
  if (!links.length) return null;
  return <section className="ui-card carpool-meeting-links" aria-labelledby="meeting-carpools-title"><h2 id="meeting-carpools-title">Carpools</h2><nav aria-label="Meeting carpools">{links.map((link) => <RouteLink key={link.id} className="ui-button" href={`/carpool/plans/${encodeURIComponent(link.id)}`} currentPath="" navigate={navigate}><CarpoolMarker count={1} /><span>{link.title}</span></RouteLink>)}</nav></section>;
}

export function RelatedMeetingLink({ meeting, open }: { meeting: RelatedMeeting; open: (id: string) => void }) {
  return <RouteLink className="ui-button carpool-related-meeting-link" href={`/meetings/${encodeURIComponent(meeting.id)}`} currentPath="" navigate={() => open(meeting.id)}>Open meeting: {meeting.title}</RouteLink>;
}

export function CarpoolMeetingSelector({ meetingId, choices, available, busy, onChange }: { meetingId: string; choices: RelatedMeeting[]; available: boolean; busy: boolean; onChange: (id: string) => void }) {
  if (!available && !meetingId) return null;
  const missing = Boolean(meetingId && !choices.some((meeting) => meeting.id === meetingId));
  return <label className="carpool-meeting-selector">Associated meeting <span>(optional)</span><select className="ui-control ui-native-select" value={meetingId} disabled={busy} onChange={(event) => onChange(event.target.value)}><option value="">None - standalone Carpool</option>{missing && <option value={meetingId}>Linked meeting unavailable</option>}{available && choices.map((meeting) => <option key={meeting.id} value={meeting.id}>{new Date(meeting.startsAt).toLocaleDateString()} - {meeting.title}</option>)}</select><small>{available ? "Navigation only. This does not change attendance, schedules, or ride assignments." : "The saved link is retained. Choose None to remove it."}</small></label>;
}
