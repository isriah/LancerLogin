import { MouseEvent, useEffect, useRef, useState } from "react";

const routeChangeEvent = "lancerlogin:route-change";
export const routeWillChangeEvent = "lancerlogin:route-will-change";

function routeChangeAllowed(next: string) { return window.dispatchEvent(new CustomEvent(routeWillChangeEvent, { cancelable: true, detail: { next } })); }

export function normalizePath(path: string) { const cleaned = path.replace(/\/+$/, "") || "/"; return cleaned === "/" ? "/dashboard" : cleaned === "/settings/privacy" ? "/settings/data" : cleaned; }

export function usePath() {
  const [location, setLocation] = useState(() => ({ path: normalizePath(window.location.pathname), search: window.location.search }));
  const current = useRef(location);
  useEffect(() => { current.current = location; }, [location]);
  useEffect(() => { if (window.location.pathname.replace(/\/+$/, "") === "/settings/privacy") window.history.replaceState({}, "", `${normalizePath(window.location.pathname)}${window.location.search}`); const update = () => { const next = { path: normalizePath(window.location.pathname), search: window.location.search }; current.current = next; setLocation(next); }; const pop = () => { const next = `${normalizePath(window.location.pathname)}${window.location.search}`; if (!routeChangeAllowed(next)) { window.history.pushState({}, "", `${current.current.path}${current.current.search}`); return; } update(); }; window.addEventListener("popstate", pop); window.addEventListener(routeChangeEvent, update); return () => { window.removeEventListener("popstate", pop); window.removeEventListener(routeChangeEvent, update); }; }, []);
  function navigate(next: string, replace = false) { const target = new URL(next, window.location.origin); const pathName = normalizePath(target.pathname); const destination = `${pathName}${target.search}`; if (!routeChangeAllowed(destination)) return; window.history[replace ? "replaceState" : "pushState"]({}, "", destination); window.dispatchEvent(new Event(routeChangeEvent)); window.scrollTo({ top: 0, behavior: "smooth" }); }
  return { ...location, navigate };
}

export function RouteLink({ href, currentPath, navigate, children, className = "", role }: { href: string; currentPath: string; navigate: (path: string) => void; children: React.ReactNode; className?: string; role?: React.AriaRole }) {
  const active = currentPath === href || (href !== "/dashboard" && currentPath.startsWith(`${href}/`));
  function click(event: MouseEvent<HTMLAnchorElement>) { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href); }
  return <a href={href} role={role === "row" ? undefined : role} onClick={click} className={`${className}${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>{children}</a>;
}
