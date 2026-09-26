import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./dashboard-api";
import { initialWalkthroughProgress, validWalkthroughProgress, walkthroughs, type WalkthroughPage, type WalkthroughProgress } from "../../../packages/shared/src/walkthrough";

export type WalkthroughStep = { id: string; title: string; description: string; targets: string; practice?: string };
export type WalkthroughExperienceDefinition = {
  pageId: Exclude<WalkthroughPage, "dashboard">;
  readySelector: string;
  returnFocusSelector: string;
  welcomeTitle: string;
  welcomeDescription: string;
  finishTitle: string;
  finishDescription: string;
  steps: WalkthroughStep[];
};
type Phase = "idle" | "welcome" | "active" | "complete";

export function usePageWalkthrough(pageId: WalkthroughPage, ready: boolean) {
  const [progress, setProgress] = useState(() => initialWalkthroughProgress(pageId));
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState("");
  const offered = useRef(false);
  const automaticStopped = useRef(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const writes = useRef(Promise.resolve());
  const definition = walkthroughs[pageId];

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void api<{ progress: WalkthroughProgress }>(`/auth/walkthroughs/${pageId}`).then((result) => {
      if (!validWalkthroughProgress(result.progress)) throw new Error("Invalid progress");
      if (current) { setProgress(result.progress); automaticStopped.current = ["completed", "dismissed"].includes(result.progress.status); setLoaded(true); setLoading(false); }
    }).catch(() => { if (current) { setLoaded(true); setLoading(false); setError("Could not load walkthrough progress. You can still use the walkthrough, but your progress may not be remembered across devices."); } });
    return () => { current = false; mounted.current = false; };
  }, [pageId]);

  useEffect(() => {
    if (!loaded || !ready || offered.current || phase !== "idle" || ["completed", "dismissed"].includes(progress.status)) return;
    const offer = () => {
      if (offered.current || document.querySelector('[role="dialog"], .primary-navigation.mobile-open')) return;
      offered.current = true;
      setPhase("welcome");
    };
    offer();
    const observer = new MutationObserver(offer);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "role"] });
    return () => observer.disconnect();
  }, [loaded, ready, phase, progress.status]);

  function save(status: WalkthroughProgress["status"], stepId: string | null) {
    // Replaying a completed or dismissed tour never opts the account back in.
    if (status === "in_progress" && automaticStopped.current) status = "dismissed";
    if (["completed", "dismissed"].includes(status)) automaticStopped.current = true;
    const next = { pageId, version: definition.version, status, stepId };
    setProgress(next);
    // Serialize writes so rapid Next/Exit cannot overwrite the most recent step.
    writes.current = writes.current.then(async () => {
      // Never send a queued preference under a later signed-in session.
      if (!mounted.current) return;
      try {
        await api(`/auth/walkthroughs/${pageId}`, { method: "PATCH", body: JSON.stringify({ version: next.version, status, stepId }), keepalive: true });
        if (mounted.current) setError("");
      } catch {
        if (mounted.current) setError("Could not save walkthrough progress. It may not be remembered across devices. You can keep going or exit.");
      }
    });
  }
  function start(restart = false) {
    const savedIndex = (definition.steps as readonly string[]).indexOf(progress.stepId ?? "");
    const index = !restart && ["in_progress", "dismissed"].includes(progress.status) && savedIndex >= 0 ? savedIndex : 0;
    setStepIndex(index); setPhase("active"); save("in_progress", definition.steps[index]);
  }
  function move(index: number) {
    if (index >= definition.steps.length) { save("completed", definition.steps.at(-1)!); setPhase("complete"); }
    else { setStepIndex(index); save("in_progress", definition.steps[index]); }
  }
  function exit() { offered.current = true; setPhase("idle"); }
  function dismiss() { save("dismissed", progress.stepId); exit(); }
  function reset() {
    automaticStopped.current = false;
    offered.current = true;
    setStepIndex(0);
    setPhase("welcome");
    save("not_started", null);
  }
  const canResume = ["in_progress", "dismissed"].includes(progress.status) && progress.stepId !== null;
  return { phase, stepIndex, progress, error, loading, canResume, start, move, exit, dismiss, reset };
}

export function WalkthroughDebugReset({ debugMode, disabled, onReset }: { debugMode: boolean; disabled: boolean; onReset: () => void }) {
  if (!debugMode) return null;
  return <button className="ui-button walkthrough-debug-reset" type="button" disabled={disabled} onClick={onReset}>Reset page walkthrough</button>;
}

function useReadySelector(selector: string) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const check = () => setReady(Boolean(document.querySelector(selector)));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-walkthrough-ready"] });
    return () => observer.disconnect();
  }, [selector]);
  return ready;
}

export function PageWalkthroughExperience({ definition, debugMode, onStateChange, renderStepAction }: { definition: WalkthroughExperienceDefinition; debugMode: boolean; onStateChange: (state: { open: boolean; navigation: boolean }) => void; renderStepAction?: (step: WalkthroughStep) => ReactNode }) {
  const ready = useReadySelector(definition.readySelector);
  const walkthrough = usePageWalkthrough(definition.pageId, ready);
  const active = walkthrough.phase === "active";
  const step = active ? definition.steps[walkthrough.stepIndex] : undefined;
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = walkthrough.phase !== "idle";
    onStateChange({ open, navigation: false });
    if (!open && wasOpen.current) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(definition.returnFocusSelector)?.focus({ preventScroll: true }));
    wasOpen.current = open;
  }, [walkthrough.phase, definition.returnFocusSelector, onStateChange]);
  useEffect(() => () => onStateChange({ open: false, navigation: false }), [onStateChange]);
  return <>
    {walkthrough.error && walkthrough.phase === "idle" && <p className="ui-status walkthrough-page-status" data-tone="error" role="status">{walkthrough.error}</p>}
    {ready && walkthrough.phase === "idle" && !walkthrough.loading && <WalkthroughDebugReset debugMode={debugMode} disabled={false} onReset={walkthrough.reset} />}
    {walkthrough.phase !== "idle" && <WalkthroughPanel step={step} onExit={walkthrough.exit} label={step ? `${definition.welcomeTitle} walkthrough` : walkthrough.phase === "complete" ? "Walkthrough complete" : definition.welcomeTitle}>
      {walkthrough.phase === "welcome" ? <>
        <h2 data-walkthrough-focus tabIndex={-1}>{definition.welcomeTitle}</h2>
        <p>{definition.welcomeDescription}</p>
        <div className="walkthrough-actions"><button className="ui-button ui-button--primary" type="button" onClick={() => walkthrough.start()}>{walkthrough.canResume ? "Resume walkthrough" : "Start walkthrough"}</button>{walkthrough.canResume && <button className="ui-button" type="button" onClick={() => walkthrough.start(true)}>Start over</button>}<button className="ui-button" type="button" onClick={walkthrough.exit}>Not now</button><button className="ui-button" type="button" onClick={walkthrough.dismiss}>Don't show automatically again</button></div>
      </> : walkthrough.phase === "complete" ? <>
        <h2 data-walkthrough-focus tabIndex={-1}>{definition.finishTitle}</h2>
        <p>{definition.finishDescription}</p>
        <div className="walkthrough-actions"><button className="ui-button ui-button--primary" type="button" onClick={walkthrough.exit}>Done</button></div>
      </> : step && <>
        <p className="walkthrough-progress" role="status">Step {walkthrough.stepIndex + 1} of {definition.steps.length}</p>
        <h2 data-walkthrough-focus tabIndex={-1}>{step.title}</h2>
        <p>{step.description}</p>
        {renderStepAction?.(step)}
        <div className="walkthrough-actions"><button className="ui-button" type="button" disabled={walkthrough.stepIndex === 0} onClick={() => walkthrough.move(walkthrough.stepIndex - 1)}>Back</button><button className="ui-button ui-button--primary" type="button" onClick={() => walkthrough.move(walkthrough.stepIndex + 1)}>Next</button><button className="ui-button" type="button" onClick={walkthrough.exit}>Exit</button><button className="ui-button" type="button" onClick={walkthrough.dismiss}>Don't show automatically again</button></div>
      </>}
      {walkthrough.error && <p className="ui-status" data-tone="error" role="status">{walkthrough.error}</p>}
    </WalkthroughPanel>}
  </>;
}

const focusSelector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const findTargets = (selectors: string) => selectors.split(",").flatMap((selector) => { const target = document.querySelector<HTMLElement>(selector.trim()); return target ? [target] : []; });
const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";

/** One focus boundary spans the explanation and the permitted practice controls. */
export function WalkthroughPanel({ step, onExit, children, label }: { step?: WalkthroughStep; onExit: () => void; children: ReactNode; label: string }) {
  const panel = useRef<HTMLElement>(null);
  const exitRef = useRef(onExit); exitRef.current = onExit;
  const [placement, setPlacement] = useState<{ top: number; left: number }>();
  const [rects, setRects] = useState<{ top: number; left: number; width: number; height: number }[]>([]);
  const [ownedIds, setOwnedIds] = useState<string>();

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = panel.current!;
    const allowed = [root, ...(step?.practice ? Array.from(document.querySelectorAll<HTMLElement>(step.practice)).filter(visible) : [])];
    const assignedIds: HTMLElement[] = [];
    setOwnedIds(allowed.slice(1).map((element, index) => {
      if (!element.id) { element.id = `walkthrough-practice-${index}`; assignedIds.push(element); }
      return element.id;
    }).join(" ") || undefined);
    const changed: HTMLElement[] = [];
    const isolate = (parent: HTMLElement) => {
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement) || allowed.includes(child)) continue;
        if (allowed.some((item) => child.contains(item))) isolate(child);
        else if (!child.inert) { child.inert = true; changed.push(child); }
      }
    };
    isolate(document.body);
    const focusables = () => allowed.flatMap((item) => [ ...(item.matches(focusSelector) ? [item] : []), ...Array.from(item.querySelectorAll<HTMLElement>(focusSelector)) ]).filter((item) => visible(item) && !item.closest("[inert]"));
    const focus = () => root.querySelector<HTMLElement>("[data-walkthrough-focus]")?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); exitRef.current(); }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); root.focus(); return; }
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const nextIndex = index < 0 ? event.shiftKey ? items.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    const focusin = (event: FocusEvent) => { if (!allowed.some((item) => item.contains(event.target as Node))) focus(); };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    focus();
    return () => {
      changed.forEach((item) => { item.inert = false; });
      assignedIds.forEach((item) => item.removeAttribute("id"));
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [step?.id]);

  useLayoutEffect(() => {
    const root = panel.current!;
    let targets = step ? findTargets(step.targets).filter(visible) : [];
    // Scroll the target, never the focused explanation, into the available space.
    targets[0]?.scrollIntoView({ block: innerWidth <= 760 ? "start" : "center", behavior: "instant" });
    const position = () => {
      const bounds = targets.filter(visible).map((target) => target.getBoundingClientRect());
      setRects(bounds.map(({ top, left, width, height }) => ({ top, left, width, height })));
      if (innerWidth <= 760) { setPlacement(undefined); return; }
      const gap = Number.parseFloat(getComputedStyle(root).rowGap) || 0; const width = root.offsetWidth; const height = root.offsetHeight;
      const anchor = bounds[0];
      let left = (innerWidth - width) / 2; let top = (innerHeight - height) / 2;
      if (anchor) {
        left = anchor.right + gap + width <= innerWidth ? anchor.right + gap : anchor.left - width - gap >= 0 ? anchor.left - width - gap : innerWidth - width - gap;
        top = anchor.bottom + gap + height <= innerHeight ? anchor.bottom + gap : anchor.top - height - gap >= 0 ? anchor.top - height - gap : gap;
      }
      setPlacement({ left: Math.max(gap, Math.min(left, innerWidth - width - gap)), top: Math.max(gap, Math.min(top, innerHeight - height - gap)) });
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(root); targets.forEach((target) => observer.observe(target));
    // Saved-report creation can replace the highlighted workspace mid-step.
    const mutations = new MutationObserver(() => {
      const next = step ? findTargets(step.targets).filter(visible) : [];
      if (next.length === targets.length && next.every((target, index) => target === targets[index])) return;
      targets.forEach((target) => observer.unobserve(target));
      targets = next;
      targets.forEach((target) => observer.observe(target));
      targets[0]?.scrollIntoView({ block: innerWidth <= 760 ? "start" : "center", behavior: "instant" });
      position();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { mutations.disconnect(); observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [step?.id]);

  return <>
    <div className="walkthrough-shade" aria-hidden="true" />
    {rects.map((rect, index) => <div key={index} className="walkthrough-highlight" style={rect} aria-hidden="true" />)}
    <section ref={panel} className="walkthrough-panel ui-card" role="dialog" aria-modal="true" aria-label={label} aria-owns={ownedIds} tabIndex={-1} style={placement}>{children}</section>
  </>;
}
