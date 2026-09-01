import { RefObject, useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModalFocus(dialog: RefObject<HTMLElement | null>, active: boolean, busy: boolean, onEscape: () => void) {
  const busyRef = useRef(busy);
  const escapeRef = useRef(onEscape);
  busyRef.current = busy;
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); escapeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = items[0]; const last = items[items.length - 1]; const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialog.current?.contains(current))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    window.requestAnimationFrame(() => (focusable()[0] ?? dialog.current)?.focus());
    return () => { document.removeEventListener("keydown", keydown); previouslyFocused?.focus(); };
  }, [active, dialog]);
}
