export type KioskStateId = "ready" | "processing" | "welcome" | "goodbye" | "duplicate" | "rejected" | "unknown" | "scan_notice" | "rescan" | "offline" | "reader_offline" | "enroll_wait_first" | "enroll_scan_accepted" | "enroll_wait_second" | "enroll_success" | "enroll_failure" | "unpaired";
export type KioskDisplay = { id: KioskStateId; message: string; detail: string; tone: string; durationMs?: number; name?: string; meetingTitle?: string; notice?: string; updatedAt: string };
export const kioskStates: Readonly<Record<KioskStateId, Omit<KioskDisplay, "id" | "updatedAt">>>;
export function kioskState(id: KioskStateId, overrides?: Partial<KioskDisplay>): KioskDisplay;
export function kioskDisplayForAttendance(result?: { action?: "check_in" | "check_out"; duplicate?: boolean }): KioskDisplay;
export type ScanRefusal = { reason: "too_early" | "meeting_ended"; meetingTitle: string; time: string } | { reason: "no_meeting_today" | "already_done" } | { reason: "not_started_yet"; date: string };
export function scanRefusalFrom(body: unknown): ScanRefusal | undefined;
export function kioskDisplayForRefusal(refusal?: ScanRefusal): KioskDisplay | undefined;
export function kioskDisplayForQueuedScan(memberId: string, pending: { memberId: string }[]): KioskDisplay;
