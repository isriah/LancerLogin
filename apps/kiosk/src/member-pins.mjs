// Member PINs on a Pi kiosk with Require PIN. Online, the kiosk sends the PIN with the scan and the server checks it.
// Offline, the kiosk checks it against the hash cached in its roster (PBKDF2-SHA256, the server's parameters), and
// counts wrong tries here until it can report them through /kiosk/pin-failures. The PIN itself is never stored.
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { pbkdf2, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
export const pinKeyBytes = 32;
export const maxPinIterations = 100_000;
const maxReportedFailures = 200;
const maxFailureCount = 1000;

/** A member PIN: 4 to 6 digits. */
export const validPin = (value) => typeof value === "string" && /^\d{4,6}$/.test(value);

const base64 = (value) => typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, "base64") : undefined;

/** A roster PIN hash the kiosk can check, or null when it is missing or malformed. */
export function cleanPinHash(value) {
  if (!value || typeof value !== "object") return null;
  const iterations = Number(value.iterations); const hash = base64(value.hash); const salt = base64(value.salt);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > maxPinIterations || hash?.length !== pinKeyBytes || !salt || salt.length < 8 || salt.length > 64) return null;
  return { hash: value.hash, salt: value.salt, iterations };
}

/** Checks a PIN against a cached hash. The whole derived key is compared in constant time; a malformed hash never matches. */
export async function verifyCachedPin(pin, stored) {
  const clean = cleanPinHash(stored);
  if (!validPin(pin) || !clean) return false;
  const actual = await derive(pin, Buffer.from(clean.salt, "base64"), clean.iterations, pinKeyBytes, "sha256");
  return timingSafeEqual(actual, Buffer.from(clean.hash, "base64"));
}

/** The organization's lockout setting as the server sends it, with the server's defaults and limits. */
export function normalizePinLockout(value) {
  const attempts = Number(value?.attempts), minutes = Number(value?.minutes);
  return {
    enabled: value?.enabled === true || value?.enabled === 1,
    attempts: Number.isInteger(attempts) && attempts >= 3 && attempts <= 20 ? attempts : 5,
    minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 15,
  };
}

/** How a member ID kiosk finds members and whether it asks for a PIN. Both apply only to the member ID method. */
export function normalizeMemberSettings(settings) {
  const memberId = settings?.authenticationMethod === "member_id";
  return { memberLookup: memberId && settings?.memberLookup === "search" ? "search" : "entry", requirePin: memberId && settings?.requirePin === true, pinLockout: normalizePinLockout(settings?.pinLockout) };
}

const future = (value, now) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
/** The later of the roster's lock and the kiosk's own lock while either is in the future, else null. */
export function pinLockedUntil(member, localLock, now = Date.now()) {
  const locks = [member?.pinLockedUntil, localLock].filter((value) => future(value, now));
  return locks.length ? locks.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest) : null;
}

function cleanEntry(value) {
  if (!value || typeof value !== "object") return undefined;
  const unreported = Number.isInteger(value.unreported) && value.unreported > 0 ? Math.min(value.unreported, maxFailureCount) : 0;
  const streak = Number.isInteger(value.streak) && value.streak > 0 ? Math.min(value.streak, maxFailureCount) : 0;
  const date = (field) => typeof value[field] === "string" && Number.isFinite(Date.parse(value[field])) ? new Date(value[field]).toISOString() : null;
  const entry = { unreported, lastAt: date("lastAt"), streak, lockedUntil: date("lockedUntil") };
  return entry.unreported || entry.streak || entry.lockedUntil ? entry : undefined;
}

/**
 * Wrong PIN tries made while the kiosk could not reach the server, saved owner-only in the kiosk's state folder.
 * `unreported` waits for /kiosk/pin-failures; `streak` and `lockedUntil` apply the cached lockout setting here.
 */
export function createPinFailureStore(path, { now = Date.now } = {}) {
  let members; let operations = Promise.resolve();
  const exclusive = (operation) => { const result = operations.then(operation); operations = result.catch(() => undefined); return result; };
  async function load() {
    if (members) return members;
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      members = {};
      for (const [memberId, entry] of Object.entries(value?.members ?? {})) { const clean = cleanEntry(entry); if (clean && memberId.length <= 100) members[memberId] = clean; }
    } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; members = {}; }
    return members;
  }
  async function save(next) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify({ version: 1, members: next })}\n`); await file.sync(); } finally { await file.close(); }
      await chmod(temporary, 0o600); await rename(temporary, path); members = next;
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  const update = (memberId, change) => exclusive(async () => {
    const next = { ...await load() }; const before = JSON.stringify(next[memberId] ?? null);
    const result = change({ ...(next[memberId] ?? { unreported: 0, lastAt: null, streak: 0, lockedUntil: null }) });
    const entry = cleanEntry(result.entry); if (entry) next[memberId] = entry; else delete next[memberId];
    if (JSON.stringify(next[memberId] ?? null) !== before) await save(next);
    return result.outcome;
  });
  return {
    async lockedUntil(memberId) { const lock = (await load())[memberId]?.lockedUntil; return future(lock, now()) ? lock : null; },
    /** Counts a wrong try. With lockout on, the try that reaches the limit locks the member here for the set minutes. */
    recordFailure(memberId, lockoutValue) {
      const lockout = normalizePinLockout(lockoutValue);
      return update(memberId, (entry) => {
        const at = now();
        entry.unreported = Math.min(entry.unreported + 1, maxFailureCount); entry.lastAt = new Date(at).toISOString();
        // A lock that has run out starts a fresh count, as on the server.
        if (entry.lockedUntil && !future(entry.lockedUntil, at)) { entry.lockedUntil = null; entry.streak = 0; }
        entry.streak = Math.min(entry.streak + 1, maxFailureCount);
        if (!lockout.enabled) return { entry, outcome: {} };
        if (entry.streak >= lockout.attempts) { entry.lockedUntil = new Date(at + lockout.minutes * 60_000).toISOString(); entry.streak = 0; return { entry, outcome: { attemptsLeft: 0, lockedUntil: entry.lockedUntil } }; }
        return { entry, outcome: { attemptsLeft: lockout.attempts - entry.streak } };
      });
    },
    /** A right PIN ends the member's run of wrong tries; tries not yet reported are still sent. */
    recordSuccess(memberId) { return update(memberId, (entry) => ({ entry: { ...entry, streak: 0, lockedUntil: null } })); },
    /** A lock the server reported, so the kiosk refuses the member offline too. */
    recordLock(memberId, lockedUntil) { return update(memberId, (entry) => ({ entry: { ...entry, streak: 0, lockedUntil: future(lockedUntil, now()) ? lockedUntil : entry.lockedUntil } })); },
    /** Forgets a member after their PIN is set or reset: tries against an older PIN no longer count. */
    forget(memberId) { return update(memberId, () => ({ entry: undefined })); },
    async pending() {
      return exclusive(async () => Object.entries(await load()).filter(([, entry]) => entry.unreported > 0).slice(0, maxReportedFailures)
        .map(([memberId, entry]) => ({ memberId, count: entry.unreported, lastAt: entry.lastAt ?? new Date(now()).toISOString() })));
    },
    /** Removes reported tries; tries counted while the report was on its way stay for the next one. */
    acknowledge(reported) {
      return exclusive(async () => {
        const next = { ...await load() };
        for (const { memberId, count } of reported) {
          const entry = next[memberId]; if (!entry) continue;
          const clean = cleanEntry({ ...entry, unreported: Math.max(0, entry.unreported - count) });
          if (clean) next[memberId] = clean; else delete next[memberId];
        }
        await save(next);
      });
    },
    clear() { return exclusive(async () => { members = {}; await unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; }); }); },
  };
}

/** Sends the kiosk's unreported wrong tries with send(failures), then removes what was sent. Returns how many members. */
export async function reportPinFailures(store, send) {
  const failures = await store.pending();
  if (!failures.length) return 0;
  await send(failures);
  await store.acknowledge(failures);
  return failures.length;
}
