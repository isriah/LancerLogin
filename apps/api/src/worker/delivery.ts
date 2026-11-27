import { HttpError } from "../http-error.ts";
import { schedulerRequest, schedulerRunner } from "../platform-scheduler.ts";
import type { Env, WorkerContext } from "./core.ts";

/** The row's new updated_at: the write's time, moved a millisecond past the value read when the two would be equal, so a claim always changes it. */
export const schedulerStateTime = (now: number, readAt?: string | null) => { const at = new Date(now).toISOString(); return readAt && readAt >= at ? new Date(Date.parse(readAt) + 1).toISOString() : at; };
export const pausedUntilTime = (row: { pausedUntil?: string | null } | null | undefined, now: number): number | null => { const until = row?.pausedUntil ? Date.parse(row.pausedUntil) : NaN; return Number.isFinite(until) && until > now ? until : null; };

/**
 * Whether an Admin's Stop is pausing outbound delivery, and until when. Delivery code checks this before any provider
 * request and leaves its work queued; a slice already knows. One read per request (keyed on its database wrapper).
 */
const deliveryPauseReads = new WeakMap<object, Promise<number | null>>();
export async function deliveryPausedUntil(env: Env): Promise<number | null> {
  if (env.schedulerPass) return env.schedulerPass.pausedUntil;
  const db = env.DB; if (!db) return null;
  let read = deliveryPauseReads.get(db);
  if (!read) {
    read = db.prepare("SELECT paused_until AS pausedUntil FROM platform_scheduler_state WHERE installation_id = 'primary'").first<{ pausedUntil: string | null }>()
      .then((row) => pausedUntilTime(row, Date.now()))
      // An installation whose migrations have not reached 0097 has no Stop to honour.
      .catch(() => null);
    deliveryPauseReads.set(db, read);
  }
  return read;
}
const deliveryPausedMessage = (until: number) => `Outbound delivery is stopped until ${new Date(until).toISOString()}. Start the scheduler on the Debug page to resume it sooner.`;
export async function requireDeliveryRunning(env: Env): Promise<void> { const until = await deliveryPausedUntil(env); if (until !== null) throw new HttpError(409, deliveryPausedMessage(until)); }

/**
 * Ask the scheduler to run these jobs within seconds. Only a Durable Object deployment can; without one the cron runs
 * them on its next tick. Never fails or delays the write that created the work.
 */
export function pokeScheduler(env: Env, context: WorkerContext | undefined, jobIds: readonly string[]): void {
  if (schedulerRunner(env) !== "durable" || !jobIds.length || env.schedulerPass) return;
  const poke = (async () => { try { await schedulerObject(env)!.fetch(schedulerRequest("poke", { jobs: jobIds })); } catch { /* The job still runs when it next falls due. */ } })();
  context?.waitUntil(poke);
}
/** The jobs a write that queues each kind of delivery pokes. */
export const schedulerJobsFor = {
  calendar: ["attendance.google-calendar", "attendance.discord-calendar"],
  labels: ["attendance.discord-label-roles"],
  notices: ["attendance.discord-notices", "attendance.discord-anomalies"],
  channel: ["attendance.discord-channel"],
} as const satisfies Record<string, readonly string[]>;
export const schedulerObject = (env: Env) => env.PLATFORM_SCHEDULER ? env.PLATFORM_SCHEDULER.get(env.PLATFORM_SCHEDULER.idFromName("primary")) : undefined;
/** The Durable Object runs the scheduler whenever it is bound; PLATFORM_SCHEDULER_MODE "cron" keeps the cron fallback. */
export const durableScheduler = (env: Env) => schedulerRunner(env) === "durable";
