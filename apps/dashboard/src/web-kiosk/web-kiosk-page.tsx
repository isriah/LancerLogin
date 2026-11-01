// The web kiosk at /kiosk: a standalone page with no dashboard shell or sign-in. It pairs with a one-time code and
// then works as an attendance kiosk, calling the dashboard's API base with its own kiosk token.
// It can be installed as an app and starts without a network (kiosk-install.ts, public/kiosk-sw.js).
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiBaseUrl } from "../dashboard-api.ts";
import { dashboardReleaseVersion } from "../hardware-pairing-key.ts";
import { createKioskApi } from "./kiosk-api.ts";
import { createIndexedDbStore, createMemoryStore, kioskStorageBlockedEvent, type KioskStore, type StoredPairing } from "./kiosk-store.ts";
import { kioskBrandStyle } from "./kiosk-flow.ts";
import { PairingScreen } from "./pairing-screen.tsx";
import { AttendanceScreen } from "./attendance-screen.tsx";
import { CenteredMessage, KioskFrame } from "./kiosk-parts.tsx";
import { installKioskApp } from "./kiosk-install.ts";
import "./web-kiosk.css";

export const needsPairingAgainMessage = "This kiosk needs pairing again";

type Phase = { name: "loading"; blocked?: boolean } | { name: "pairing"; notice?: string } | { name: "paired"; pairing: StoredPairing } | { name: "storage_failed" };

export function WebKioskPage({ store, baseUrl = apiBaseUrl }: { store: KioskStore; baseUrl?: string }) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  useEffect(() => {
    let current = true;
    const blocked = () => { if (current) setPhase((previous) => previous.name === "loading" ? { name: "loading", blocked: true } : previous); };
    globalThis.addEventListener?.(kioskStorageBlockedEvent, blocked);
    store.load().then((pairing) => { if (current) setPhase(pairing ? { name: "paired", pairing } : { name: "pairing" }); }, () => { if (current) setPhase({ name: "storage_failed" }); });
    return () => { current = false; globalThis.removeEventListener?.(kioskStorageBlockedEvent, blocked); };
  }, [store]);

  const pairing = phase.name === "paired" ? phase.pairing : undefined;
  const token = pairing?.kioskToken;
  const api = useMemo(() => token ? createKioskApi({ baseUrl, token }) : undefined, [baseUrl, token]);
  const changePairing = useCallback(async (next: StoredPairing) => { await store.save(next); setPhase({ name: "paired", pairing: next }); }, [store]);
  const unpair = useCallback(async () => { await store.clear(); setPhase({ name: "pairing" }); }, [store]);
  // The server no longer accepts this credential (the kiosk was retired or replaced): forget it and ask to pair again.
  const rejected = useCallback(() => { void store.clear().catch(() => undefined).finally(() => setPhase({ name: "pairing", notice: needsPairingAgainMessage })); }, [store]);

  let content;
  if (phase.name === "pairing") content = <PairingScreen baseUrl={baseUrl} store={store} notice={phase.notice} onPaired={(next) => setPhase({ name: "paired", pairing: next })} />;
  else if (phase.name === "paired" && api) return <AttendanceScreen key={phase.pairing.kioskId} api={api} store={store} pairing={phase.pairing} releaseVersion={dashboardReleaseVersion} onPairingChange={changePairing} onUnpair={unpair} onCredentialRejected={rejected} />;
  else if (phase.name === "storage_failed") content = <KioskFrame brand={{ organizationName: "LancerLogin" }}><CenteredMessage title="This browser can't store the kiosk's pairing" detail="Open this page in a normal (not private) window, and allow this site to store data." /></KioskFrame>;
  else if (phase.name === "loading" && phase.blocked) content = <KioskFrame brand={{ organizationName: "LancerLogin" }}><CenteredMessage title="Close the kiosk's other tab" detail="The kiosk page is open in another tab or window on this device. Close it, and this kiosk continues by itself." /></KioskFrame>;
  else content = <KioskFrame brand={{ organizationName: "LancerLogin" }}><CenteredMessage title="Starting the kiosk" /></KioskFrame>;
  return <div className="wk-root" style={kioskBrandStyle()} data-step={phase.name}>{content}</div>;
}

function browserStore(): KioskStore {
  try { if (globalThis.indexedDB) return createIndexedDbStore(globalThis.indexedDB); } catch { /* fall through */ }
  return createMemoryStore();
}

export function mountWebKiosk(container: HTMLElement) {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.classList.add("wk-document");
  installKioskApp(dashboardReleaseVersion);
  createRoot(container).render(<StrictMode><WebKioskPage store={browserStore()} /></StrictMode>);
}
