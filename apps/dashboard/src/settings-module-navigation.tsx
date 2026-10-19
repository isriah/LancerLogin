import { useEffect, useRef, useState } from "react";
import { RouteLink } from "./router";

type ModuleNavigation = { id: string; label: string; href: string; paths?: string[] };
type Props = {
  currentPath: string;
  navigate: (path: string) => void;
  attendanceReady: boolean;
  outreachReady: boolean;
  carpoolReady: boolean;
};

export function SettingsModuleNavigation({ currentPath, navigate, attendanceReady, outreachReady, carpoolReady }: Props) {
  const modules: ModuleNavigation[] = [
    ...(attendanceReady ? [{ id: "attendance", label: "Attendance", href: "/settings/attendance", paths: ["/settings/configuration", "/settings/guided-setup", "/settings/fingerprint-sharing", "/settings/fingerprint-recovery"] }] : []),
    ...(outreachReady ? [{ id: "outreach", label: "Outreach", href: "/settings/outreach-setup" }] : []),
    ...(carpoolReady ? [{ id: "carpool", label: "Carpool", href: "/settings/carpool" }] : []),
  ];
  const activeModule = modules.find((module) => [module.href, ...(module.paths ?? [])].some((href) => currentPath === href || currentPath.startsWith(`${href}/`)))?.id;
  const [open, setOpen] = useState(false);
  const disclosure = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
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
      {modules.map((module) => <RouteLink key={module.id} href={module.href} currentPath={activeModule === module.id ? module.href : currentPath} navigate={navigate}>{module.label}</RouteLink>)}
    </div>}
  </div>;
}
