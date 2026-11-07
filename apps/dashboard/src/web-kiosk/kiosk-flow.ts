// The web kiosk's screen logic, kept free of React and the browser so it can be tested on its own: reading the pairing
// code from the address, the attendance steps (entry or search, confirm, sending, result) and how API answers display.
import type { CSSProperties } from "react";
import { kioskDisplayForAttendance, kioskDisplayForQueuedScan, kioskState, type KioskDisplay } from "../../../kiosk/src/kiosk-presentation.mjs";
import { findMemberById, membersUseNumericIds } from "../../../../packages/shared/src/member-lookup.mjs";
import { normalizePairingCode, pairingCodeAlphabet, validWebPairingCode } from "../../../../packages/shared/src/pairing-code.mjs";
import { brandTheme } from "../theme.ts";
import { KioskApiError, KioskNetworkError, type AttendanceResult, type KioskConfig, type KioskSettings, type PinRequest, type PinRequestStatus, type RosterMember } from "./kiosk-api.ts";
import type { ScanFate } from "./kiosk-sync.ts";
import type { PinOutcome } from "./member-pin.ts";

export const confirmTimeoutMs = 15_000;
export const maintenanceHoldMs = 3_000;
export const configRefreshMs = 60_000;
export const rosterRefreshMs = 5 * 60_000;
export const heartbeatMs = 60_000;
export const commandPollMs = 10_000;
export const maxEntryLength = 40;
export const maxSearchResults = 6;

// ---- Pairing ----

/** The pairing code in a `#code=K7Q2M9XD` address fragment, normalized, or undefined when there is none. */
export function pairingCodeFromHash(hash: string) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("code");
  const code = normalizePairingCode(value ?? "");
  return code || undefined;
}

export const wrongPairingCodeMessage = "That code is wrong or expired. Create a new one on the Kiosks page.";
export const unreachableMessage = "Couldn't reach the server. Check the connection and try again.";

/** What to tell the person pairing, before sending (`undefined` when the code looks right) or after a refusal. */
export function pairingCodeProblem(code: string) {
  if (!normalizePairingCode(code)) return "Enter the 8-character code from the Kiosks page.";
  return validWebPairingCode(code) ? undefined : wrongPairingCodeMessage;
}
export function pairingErrorMessage(error: unknown) {
  if (error instanceof KioskNetworkError) return unreachableMessage;
  if (error instanceof KioskApiError && error.status === 429) return "Too many tries. Wait a few minutes, then try again.";
  if (error instanceof KioskApiError && error.status >= 500) return "The server couldn't pair this kiosk right now. Try again in a minute.";
  return wrongPairingCodeMessage;
}

/** Only the characters a pairing code can contain (no 0, O, 1 or I), uppercase: "k7q2-m90x" is "K7Q2M9X". */
export const pairingCodeCharacters = (input: string) => [...normalizePairingCode(input)].filter((character) => pairingCodeAlphabet.includes(character)).join("");

// ---- Physical keyboard ----

/** What a field accepts from a physical keyboard: digits only (PINs, numeric member IDs), pairing code characters, or any text. */
export type KeyCharset = "digits" | "pairing" | "text";
export type PhysicalKey = { type: "character"; character: string } | { type: "backspace" } | { type: "enter" } | { type: "escape" };
type KeyEventLike = { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean };

/**
 * A physical key press as a kiosk action, or undefined when the kiosk ignores it: shortcuts (Ctrl, Alt or Meta), keys
 * like Tab or the arrows, and characters the field can't take. Pairing code characters come back uppercase.
 */
export function physicalKeyFor(event: KeyEventLike, charset: KeyCharset): PhysicalKey | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return undefined;
  if (event.key === "Backspace") return { type: "backspace" };
  if (event.key === "Enter") return { type: "enter" };
  if (event.key === "Escape") return { type: "escape" };
  if ([...event.key].length !== 1) return undefined;
  if (charset === "digits") return /^\d$/.test(event.key) ? { type: "character", character: event.key } : undefined;
  if (charset === "pairing") {
    const character = event.key.toUpperCase();
    return pairingCodeAlphabet.includes(character) ? { type: "character", character } : undefined;
  }
  return /^[\p{L}\p{N}\p{P}\p{S} ]$/u.test(event.key) ? { type: "character", character: event.key } : undefined;
}

/** The settings PIN typed twice: what's wrong with it, or undefined when it can be saved. */
export function settingsPinProblem(first: string, second: string) {
  if (!/^\d{6,12}$/.test(first)) return "Choose 6 to 12 digits.";
  if (first !== second) return "The two PINs don't match. Choose a PIN again.";
  return undefined;
}

// ---- Configuration ----

export type MemberLookup = "entry" | "search";
export const memberLookupFor = (config?: KioskConfig) => config?.settings?.memberLookup === "search" ? "search" : "entry";
/** A big numeric keypad when every member ID is digits, otherwise the on-screen keyboard. */
export const entryInputFor = (roster: readonly RosterMember[]) => membersUseNumericIds(roster) ? "keypad" : "keyboard";

const defaultPrimary = "#146c5b";
const defaultSecondary = "#dba72d";
const hexColor = (value: string | undefined, fallback: string) => value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
/** The installation's branding colors as CSS variables, with the dashboard's own colors when none are set. */
export function kioskBrandStyle(settings?: KioskSettings | null): CSSProperties {
  return brandTheme(hexColor(settings?.primaryColor, defaultPrimary), hexColor(settings?.secondaryColor, defaultSecondary));
}

/** A config change that needs a fresh roster: the lookup decides whether emails come with it. */
export const rosterChanged = (before: KioskConfig | undefined, after: KioskConfig) => memberLookupFor(before) !== memberLookupFor(after) || before?.settings?.authenticationMethod !== after.settings?.authenticationMethod
  // Require PIN decides whether PIN hashes come with it.
  || (before?.settings?.requirePin === true) !== (after.settings?.requirePin === true);

// ---- Attendance steps ----

export type KioskMember = { memberId: string; firstName: string; lastName: string };
/** Where Confirm leads at a Require PIN kiosk: the PIN keypad, "You don't have a PIN yet", or refused while locked. */
export type PinStart = { kind: "entry" } | { kind: "none" } | { kind: "locked"; lockedUntil?: string };
/**
 * The attendance steps. With Require PIN, Confirm leads to `pin` (or `no_pin`, or `pin_locked`), and the scan is sent
 * after Enter. A member with no PIN asks for approval (`no_pin`, then `waiting`), and once an Operator approves chooses
 * one, typed twice (`choose_pin`), before the scan is sent.
 */
export type Flow =
  | { step: "entry"; text: string }
  | { step: "confirm"; member: KioskMember; back: string }
  | { step: "pin"; member: KioskMember }
  | { step: "wrong_pin"; member: KioskMember; lockedUntil?: string; attemptsLeft?: number }
  | { step: "pin_locked"; member: KioskMember; lockedUntil?: string }
  | { step: "no_pin"; member: KioskMember; asking?: boolean; error?: string }
  | { step: "waiting"; member: KioskMember; requestId: string; expiresAt: string }
  | { step: "choose_pin"; member: KioskMember; requestId: string; first?: string; error?: string }
  | { step: "sending"; member: KioskMember }
  | { step: "result"; display: KioskDisplay };
export type FlowAction =
  | { type: "key"; key: string }
  | { type: "set"; text: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "submit"; roster: readonly RosterMember[] }
  | { type: "pick"; member: KioskMember }
  | { type: "not_me" }
  | { type: "confirm"; pin?: PinStart }
  | { type: "pin_entered" }
  | { type: "pin_refused"; outcome: PinOutcome }
  | { type: "try_again" }
  | { type: "ask" }
  | { type: "asked"; request: PinRequest }
  | { type: "ask_failed"; message: string }
  | { type: "has_pin" }
  | { type: "request_status"; request: PinRequest }
  | { type: "choose_first"; pin: string }
  | { type: "choose_problem"; problem: string }
  | { type: "pin_chosen" }
  | { type: "cancel" }
  | { type: "sent"; display: KioskDisplay }
  | { type: "timeout" }
  | { type: "done" }
  | { type: "reset" };

/** The steps that go back to the start after `pinIdleTimeoutMs` with no tap or key. */
export const pinIdleSteps: ReadonlySet<Flow["step"]> = new Set(["pin", "wrong_pin", "pin_locked", "no_pin", "choose_pin"]);

/** The result screen when a PIN request ends without a PIN: declined, run out, or already used. */
export function displayForPinRequestEnd(status: PinRequestStatus): KioskDisplay {
  if (status === "declined") return kioskState("rejected", { message: "Request declined", detail: "An Operator declined setting up a PIN. Ask an Operator for help.", durationMs: 4_000 });
  if (status === "used") return kioskState("duplicate", { message: "PIN already set", detail: "Enter your member ID again and use your PIN.", durationMs: 4_000 });
  return kioskState("rejected", { message: "Request expired", detail: "No Operator approved it in time. Ask for approval again.", durationMs: 4_000 });
}

/** Where a PIN request leads: waiting while pending, choosing a PIN once approved, otherwise a result. */
function flowForPinRequest(member: KioskMember, request: PinRequest): Flow {
  if (request.status === "pending") return { step: "waiting", member, requestId: request.id, expiresAt: request.expiresAt };
  if (request.status === "approved") return { step: "choose_pin", member, requestId: request.id };
  return { step: "result", display: displayForPinRequestEnd(request.status) };
}

export const initialFlow: Flow = { step: "entry", text: "" };

export const unknownMemberDisplay = () => kioskState("unknown", { message: "Member ID not recognized", detail: "Check the ID and try again, or ask an operator for help." });

export const memberName = (member: KioskMember) => `${member.firstName} ${member.lastName}`.trim();
const visibleMember = ({ memberId, firstName, lastName }: KioskMember): KioskMember => ({ memberId, firstName, lastName });

export function flowReducer(flow: Flow, action: FlowAction): Flow {
  switch (action.type) {
    case "key": return flow.step === "entry" && flow.text.length < maxEntryLength ? { step: "entry", text: flow.text + action.key } : flow;
    case "set": return flow.step === "entry" ? { step: "entry", text: action.text.slice(0, maxEntryLength) } : flow;
    case "backspace": return flow.step === "entry" ? { step: "entry", text: flow.text.slice(0, -1) } : flow;
    case "clear": return flow.step === "entry" ? initialFlow : flow;
    case "submit": {
      if (flow.step !== "entry" || !flow.text.trim()) return flow;
      const member = findMemberById(action.roster, flow.text);
      return member ? { step: "confirm", member: visibleMember(member), back: "" } : { step: "result", display: unknownMemberDisplay() };
    }
    case "pick": return flow.step === "entry" ? { step: "confirm", member: visibleMember(action.member), back: flow.text } : flow;
    case "not_me": return flow.step === "confirm" ? { step: "entry", text: flow.back } : flow;
    case "confirm": {
      if (flow.step !== "confirm") return flow;
      const member = flow.member;
      if (!action.pin) return { step: "sending", member };
      if (action.pin.kind === "none") return { step: "no_pin", member };
      if (action.pin.kind === "locked") return { step: "pin_locked", member, ...(action.pin.lockedUntil ? { lockedUntil: action.pin.lockedUntil } : {}) };
      return { step: "pin", member };
    }
    case "pin_entered": return flow.step === "pin" ? { step: "sending", member: flow.member } : flow;
    case "pin_refused": {
      if (flow.step !== "sending") return flow;
      const { member } = flow, { outcome } = action;
      if (outcome.kind === "not_set") return { step: "no_pin", member };
      if (outcome.kind === "locked") return { step: "pin_locked", member, ...(outcome.lockedUntil ? { lockedUntil: outcome.lockedUntil } : {}) };
      // Too many wrong tries online: the result screen says when to try again, then the kiosk returns to the start.
      if (outcome.kind === "throttled") return { step: "result", display: kioskState("rejected", { message: "Please wait", name: memberName(member), detail: outcome.message, durationMs: 4_000 }) };
      return { step: "wrong_pin", member, ...(outcome.lockedUntil ? { lockedUntil: outcome.lockedUntil } : {}), ...(outcome.attemptsLeft !== undefined ? { attemptsLeft: outcome.attemptsLeft } : {}) };
    }
    // A wrong try that locked the member can't be tried again.
    case "try_again": return flow.step === "wrong_pin" && !flow.lockedUntil ? { step: "pin", member: flow.member } : flow;
    case "ask": return flow.step === "no_pin" && !flow.asking ? { step: "no_pin", member: flow.member, asking: true } : flow;
    case "asked": return flow.step === "no_pin" && flow.asking ? flowForPinRequest(flow.member, action.request) : flow;
    case "ask_failed": return flow.step === "no_pin" ? { step: "no_pin", member: flow.member, error: action.message } : flow;
    // The server says the member has a PIN after all (the roster on the device was older): ask for it.
    case "has_pin": return flow.step === "no_pin" ? { step: "pin", member: flow.member } : flow;
    case "request_status": return flow.step === "waiting" && action.request.id === flow.requestId ? flowForPinRequest(flow.member, action.request) : flow;
    case "choose_first": return flow.step === "choose_pin" ? { step: "choose_pin", member: flow.member, requestId: flow.requestId, first: action.pin } : flow;
    case "choose_problem": return flow.step === "choose_pin" ? { step: "choose_pin", member: flow.member, requestId: flow.requestId, error: action.problem } : flow;
    case "pin_chosen": return flow.step === "choose_pin" && flow.first !== undefined ? { step: "sending", member: flow.member } : flow;
    case "cancel": return pinIdleSteps.has(flow.step) || flow.step === "waiting" ? initialFlow : flow;
    case "sent": return flow.step === "sending" ? { step: "result", display: action.display } : flow;
    case "timeout": return flow.step === "confirm" || pinIdleSteps.has(flow.step) ? initialFlow : flow;
    case "done": return flow.step === "result" ? initialFlow : flow;
    case "reset": return initialFlow;
  }
}

/** The result screen for a recorded scan, with the member's name and meeting when the API gives them. */
export function displayForAttendance(result: AttendanceResult, member?: KioskMember): KioskDisplay {
  const display = kioskDisplayForAttendance(result);
  const name = result.member?.displayName || (member ? memberName(member) : undefined);
  const meetingTitle = result.meeting?.title;
  return { ...display, ...(name ? { name } : {}), ...(meetingTitle ? { meetingTitle } : {}) };
}

/** The result screen for a scan the API refused or never received. A 401 is handled by the page (pair again). */
export function displayForAttendanceError(error: unknown): KioskDisplay {
  if (!(error instanceof KioskApiError)) return kioskState("rejected", { message: "Couldn't reach the server", detail: "Try again.", durationMs: 3_500 });
  switch (error.code) {
    case "roster_inactive": return unknownMemberDisplay();
    case "attendance_complete": return kioskState("duplicate", { detail: "Your attendance for this meeting is already complete." });
    case "no_eligible_meeting": case "scan_window_closed": return kioskState("rejected", { message: "No meeting right now", detail: error.message, durationMs: 3_500 });
    case "possible_wrong_match": return kioskState("rescan", { message: "Try again", detail: "Enter your member ID again in a moment." });
    // This kiosk's Require PIN setting changed while the scan was on its way: start again with the new setting.
    case "pin_required": case "invalid_pin": case "invalid_member": return kioskState("rejected", { message: "PIN needed", detail: "This kiosk asks for a PIN now. Enter your member ID again.", durationMs: 3_500 });
    default: return kioskState("rejected", { detail: error.message || "Ask an operator for help.", durationMs: 3_500 });
  }
}

// ---- Commands ----

export type CommandAction = "reload" | "reset_pin" | "unsupported";
export const commandActionFor = (type: string): CommandAction => type === "reload_display" ? "reload" : type === "reset_network_pin" ? "reset_pin" : "unsupported";
export const credentialRejected = (error: unknown) => error instanceof KioskApiError && error.status === 401;

// ---- Offline queue ----

/**
 * The result screen for a scan saved on the kiosk but not yet confirmed by the server, as the Pi shows it
 * (`kioskDisplayForQueuedScan`): Welcome or Goodbye from the member's other waiting scans, and "Saved for sync".
 * `pending` is the queue before this scan was added.
 */
export function displayForQueuedScan(member: KioskMember, pending: readonly { memberId: string }[]): KioskDisplay {
  const display = kioskDisplayForQueuedScan(member.memberId, pending as { memberId: string }[]);
  return { ...display, detail: "Saved for sync", name: memberName(member) };
}

/** The result screen for a scan the queue settled while the member waited. */
export function displayForScanFate(fate: ScanFate, member?: KioskMember): KioskDisplay {
  if (fate.kind === "accepted") return displayForAttendance(fate.result, member);
  return displayForAttendanceError(new KioskApiError(fate.message, fate.status, fate.code));
}

/** The footer's connection status: online or offline, and how many scans wait to sync. */
export function connectionStatus(online: boolean | undefined, pending: number) {
  const waiting = pending > 0 ? ` · ${pending} waiting` : "";
  if (online === false) return pending > 0 ? `Offline${waiting}` : "Offline · couldn't reach the server";
  if (online) return `Online${waiting}`;
  return pending > 0 ? `Connecting…${waiting}` : "Connecting…";
}
