import { RefObject, useEffect, useRef, useState } from "react";

const focusableSelector = [
  "a[href]",
  "summary",
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
      .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden], [aria-hidden='true'], fieldset[disabled]"));
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
    window.requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? focusable()[0] ?? dialog.current)?.focus());
    return () => { document.removeEventListener("keydown", keydown); previouslyFocused?.focus(); };
  }, [active, dialog]);
}

/**
 * Moves focus to a message that the same state update is about to render, such as the error from a failed save.
 * Call the returned function next to the state change, with the message’s id or a function that returns its element.
 * Focus moves once React has rendered that update. A requestAnimationFrame callback can run first when the update
 * follows an await, find no element, and leave focus where it was.
 */
export function useFocusAfterRender() {
  const [request, setRequest] = useState<{ find: () => HTMLElement | null }>();
  // An effect, not a layout effect: a dialog closed by the same update returns focus in its effect cleanup, which runs first.
  useEffect(() => { request?.find()?.focus(); }, [request]);
  return useRef((target: string | (() => HTMLElement | null)) => setRequest({ find: typeof target === "string" ? () => document.getElementById(target) : target })).current;
}

/** Focuses an error message after React commits it. A requestAnimationFrame callback can run before the message renders. */
export function useErrorFocus(id: string) {
  const [request, setRequest] = useState(0);
  useEffect(() => { if (request) document.getElementById(id)?.focus(); }, [id, request]);
  return () => setRequest((count) => count + 1);
}
