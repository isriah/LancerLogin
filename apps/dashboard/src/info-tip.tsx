import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";

const VIEWPORT_MARGIN = 16;
const TOOLTIP_GAP = 8;
const TOOLTIP_MAX_WIDTH = 320;

export function InfoTip({ children, label = "More information" }: { children: React.ReactNode; label?: string }) {
  const [active, setActive] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN });
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const activationPointer = useRef("");
  const open = active || pinned;

  const updatePosition = useCallback(() => {
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = Math.min(TOOLTIP_MAX_WIDTH, Math.max(0, viewportWidth - (VIEWPORT_MARGIN * 2)));
    const height = content.current?.getBoundingClientRect().height ?? 0;
    const centeredLeft = anchor.left + (anchor.width / 2) - (width / 2);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, centeredLeft), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));
    const below = anchor.bottom + TOOLTIP_GAP;
    const above = anchor.top - TOOLTIP_GAP - height;
    const top = below + height <= viewportHeight - VIEWPORT_MARGIN
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, Math.min(below, viewportHeight - height - VIEWPORT_MARGIN));
    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && root.current?.contains(event.target as Node)) return;
      setActive(false);
      setPinned(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
    };
  }, [open, updatePosition]);

  const leaveFocus = (event: FocusEvent<HTMLSpanElement>) => {
    if (root.current?.contains(event.relatedTarget as Node)) return;
    setActive(false);
    setPinned(false);
  };
  const style = {
    "--info-tip-left": `${position.left}px`,
    "--info-tip-top": `${position.top}px`,
  } as CSSProperties;

  return <span
    ref={root}
    className="info-tip"
    data-open={open || undefined}
    style={style}
    onFocusCapture={() => { updatePosition(); setActive(true); }}
    onBlurCapture={leaveFocus}
  >
    <button
      ref={button}
      type="button"
      className="info-tip-button"
      aria-label={label}
      aria-describedby={id}
      aria-expanded={open}
      onPointerDown={(event) => { activationPointer.current = event.pointerType; }}
      onPointerCancel={() => { activationPointer.current = ""; }}
      onClick={(event) => {
        const pointerType = activationPointer.current;
        activationPointer.current = "";
        updatePosition();
        if (pointerType === "touch" || pointerType === "pen") {
          setActive(false);
          setPinned((value) => !value);
          return;
        }
        setPinned(false);
        setActive(!pointerType && event.detail === 0 && button.current === document.activeElement);
      }}
    ><span className="info-tip-glyph" aria-hidden="true" onMouseEnter={() => { updatePosition(); setActive(true); }} onMouseLeave={() => setActive(false)}>i</span></button>
    <span ref={content} id={id} className="info-tip-content" role="tooltip">{children}</span>
  </span>;
}

export function InfoHeading({ children, info, id }: { children: React.ReactNode; info: React.ReactNode; id?: string }) {
  return <div className="info-heading"><h2 id={id}>{children}</h2><InfoTip>{info}</InfoTip></div>;
}
