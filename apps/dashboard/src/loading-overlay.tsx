import { useEffect } from "react";

export function useDashboardLoadingOverlay(loading: boolean, label = "Loading dashboard content…") {
  useEffect(() => {
    if (!loading) return;
    const overlay = document.createElement("div");
    overlay.className = "dashboard-loading-overlay";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-atomic", "true");
    const indicator = document.createElement("span");
    indicator.className = "dashboard-loading-indicator";
    indicator.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    overlay.append(indicator, text);
    const content = document.getElementById("dashboard-content");
    content?.setAttribute("aria-busy", "true");
    document.querySelector(".app")?.append(overlay);
    return () => { overlay.remove(); content?.removeAttribute("aria-busy"); };
  }, [label, loading]);
}
