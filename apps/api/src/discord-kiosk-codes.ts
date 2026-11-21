import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { throttleWaitText } from "./member-pins.ts";

/**
 * Discord code mode for kiosks (migration 0100). A member runs /code in the team's Discord server and gets a 6-digit
 * code that works once and expires two minutes later; asking again replaces it. At a kiosk with Discord codes on, the
 * member types the code alone and the server finds them. Online only: nothing about a code is cached on a kiosk.
 *
 * The server keeps only a SHA-256 hash. A code is random, short-lived and single-use, so a slow hash would add nothing
 * the throttle below does not, and would not fit the Workers Free plan's 10 ms of CPU. A code is never logged or audited.
 */
export const DISCORD_CODE_TTL_MS = 2 * 60_000;
/**
 * The wrong-code throttle, per kiosk (not per address: every proxied kiosk shares one). The first
 * DISCORD_CODE_FREE_TRIES wrong codes in a row are free; each wrong code after that makes the kiosk's next try wait
 * DISCORD_CODE_THROTTLE_SECONDS, longest last and repeated. A correct code starts over. A try made while waiting is
 * refused before the code is looked up. Same shape as the member PIN throttle.
 */
export const DISCORD_CODE_FREE_TRIES = 5;
export const DISCORD_CODE_THROTTLE_SECONDS: readonly number[] = Object.freeze([30, 60, 300]);
const MAX_FAILURES = 1_000_000;
const ISSUE_ATTEMPTS = 5;

export type DiscordCodeBackup = "offline" | "always";
export const discordCodeBackups: ReadonlySet<string> = new Set(["offline", "always"]);
export const normalizeDiscordCodeBackup = (value: unknown): DiscordCodeBackup => value === "always" ? "always" : "offline";
export type DiscordCodeKiosk = { id: string; discordCode: boolean; discordCodeFailures: number; discordCodeThrottleUntil: string | null };

export async function hashDiscordKioskCode(code: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lancerlogin-discord-kiosk-code:${code}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Six digits, each code equally likely, leading zeros kept. Values past the last whole million are drawn again. */
export function randomDiscordKioskCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000; const draw = new Uint32Array(1);
  do crypto.getRandomValues(draw); while (draw[0]! >= limit);
  return String(draw[0]! % 1_000_000).padStart(6, "0");
}
/** A typed code with its spaces removed, or undefined when it is not six digits. */
export function normalizeDiscordKioskCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16) return undefined;
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : undefined;
}

export const discordCodeReplies = Object.freeze({
  notLinked: "Your Discord account is not linked to a LancerLogin member yet. Link it first with /pair, then run /code again.",
  notOneActiveMember: "Your Discord account is not linked to exactly one active LancerLogin roster member. Ask an Operator to check your roster link.",
  busy: "A kiosk code could not be made just now. Run /code again.",
});

/**
 * The reply to /code. Queries: one read of the members linked to this Discord account, then one write that replaces the
 * member's code. The write does nothing when another member holds the same code, unused and unexpired; only then is a
 * new code drawn and the write repeated.
 */
export async function issueDiscordKioskCode(db: D1Database, discordUserId: string): Promise<string> {
  const linked = (await db.prepare("SELECT id, active FROM members WHERE installation_id = 'primary' AND discord_user_id = ?").bind(discordUserId).all<{ id: string; active: number }>()).results ?? [];
  if (linked.length === 0) return discordCodeReplies.notLinked;
  if (linked.length !== 1 || !linked[0]!.active) return discordCodeReplies.notOneActiveMember;
  const now = Date.now(); const nowText = new Date(now).toISOString(); const expiresAt = new Date(now + DISCORD_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
    const code = randomDiscordKioskCode();
    const written = await db.prepare(`INSERT INTO discord_kiosk_codes (installation_id, member_id, code_hash, expires_at, used_at, created_at)
      SELECT 'primary', ?1, ?2, ?3, NULL, ?4
      WHERE NOT EXISTS (SELECT 1 FROM discord_kiosk_codes WHERE installation_id = 'primary' AND code_hash = ?2 AND member_id <> ?1 AND used_at IS NULL AND expires_at > ?4)
      ON CONFLICT(installation_id, member_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, used_at = NULL, created_at = excluded.created_at`)
      .bind(linked[0]!.id, await hashDiscordKioskCode(code), expiresAt, nowText).run();
    if ((written.meta?.changes ?? 0) > 0) return `Your kiosk code is **${code.slice(0, 3)} ${code.slice(3)}**. It works once and expires in 2 minutes.`;
  }
  return discordCodeReplies.busy;
}

export function discordCodeThrottleMessage(seconds: number) {
  return `Too many wrong codes. Try again in ${throttleWaitText(seconds)}.`;
}
/** SQL for the wait after a wrong code: NULL while tries are free, then each delay in turn, the last repeating. */
function throttleUntilSql(firstParameter: number) {
  const next = "discord_code_failures + 1";
  const steps = DISCORD_CODE_THROTTLE_SECONDS.slice(0, -1).map((_, index) => `WHEN ${next} = ${DISCORD_CODE_FREE_TRIES + index} THEN ?${firstParameter + index} `).join("");
  return `CASE WHEN ${next} < ${DISCORD_CODE_FREE_TRIES} THEN NULL ${steps}ELSE ?${firstParameter + DISCORD_CODE_THROTTLE_SECONDS.length - 1} END`;
}

/**
 * The code step of a scan that carries discordCode instead of memberId, in two parts so that only an accepted scan
 * uses a code up. This part finds the member a live code belongs to, for the usual attendance step, without using the
 * code. The attendance step then records the scan and uses the code in one batch (discordCodeAcceptance). A scan
 * refused for a reason that is not about the code (no meeting takes it, too early, attendance complete, a failure on
 * the way) leaves the code good until it expires, and does not count as a wrong code. A code never needs a PIN, and is
 * always checked here: nothing a kiosk says about an offline check skips it.
 *
 * The throttle holds for tries a kiosk credential sends at the same time, which were all authenticated, and so all read
 * the kiosk's wait, before any of them counted. The lookup and the count are one batch, a transaction, and both go by
 * the kiosk's row as it is then: a code is looked up only while the kiosk has no wait running, and a wrong one is
 * counted in the same transaction. So of any number of tries sent at once, no more are looked up than would be one
 * after another; the rest are refused as throttled, and say nothing about the code they carried.
 *
 * Queries: one batch, whatever the outcome. It looks the code up, counts a wrong try (not a retry of a scan this server
 * already recorded, which is answered as a duplicate), and reads the kiosk's wait for the refusal. A refusal while the
 * kiosk was already waiting when it authenticated is no query at all.
 */
/**
 * A code found for a scan, with the kiosk's throttle as the lookup read it: its count of wrong codes and the time of the
 * lookup. The kiosk had no wait running then, so a wait running past lookedUpAt started after the lookup.
 */
export type DiscordCodeLookup = { memberId: string; codeHash: string; failures: number; lookedUpAt: string };
export async function findDiscordKioskCode(db: D1Database, kiosk: DiscordCodeKiosk, input: { discordCode?: unknown; eventId: string }): Promise<DiscordCodeLookup | { duplicate: string }> {
  if (!kiosk.discordCode) throw new HttpError(409, "This kiosk does not take Discord codes.", undefined, "code_not_enabled");
  const code = normalizeDiscordKioskCode(input.discordCode);
  if (!code) throw new HttpError(400, "A Discord code is 6 digits.", undefined, "invalid_code");
  const now = Date.now(); const nowText = new Date(now).toISOString();
  const throttled = (retryAt: string) => {
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 1000));
    return new HttpError(429, discordCodeThrottleMessage(retryAfterSeconds), undefined, "code_throttled", { retryAt, retryAfterSeconds });
  };
  if (kiosk.discordCodeThrottleUntil && kiosk.discordCodeThrottleUntil > nowText) throw throttled(kiosk.discordCodeThrottleUntil);
  const codeHash = await hashDiscordKioskCode(code);
  const waits = DISCORD_CODE_THROTTLE_SECONDS.map((seconds) => new Date(now + seconds * 1000).toISOString());
  const results = await db.batch([
    db.prepare(`SELECT member_id AS memberId FROM discord_kiosk_codes WHERE installation_id = 'primary' AND code_hash = ?1 AND used_at IS NULL AND expires_at > ?2
      AND NOT EXISTS (SELECT 1 FROM kiosks k WHERE k.installation_id = 'primary' AND k.id = ?3 AND k.discord_code_throttle_until > ?2)`).bind(codeHash, nowText, kiosk.id),
    // Counts a wrong code: one that is not live, sent while the kiosk is not waiting, in a scan not recorded before.
    db.prepare(`UPDATE kiosks SET discord_code_throttle_until = ${throttleUntilSql(6)}, discord_code_failures = MIN(discord_code_failures + 1, ?2)
      WHERE installation_id = 'primary' AND id = ?1 AND (discord_code_throttle_until IS NULL OR discord_code_throttle_until <= ?3)
        AND NOT EXISTS (SELECT 1 FROM discord_kiosk_codes WHERE installation_id = 'primary' AND code_hash = ?4 AND used_at IS NULL AND expires_at > ?3)
        AND NOT EXISTS (SELECT 1 FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?5)
      RETURNING discord_code_throttle_until AS throttleUntil`).bind(kiosk.id, MAX_FAILURES, nowText, codeHash, input.eventId, ...waits),
    db.prepare("SELECT discord_code_throttle_until AS throttleUntil, discord_code_failures AS failures, (SELECT action FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?2) AS recorded FROM kiosks WHERE installation_id = 'primary' AND id = ?1").bind(kiosk.id, input.eventId),
  ]);
  const found = (results[0]?.results ?? []) as { memberId: string }[];
  const state = results[2]?.results?.[0] as { throttleUntil?: string | null; failures?: number; recorded?: string | null } | undefined;
  // /code never gives two members the same live code. If a race ever did, the code names no one. A found code counted
  // nothing, so the last read is the kiosk's row as the lookup saw it.
  if (found.length === 1) return { memberId: found[0]!.memberId, codeHash, failures: Number(state?.failures ?? 0), lookedUpAt: nowText };
  // A kiosk that lost the answer to a recorded scan sends it again, with a code that is now used.
  if (state?.recorded) return { duplicate: state.recorded };
  const counted = results[1]?.results?.[0] as { throttleUntil?: string | null } | undefined;
  const waitingUntil = state?.throttleUntil && state.throttleUntil > nowText ? state.throttleUntil : null;
  // Not counted and the kiosk is waiting: a try sent at the same time started the wait first, and this code was never
  // looked up.
  if (!counted && waitingUntil) throw throttled(waitingUntil);
  // Counted: when the next try has to wait, say until when, so the kiosk can tell the member.
  throw discordCodeInvalid(counted ? waitingUntil : null, now);
}
/** The refusal for a code that is wrong, used or expired. Not 401: kiosks treat a 401 as a revoked credential. */
function discordCodeInvalid(retryAt: string | null, now: number) {
  return new HttpError(403, "That code is wrong or has expired. Run /code in Discord for a new one.", undefined, "code_invalid", retryAt ? { retryAt, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 1000)) } : undefined);
}

/**
 * What the attendance step needs to record a Discord code scan and use the code up together, in its one batch:
 * - `live` is a condition for the INSERT of the attendance event, with `liveValues` bound after the insert's own: the
 *   event is recorded only while the code is still unused and unexpired. Two kiosks sending one code are two batches,
 *   one after the other, so exactly one records its scan.
 * - `statements` follow the INSERT: the code is marked used only if this scan's event was recorded, the kiosk's count of
 *   wrong codes starts over, and a last read says whether the event is there. Starting over clears only what the lookup
 *   saw: a wrong code from the same kiosk counted after this scan's lookup, before this batch, keeps its count and its
 *   wait, so a good code cannot wipe out the wait a wrong one sent alongside it started.
 * - `refused(results)` takes the results of `statements` when the INSERT changed nothing. It returns the refusal when
 *   another scan used the code first or it expired on the way, and undefined when the event is there after all (the
 *   same scan sent twice at once), which the attendance step answers as a duplicate.
 * A batch that fails changes nothing, so the code stays good for the kiosk's retry.
 */
export function discordCodeAcceptance(db: D1Database, scan: { kioskId: string; codeHash: string; memberId: string; eventId: string; failures: number; lookedUpAt: string }) {
  const now = Date.now(); const nowText = new Date(now).toISOString();
  const recorded = "SELECT 1 FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ? AND member_id = ?";
  return {
    live: "EXISTS (SELECT 1 FROM discord_kiosk_codes WHERE installation_id = 'primary' AND code_hash = ? AND member_id = ? AND used_at IS NULL AND expires_at > ?)",
    liveValues: [scan.codeHash, scan.memberId, nowText] as unknown[],
    statements: [
      db.prepare(`UPDATE discord_kiosk_codes SET used_at = ? WHERE installation_id = 'primary' AND code_hash = ? AND member_id = ? AND used_at IS NULL AND EXISTS (${recorded})`).bind(nowText, scan.codeHash, scan.memberId, scan.eventId, scan.memberId),
      // The wrong codes counted since the lookup stay counted (fewer than the lookup saw means another good scan already
      // started the count over, so the count is left as it is), and a wait that runs past the lookup started after it.
      db.prepare(`UPDATE kiosks SET discord_code_failures = CASE WHEN discord_code_failures >= ?4 THEN discord_code_failures - ?4 ELSE discord_code_failures END,
          discord_code_throttle_until = CASE WHEN discord_code_throttle_until > ?5 THEN discord_code_throttle_until ELSE NULL END
        WHERE installation_id = 'primary' AND id = ?1 AND (discord_code_failures > 0 OR discord_code_throttle_until IS NOT NULL)
          AND EXISTS (SELECT 1 FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?2 AND member_id = ?3)`).bind(scan.kioskId, scan.eventId, scan.memberId, Math.max(0, Math.trunc(scan.failures)), scan.lookedUpAt),
      db.prepare(`SELECT EXISTS (${recorded}) AS recorded`).bind(scan.eventId, scan.memberId),
    ],
    refused(results: readonly ({ results?: unknown[] } | undefined)[]): HttpError | undefined {
      return Number((results[2]?.results?.[0] as { recorded?: number } | undefined)?.recorded ?? 0) === 1 ? undefined : discordCodeInvalid(null, now);
    },
  };
}

/** The statement that removes used and expired codes, for the scheduled pass's one clean-up batch (stale-row-pruning.ts). */
export function discordKioskCodePruning(db: D1Database, now = Date.now()) {
  return db.prepare("DELETE FROM discord_kiosk_codes WHERE installation_id = 'primary' AND (used_at IS NOT NULL OR expires_at <= ?)").bind(new Date(now).toISOString());
}
/** Removes used and expired codes. Runs from the scheduled pass, so /code and a scan stay one write each. */
export function pruneDiscordKioskCodes(db: D1Database, now = Date.now()) {
  return discordKioskCodePruning(db, now).run();
}
