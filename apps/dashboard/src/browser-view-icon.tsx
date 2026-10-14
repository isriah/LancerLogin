export function BrowserViewIcon({ view }: { view: "calendar" | "table" }) {
  return <svg className="meeting-view-icon" aria-hidden="true" viewBox="0 0 24 24">{view === "calendar" ? <><path d="M6 2v4M18 2v4M3 9h18" /><rect x="3" y="4" width="18" height="17" rx="2" /></> : <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16" /></>}</svg>;
}
