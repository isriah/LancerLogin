import { useId } from "react";
import { RouteLink, usePath } from "./router";
import "./mobile-settings.css";

export function SettingsSectionNavigation({ label, sections, currentHref, navigate }: { label: string; sections: [string, string][]; currentHref: string; navigate: (path: string) => void }) {
  const id = useId();
  return <><label className="settings-section-picker" htmlFor={id}><span>{label === "Attendance settings sections" ? "Attendance section" : label === "Outreach settings sections" ? "Outreach section" : label}</span><select id={id} value={currentHref} onChange={(event) => navigate(event.target.value)}>{sections.map(([href, title]) => <option key={href} value={href}>{title}</option>)}</select></label><nav className="ui-control-group settings-section-navigation" aria-label={label}>
    {sections.map(([href, title]) => <RouteLink key={href} href={href} currentPath={currentHref} navigate={navigate}>{title}</RouteLink>)}
  </nav></>;
}

export function settingsSectionHref(path: string, search: string, section: string) {
  const params = new URLSearchParams(search);
  params.set("section", section);
  return `${path}?${params}`;
}

export function AttendanceSettingsSections({ role = "admin" }: { role?: "admin" | "operator" }) {
  const { path, navigate } = usePath();
  return <div className="settings-section-toolbar">
    <SettingsSectionNavigation label="Attendance settings sections" currentHref={path} navigate={navigate} sections={[
      ["/settings/attendance", "Attendance rules"],
      ...(role === "admin" ? [["/settings/configuration", "Meeting configuration"], ["/settings/fingerprint-sharing", "Fingerprint sharing"], ["/settings/fingerprint-recovery", "Fingerprint recovery"], ["/settings/guided-setup", "Guided setup"]] as [string, string][] : []),
    ]} />
  </div>;
}
