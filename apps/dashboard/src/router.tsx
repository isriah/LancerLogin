import { MouseEvent, useEffect, useState } from "react";

export function normalizePath(path: string) { const cleaned = path.replace(/\/+$/, "") || "/"; return cleaned === "/" ? "/dashboard" : cleaned; }

export function usePath() {
  const [location, setLocation] = useState(() => ({ path: normalizePath(window.location.pathname), search: window.location.search }));
  useEffect(() => { const update = () => setLocation({ path: normalizePath(window.location.pathname), search: window.location.search }); window.addEventListener("popstate", update); return () => window.removeEventListener("popstate", update); }, []);
  function navigate(next: string, replace = false) { const target = new URL(next, window.location.origin); const pathName = normalizePath(target.pathname); window.history[replace ? "replaceState" : "pushState"]({}, "", `${pathName}${target.search}`); setLocation({ path: pathName, search: target.search }); window.scrollTo({ top: 0, behavior: "smooth" }); }
  return { ...location, navigate };
}

export function RouteLink({ href, currentPath, navigate, children, className = "" }: { href: string; currentPath: string; navigate: (path: string) => void; children: React.ReactNode; className?: string }) {
  const active = currentPath === href || (href !== "/dashboard" && currentPath.startsWith(`${href}/`));
  function click(event: MouseEvent<HTMLAnchorElement>) { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href); }
  return <a href={href} onClick={click} className={`${className}${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>{children}</a>;
}
