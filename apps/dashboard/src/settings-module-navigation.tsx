import { useEffect, useRef, useState } from "react";
import { RouteLink } from "./router";

type ModuleNavigation = { id: string; label: string; links: [string, string][] };
type Props = {
  currentPath: string;
  navigate: (path: string) => void;
  attendanceReady: boolean;
  outreachReady: boolean;
  carpoolReady: boolean;
};

export function SettingsModuleNavigation({ currentPath, navigate, attendanceReady, outreachReady, carpoolReady }: Props) {
  const modules: ModuleNavigation[] = [
    ...(attendanceReady ? [{ id: "attendance", label: "Attendance", links: [
      ["/settings/attendance", "Attendance settings"],
      ["/settings/configuration", "Meeting configuration"],
      ["/settings/guided-setup", "Attendance Setup"],
    ] as [string, string][] }] : []),
    ...(outreachReady ? [{ id: "outreach", label: "Outreach", links: [["/settings/outreach-setup", "Outreach settings"]] as [string, string][] }] : []),
    ...(carpoolReady ? [{ id: "carpool", label: "Carpool", links: [["/settings/carpool", "Carpool settings"]] as [string, string][] }] : []),
  ];
  const activeModule = modules.find((module) => module.links.some(([href]) => currentPath === href || currentPath.startsWith(`${href}/`)))?.id;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => activeModule ? { [activeModule]: true } : {});
  const disclosure = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
    if (activeModule) setExpanded((current) => ({ ...current, [activeModule]: true }));
  }, [currentPath, activeModule]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !disclosure.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={disclosure} className="settings-module-disclosure" data-active={currentPath === "/settings/modules" || Boolean(activeModule)}>
    <button ref={toggle} className="settings-module-toggle" type="button" aria-expanded={open} aria-controls="settings-module-menu" onClick={() => setOpen((current) => !current)}>
      <span>Modules</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
    {open && <div className="settings-module-menu" id="settings-module-menu" role="group" aria-label="Module settings" onClick={(event) => { if ((event.target as Element).closest("a")) setOpen(false); }}>
      <RouteLink href="/settings/modules" currentPath={currentPath} navigate={navigate}>Manage modules</RouteLink>
      {modules.map((module) => module.links.length === 1 ? <RouteLink key={module.id} href={module.links[0]![0]} currentPath={currentPath} navigate={navigate}>{module.label}</RouteLink> : <div className="settings-module-group" key={module.id}>
        <button className="ui-button settings-module-branch" type="button" aria-expanded={Boolean(expanded[module.id])} aria-controls={`settings-module-${module.id}`} onClick={() => setExpanded((current) => ({ ...current, [module.id]: !current[module.id] }))}>
          <span>{module.label}</span><span aria-hidden="true">{expanded[module.id] ? "▴" : "▾"}</span>
        </button>
        {expanded[module.id] && <div className="settings-module-links" id={`settings-module-${module.id}`} role="group" aria-label={`${module.label} settings`}>
          {module.links.map(([href, label]) => <RouteLink key={href} href={href} currentPath={currentPath} navigate={navigate}>{label}</RouteLink>)}
        </div>}
      </div>)}
    </div>}
  </div>;
}
