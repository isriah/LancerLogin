import { routeWillChangeEvent } from "./router";
import type { PendingMeetingDeletion } from "./meeting-management";

let pending: PendingMeetingDeletion | undefined;

/** A single in-memory handoff from the deleted detail to its confirmation page. */
export function handoffMeetingDeletion(deletion: PendingMeetingDeletion): void {
  pending = deletion;
  window.addEventListener(routeWillChangeEvent, (event) => {
    if ((event as CustomEvent<{ next: string }>).detail.next !== "/dashboard") pending = undefined;
    queueMicrotask(() => { if (event.defaultPrevented) pending = undefined; });
  }, { once: true });
}

export function readMeetingDeletion(): PendingMeetingDeletion | undefined { return pending; }
export function clearMeetingDeletion(): void { pending = undefined; }
