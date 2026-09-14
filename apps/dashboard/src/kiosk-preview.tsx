import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { kioskStyles } from "../../kiosk/src/ui.mjs";
import type { KioskDisplay } from "../../kiosk/src/kiosk-presentation.mjs";
import type { Branding } from "./setup-workspace";
import { AdaptiveBrandLogo } from "./adaptive-brand-logo";

// A shadow root keeps the physical screen's stylesheet out of dashboard controls.
export function KioskPreview({ branding, display, name, meetingTitle }: { branding: Branding; display: KioskDisplay; name?: string; meetingTitle?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot>();
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = host.current!;
    setRoot(element.shadowRoot ?? element.attachShadow({ mode: "open" }));
    const measure = () => setScale(element.getBoundingClientRect().width / 800);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const style = { "--primary": branding.primaryColor, "--primary-color": branding.primaryColor, "--secondary": branding.secondaryColor, "--accent-color": branding.secondaryColor } as CSSProperties;
  return <div ref={host} className="simulator-kiosk" style={style}>{root && createPortal(<>
    <style>{kioskStyles.replace(":root", ":host").replace(/html,body\{[^}]+\}/, "").replace("@media(max-height:520px)", "@container(max-height:520px)") + ":host{container-type:size}.kiosk-shell{width:800px;height:480px;min-height:0;transform-origin:top left}"}</style>
    <div className={`kiosk-shell kiosk-shell-${display.id}`} style={{ transform: `scale(${scale})` }}>
      <header className="kiosk-brand"><span id="brand-name">{branding.organizationName}</span>{branding.logoData ? <AdaptiveBrandLogo src={branding.logoData} alt="Organization logo" backdrop={branding.logoBackdrop} /> : <span />}<strong>{branding.subtitle}</strong></header>
      <section className={`scan-panel scan-panel-${display.id}`} aria-live="polite" aria-labelledby="simulator-display-title"><div className="reader-mark" aria-hidden="true" /><h1 id="simulator-display-title">{display.message}</h1>{name && <p id="display-name">{name}</p>}<p>{display.detail}</p>{meetingTitle && <p id="display-meeting">{meetingTitle}</p>}</section>
      <footer className="debug-status"><span>Browser input ready</span><span>No scans waiting</span><span>Not a physical kiosk</span></footer>
    </div>
  </>, root)}</div>;
}
