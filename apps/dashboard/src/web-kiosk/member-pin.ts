// Member PINs at a web kiosk with Require PIN (web kiosk phase 3), kept free of React and the browser so it can be
// tested on its own:
// - the offline check against the member's cached hash (PBKDF2-SHA256, the server's 100,000 iterations at most);
// - wrong tries made offline, counted on the device (state key `pinFailures`) and reported to `/kiosk/pin-failures` on
//   sync. Under the lockout setting the kiosk last saw, enough of them lock the member on this device until the server
//   has the count;
// - which lock refuses a member before they type a PIN, and how the server's answers map to the PIN screens.
// Cached hashes stay on the device only while the kiosk requires a PIN (`withoutPinData`).
import type { KioskApiError, KioskConfig, MemberPinHash, PinFailureReport, RosterMember, SendOutcome } from "./kiosk-api.ts";
import { verifyPinHash } from "./settings-pin.ts";

export const memberPinMinLength = 4;
export const memberPinMaxLength = 6;
/** The server hashes with 100,000 iterations (the Workers limit); a cached hash asking for more is not trusted. */
export const memberPinMaxIterations = 100_000;
/** The PIN and choose-PIN screens go back to the start after this long with no tap or key. */
export const pinIdleTimeoutMs = 30_000;
/** How often the waiting screen asks whether an Operator decided the PIN request. */
export const pinRequestPollMs = 3_000;
/** The most failures `/kiosk/pin-failures` takes at once, and the most tries per member it takes in one report. */
export const maxPinFailureReports = 200;
export const maxPinFailureCount = 1_000;

export const validMemberPin = (pin: string) => /^\d{4,6}$/.test(pin);

/** A member PIN typed twice: what's wrong with it, or undefined when it can be saved. */
export function memberPinProblem(first: string, second: string) {
  if (!validMemberPin(first)) return "Choose 4 to 6 digits.";
  if (first !== second) return "The two PINs don't match. Choose a PIN again.";
  return undefined;
}

/**
 * One step of choosing a PIN typed twice: the first entry to keep, a problem to show (and start again), or the PIN to
 * save once both match.
 */
export function choosePinStep(first: string | undefined, pin: string): { first: string } | { problem: string } | { pin: string } {
  if (first === undefined) { const problem = memberPinProblem(pin, pin); return problem ? { problem } : { first: pin }; }
  const problem = memberPinProblem(first, pin);
  return problem ? { problem } : { pin };
}

/** True when the PIN derives the member's cached hash. */
export async function verifyMemberPin(pin: string, stored: MemberPinHash | null | undefined, cryptoImpl: Crypto = globalThis.crypto) {
  return Boolean(stored) && validMemberPin(pin) && await verifyPinHash(pin, stored!, { cryptoImpl, maxIterations: memberPinMaxIterations });
}

// ---- Configuration ----

export type PinLockout = { enabled: boolean; attempts: number; minutes: number };
export const defaultPinLockout: PinLockout = Object.freeze({ enabled: false, attempts: 5, minutes: 15 });

export const requirePinFor = (config?: KioskConfig) => config?.settings?.requirePin === true;

/** The lockout setting as the kiosk last saw it, within the server's limits (3 to 20 tries, 1 to 1440 minutes). */
export function pinLockoutFor(config?: KioskConfig): PinLockout {
  const value = config?.settings?.pinLockout;
  const attempts = Number(value?.attempts), minutes = Number(value?.minutes);
  return {
    enabled: value?.enabled === true,
    attempts: Number.isInteger(attempts) && attempts >= 3 && attempts <= 20 ? attempts : defaultPinLockout.attempts,
    minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : defaultPinLockout.minutes,
  };
}

/** The roster without PIN hashes or locks: what the device keeps when the kiosk doesn't require a PIN. */
export function withoutPinData(members: readonly RosterMember[]): RosterMember[] {
  return members.map(({ pin: _pin, pinLockedUntil: _locked, ...member }) => member);
}
export const rosterHasPinData = (members: readonly RosterMember[]) => members.some((member) => "pin" in member || "pinLockedUntil" in member);

/** Whether the roster says the member has a PIN: `unknown` when it carries no PIN data for them. */
export function memberPinState(member: RosterMember | undefined): "set" | "none" | "unknown" {
  if (!member || !("pin" in member)) return "unknown";
  const pin = member.pin;
  return pin && typeof pin.hash === "string" && typeof pin.salt === "string" && Number.isInteger(pin.iterations) ? "set" : pin === null ? "none" : "unknown";
}

// ---- Wrong tries made offline ----

/**
 * One member's wrong tries made offline. `count` is what the server hasn't been told yet; `streak` counts toward the
 * local lock and starts again after a local lock runs out, as the server's count does.
 */
export type PinFailure = { memberId: string; count: number; lastAt: string; streak: number; lockedUntil?: string };
export type PinFailureLedger = PinFailure[];

const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** The saved ledger, keeping only well-formed entries. */
export function usablePinFailures(value: unknown): PinFailureLedger {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item as Partial<PinFailure> | undefined;
    if (!record || typeof record !== "object" || typeof record.memberId !== "string" || !record.memberId || !timestamp(record.lastAt)) return [];
    const count = Number.isInteger(record.count) && record.count! >= 0 ? record.count! : 0;
    const streak = Number.isInteger(record.streak) && record.streak! >= 0 ? record.streak! : count;
    return [{ memberId: record.memberId, count, lastAt: record.lastAt, streak, ...(timestamp(record.lockedUntil) ? { lockedUntil: record.lockedUntil } : {}) }];
  });
}

/**
 * Counts a wrong try made offline at `now` (server time, in milliseconds). With lockout on, the try that reaches the
 * limit locks the member on this device for the configured minutes. Returns the new ledger and the lock, if any.
 */
export function recordOfflineFailure(ledger: PinFailureLedger, memberId: string, now: number, lockout: PinLockout): { ledger: PinFailureLedger; lockedUntil?: string } {
  const previous = ledger.find((item) => item.memberId === memberId);
  const lockRanOut = previous?.lockedUntil !== undefined && Date.parse(previous.lockedUntil) <= now;
  const streak = (lockRanOut ? 0 : previous?.streak ?? 0) + 1;
  const stillLocked = previous?.lockedUntil !== undefined && !lockRanOut ? previous.lockedUntil : undefined;
  const lockedUntil = stillLocked ?? (lockout.enabled && streak >= lockout.attempts ? new Date(now + lockout.minutes * 60_000).toISOString() : undefined);
  const entry: PinFailure = { memberId, count: Math.min((previous?.count ?? 0) + 1, 1_000_000), lastAt: new Date(now).toISOString(), streak, ...(lockedUntil ? { lockedUntil } : {}) };
  return { ledger: [...ledger.filter((item) => item.memberId !== memberId), entry], ...(lockedUntil ? { lockedUntil } : {}) };
}

/** A right PIN offline starts the local count toward a lock again; the wrong tries before it are still reported. */
export function afterOfflineMatch(ledger: PinFailureLedger, memberId: string): PinFailureLedger {
  return ledger.flatMap((item) => {
    if (item.memberId !== memberId) return [item];
    const { lockedUntil: _lock, ...rest } = item;
    return item.count > 0 ? [{ ...rest, streak: 0 }] : [];
  });
}

/** The tries to report to `/kiosk/pin-failures`, within its limits (200 members, 1 to 1000 tries each). */
export function pinFailureReport(ledger: PinFailureLedger): PinFailureReport[] {
  return ledger.filter((item) => item.count > 0).slice(0, maxPinFailureReports).map((item) => ({ memberId: item.memberId, count: Math.min(item.count, maxPinFailureCount), lastAt: item.lastAt }));
}

/**
 * The ledger once the server has answered a report: a member whose tries were all reported is removed, lock and all,
 * because the server's count (and its lock, which comes back with the roster) now covers them. Tries made while the
 * report was on its way stay.
 */
export function afterPinFailureReport(ledger: PinFailureLedger, reported: readonly PinFailureReport[]): PinFailureLedger {
  const sent = new Map(reported.map((item) => [item.memberId, item]));
  return ledger.flatMap((item) => {
    const report = sent.get(item.memberId);
    if (!report) return [item];
    const count = item.count - report.count;
    return count > 0 ? [{ ...item, count, streak: count }] : [];
  });
}

/**
 * The lock that refuses the member before they type a PIN, or undefined: the latest of the roster's `pinLockedUntil`,
 * a lock the server reported since the roster was loaded, and a lock from wrong tries made offline, while in the future.
 */
export function pinLockFor({ member, ledger, serverLock, now }: { member: RosterMember | undefined; ledger: PinFailureLedger; serverLock?: string; now: number }) {
  const local = member ? ledger.find((item) => item.memberId === member.memberId)?.lockedUntil : undefined;
  const future = [member?.pinLockedUntil, serverLock, local].filter((value): value is string => timestamp(value) && Date.parse(value) > now);
  return future.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/** "4:15 PM": when a lock ends, in the device's own time format. */
export function lockedUntilText(iso: string, locale?: string) {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

// ---- The server's answers ----

/** What a PIN answer means for the member's screens. */
export type PinOutcome =
  | { kind: "wrong"; lockedUntil?: string; attemptsLeft?: number }
  | { kind: "locked"; lockedUntil?: string }
  | { kind: "not_set" };

/** The PIN screen a refused scan leads to, or undefined when the refusal isn't about the PIN. */
export function pinOutcomeFor(answer: SendOutcome | KioskApiError): PinOutcome | undefined {
  const refusal = "kind" in answer ? (answer.kind === "rejected" ? answer : undefined) : answer;
  if (!refusal) return undefined;
  const lockedUntil = refusal.lockedUntil;
  switch (refusal.code) {
    case "pin_incorrect": {
      const attemptsLeft = "attemptsLeft" in refusal ? refusal.attemptsLeft : undefined;
      return { kind: "wrong", ...(lockedUntil ? { lockedUntil } : {}), ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) };
    }
    case "pin_locked": return { kind: "locked", ...(lockedUntil ? { lockedUntil } : {}) };
    case "pin_not_set": return { kind: "not_set" };
    default: return undefined;
  }
}

/** The line under "Wrong PIN" or "PIN locked": when the lock ends, or how many tries are left before it. */
export function lockoutLine(outcome: { lockedUntil?: string; attemptsLeft?: number }, locale?: string) {
  if (outcome.lockedUntil) return `PIN locked until ${lockedUntilText(outcome.lockedUntil, locale)}`;
  if (outcome.attemptsLeft !== undefined && outcome.attemptsLeft > 0) return outcome.attemptsLeft === 1 ? "1 try left before the PIN locks" : `${outcome.attemptsLeft} tries left before the PIN locks`;
  return undefined;
}
