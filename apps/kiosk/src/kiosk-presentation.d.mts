export type KioskStateId = "ready" | "processing" | "welcome" | "goodbye" | "duplicate" | "rejected" | "unknown" | "offline" | "reader_offline" | "enroll_wait_first" | "enroll_scan_accepted" | "enroll_wait_second" | "enroll_success" | "enroll_failure" | "unpaired";
export type KioskDisplay = { id: KioskStateId; message: string; detail: string; tone: string; durationMs?: number; name?: string; meetingTitle?: string; updatedAt: string };
export const kioskStates: Readonly<Record<KioskStateId, Omit<KioskDisplay, "id" | "updatedAt">>>;
export function kioskState(id: KioskStateId, overrides?: Partial<KioskDisplay>): KioskDisplay;
export function kioskDisplayForAttendance(result?: { action?: "check_in" | "check_out"; duplicate?: boolean }): KioskDisplay;
