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
// One call sends the report that was waiting and the one holding the tries made since; anything more waits for the next call.
const maxReportsPerCall = 2;

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

/**
 * How a member ID kiosk finds members, whether it asks for a PIN, and whether it takes Discord codes (with the member
 * lookup as the backup method, offered only offline or at any time). All apply only to the member ID method; a Worker
 * from before Discord codes sends neither field, which reads as off and "offline".
 */
export function normalizeMemberSettings(settings) {
  const memberId = settings?.authenticationMethod === "member_id";
  return {
    memberLookup: memberId && settings?.memberLookup === "search" ? "search" : "entry", requirePin: memberId && settings?.requirePin === true, pinLockout: normalizePinLockout(settings?.pinLockout),
    discordCode: memberId && settings?.discordCode === true, discordCodeBackup: memberId && settings?.discordCodeBackup === "always" ? "always" : "offline",
  };
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

/** A saved report: an id and the tries it carries, or null when it is missing or malformed. */
function cleanReport(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id || value.id.length > 128 || !Array.isArray(value.failures)) return null;
  const failures = value.failures.filter((item) => item && typeof item === "object" && typeof item.memberId === "string" && item.memberId && item.memberId.length <= 100
    && Number.isInteger(item.count) && item.count >= 1 && item.count <= maxFailureCount && typeof item.lastAt === "string" && Number.isFinite(Date.parse(item.lastAt)))
    .slice(0, maxReportedFailures).map(({ memberId, count, lastAt }) => ({ memberId, count, lastAt }));
  return failures.length ? { id: value.id, failures } : null;
}

/**
 * Wrong PIN tries made while the kiosk could not reach the server, saved owner-only in the kiosk's state folder.
 * `unreported` waits for /kiosk/pin-failures; `streak` and `lockedUntil` apply the cached lockout setting here.
 *
 * A report on its way is saved with the members, as `report`: an id and the tries it carries. It is frozen until the
 * server answers it. Every resend, after a lost answer or a restart, carries the same id and the same tries, so the
 * server can tell it has applied them and not count them again. Tries made meanwhile add to `unreported` only, and go
 * in the next report, under a new id.
 */
export function createPinFailureStore(path, { now = Date.now, newId = randomUUID } = {}) {
  let members; let report = null; let operations = Promise.resolve();
  const exclusive = (operation) => { const result = operations.then(operation); operations = result.catch(() => undefined); return result; };
  async function load() {
    if (members) return members;
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      members = {};
      for (const [memberId, entry] of Object.entries(value?.members ?? {})) { const clean = cleanEntry(entry); if (clean && memberId.length <= 100) members[memberId] = clean; }
      report = cleanReport(value?.report);
    } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; members = {}; report = null; }
    return members;
  }
  async function save(next, nextReport = report) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify({ version: 1, members: next, ...(nextReport ? { report: nextReport } : {}) })}\n`); await file.sync(); } finally { await file.close(); }
      await chmod(temporary, 0o600); await rename(temporary, path); members = next; report = nextReport;
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  const update = (memberId, change) => exclusive(async () => {
    const next = { ...await load() }; const before = JSON.stringify(next[memberId] ?? null);
    const result = change({ ...(next[memberId] ?? { unreported: 0, lastAt: null, streak: 0, lockedUntil: null }) });
    const entry = cleanEntry(result.entry); if (entry) next[memberId] = entry; else delete next[memberId];
    if (JSON.stringify(next[memberId] ?? null) !== before) await save(next);
    return result.outcome;
  });
  const pendingFailures = (current) => Object.entries(current).filter(([, entry]) => entry.unreported > 0).slice(0, maxReportedFailures)
    .map(([memberId, entry]) => ({ memberId, count: entry.unreported, lastAt: entry.lastAt ?? new Date(now()).toISOString() }));
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
      return exclusive(async () => pendingFailures(await load()));
    },
    /**
     * The report to send, { id, failures }, or null when there is nothing to report. A report not yet acknowledged is
     * returned again as it was saved, id and tries; otherwise the tries waiting now are frozen under a new id and saved
     * before this returns, so a restart sends the same report.
     */
    report() {
      return exclusive(async () => {
        const current = await load();
        if (report) return report;
        const failures = pendingFailures(current);
        if (!failures.length) return null;
        await save(current, { id: newId(), failures });
        return report;
      });
    },
    /**
     * Removes reported tries; tries counted while the report was on its way stay for the next one. With the id of the
     * frozen report, that report is done too, in the same write, so the next one starts fresh.
     */
    acknowledge(reported, reportId) {
      return exclusive(async () => {
        const next = { ...await load() };
        for (const { memberId, count } of reported) {
          const entry = next[memberId]; if (!entry) continue;
          const clean = cleanEntry({ ...entry, unreported: Math.max(0, entry.unreported - count) });
          if (clean) next[memberId] = clean; else delete next[memberId];
        }
        await save(next, reportId !== undefined && report?.id === reportId ? null : report);
      });
    },
    clear() { return exclusive(async () => { members = {}; report = null; await unlink(path).catch((error) => { if (error?.code !== "ENOENT") throw error; }); }); },
  };
}

/**
 * Sends the kiosk's unreported wrong tries with send(failures, reportId), then removes what was sent. Returns how many
 * members. reportId is the same each time the same report is sent, so a server that applied it and whose answer was lost
 * does not count it twice; a server from before report ids ignores it. A report that is not answered stays as it is for
 * the next call. Tries made after a report was frozen follow in a report of their own, in the same call.
 */
export async function reportPinFailures(store, send) {
  let members = 0;
  for (let reports = 0; reports < maxReportsPerCall; reports += 1) {
    const report = await store.report();
    if (!report) break;
    await send(report.failures, report.id);
    await store.acknowledge(report.failures, report.id);
    members += report.failures.length;
  }
  return members;
}
