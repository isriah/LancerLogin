import { type AnchorHTMLAttributes, MouseEvent, useEffect, useRef, useState } from "react";

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

type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };
/** True for a click the browser should handle itself: a middle or other button, or Ctrl, Cmd, Shift or Alt (new tab, new window, download). */
export function isModifiedClick(event: ClickLike) { return Boolean(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey); }
/**
 * Click handler for an in-app `<a href>`: a plain left click runs `go` in place of loading the page, while modified and
 * middle clicks keep the browser's link behavior, so Ctrl/Cmd-click and "Open link in new tab" open `href` elsewhere.
 */
export function followInApp(event: MouseEvent<HTMLAnchorElement>, go: () => void) { if (isModifiedClick(event)) return; event.preventDefault(); go(); }

/**
 * Click and auxclick handler for a clickable row whose record link (`href`) is also a real anchor inside it. A plain
 * click runs `go`; Ctrl/Cmd-click and middle-click open `href` in a new tab like the link would, and other modified
 * clicks leave this page alone. Clicks on the row's own links and controls are theirs to handle.
 */
export function followRowInApp(event: MouseEvent<HTMLElement>, href: string, go: () => void) {
  if ((event.target as Element).closest("a, button, input, select, textarea, label, summary")) return;
  if (!isModifiedClick(event)) { if (event.type === "click") go(); return; }
  if (event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0)) window.open(href, "_blank", "noopener");
}

/** An anchor to an in-app page that navigates in place on a plain click. Use it for anything that opens a record or page. */
export function AppLink({ href, navigate, onClick, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; navigate: (path: string) => void }) {
  return <a {...props} href={href} onClick={(event) => { onClick?.(event); followInApp(event, () => navigate(href)); }} />;
}

export function RouteLink({ href, currentPath, navigate, children, className = "", role }: { href: string; currentPath: string; navigate: (path: string) => void; children: React.ReactNode; className?: string; role?: React.AriaRole }) {
  const active = currentPath === href || (href !== "/dashboard" && currentPath.startsWith(`${href}/`));
  return <a href={href} role={role === "row" ? undefined : role} onClick={(event) => followInApp(event, () => navigate(href))} className={`${className}${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>{children}</a>;
}
