import type { ReactNode } from "react";

// Admin-only kiosk investigation panels, shown while Debug mode is on. Each child is one panel, so adding a panel is one
// more child where KiosksPage renders this section. Panels never change attendance on their own.
export function KioskDebugTools({ children }: { children: ReactNode }) {
  return <section className="kiosk-debug-tools" aria-labelledby="kiosk-debug-tools-title">
    <div className="kiosk-debug-tools-heading"><h2 id="kiosk-debug-tools-title">Debug tools</h2><p>Shown because Debug mode is on. Use these to investigate how kiosks match and reject scans.</p></div>
    <div className="kiosk-debug-panels">{children}</div>
  </section>;
}
