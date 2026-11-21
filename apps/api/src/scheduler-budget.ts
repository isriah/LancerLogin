// The budget of one scheduler invocation: a Durable Object alarm's single slice, or the cron fallback's pass over every
// due job.
//
// What Cloudflare documents for the Workers Free plan (developers.cloudflare.com/workers/platform/limits and
// /d1/platform/limits, read 2026-11-20): 50 subrequests per invocation, where "a subrequest is any request a Worker
// makes using the Fetch API or to Cloudflare services like R2, KV, or D1"; and, for D1, 50 queries per Worker invocation
// (a db.batch is one query). The pages do not say whether a D1 query and an outbound fetch draw on one counter or on
// two, nor how either applies to a Durable Object alarm, so the budget takes the stricter reading everywhere: ONE limit
// of 50 for D1 queries and provider requests together, per cron invocation and per alarm invocation alike.
//
// The budget counts every D1 query and provider request. Each job checks it before it starts and before each item of
// its batch (`allows`); a job the budget stops part-way, or one that stops at its own per-slice cap (see `more`), reports
// more work, and the scheduler runs it again shortly. Those checks work from estimates, so the budget also enforces the
// limit: a query or request that would pass `total - reserve` is refused before it is sent (SchedulerBudgetError). The
// reserve is released only for the invocation's closing state write, which therefore always fits.
import { preserveDatabaseIdentity, type D1Database, type D1Statement } from "./d1-usage.ts";

export type PassCost = { readonly d1?: number; readonly external?: number };
/**
 * `total` caps D1 queries plus provider requests for the whole invocation, closing writes included. `reserve` is the
 * part of it only the closing writes may use. `d1` and `external` are softer caps on each kind that `allows` applies to
 * keep a slice small (its CPU share); they are never above `total`.
 */
export type PassLimits = { readonly total: number; readonly reserve: number; readonly d1: number; readonly external: number };

/** The platform's limit under the strict reading: D1 queries and outbound requests together, per invocation. */
export const FREE_PLAN_SUBREQUESTS = 50;
/**
 * The cron fallback's pass: at most 46 subrequests in all, 2 of them kept for its closing write. The cron invocation
 * also makes one request of its own outside the pass (it tells a bound Durable Object to stand down), so its worst case
 * is 47 of 50.
 */
export const scheduledPassLimits: PassLimits = Object.freeze({ total: 46, reserve: 2, d1: 46, external: 46 });
/**
 * One Durable Object slice: one job's small batch, at most 40 subrequests in all with 2 kept for its closing write, so
 * the slice also stays near its CPU share. The slice's opening read comes out of the same budget.
 */
export const scheduledSliceLimits: PassLimits = Object.freeze({ total: 40, reserve: 2, d1: 30, external: 12 });
/** What a job needs left to be worth starting: its readiness checks and at least one item. */
export const scheduledJobStartCost: PassCost = Object.freeze({ d1: 6, external: 1 });

/** A query or provider request the budget refused because it would pass the invocation's limit. Nothing was sent. */
export class SchedulerBudgetError extends Error {
  constructor(kind: "D1 query" | "provider request") { super(`The scheduler's subrequest budget refused a ${kind}`); this.name = "SchedulerBudgetError"; }
}

export class SchedulerBudget {
  d1 = 0;
  external = 0;
  /** Queries and requests refused at the limit. A job that had one refused did not finish its work. */
  refused = 0;
  readonly deferred: string[] = [];
  /** Whether a check found the budget too small for the next item, or a job said it stopped at its own cap. */
  exhausted = false;
  limits: PassLimits;
  private closing = false;
  constructor(limits: PassLimits = scheduledPassLimits) { this.limits = limits; }

  get used(): number { return this.d1 + this.external; }
  /** What jobs may still spend: the total less the closing reserve. */
  private get ceiling(): number { return this.limits.total - (this.closing ? 0 : this.limits.reserve); }

  /** Whether the pass can still afford this much more, without asking for another slice when it cannot. */
  fits(cost: PassCost): boolean {
    const d1 = cost.d1 ?? 0, external = cost.external ?? 0;
    return this.used + d1 + external <= this.ceiling && this.d1 + d1 <= this.limits.d1 && this.external + external <= this.limits.external;
  }
  /** Whether the pass can still afford this much more. A refusal marks the pass as having more work to come back to. */
  allows(cost: PassCost): boolean {
    const allowed = this.fits(cost);
    if (!allowed) this.exhausted = true;
    return allowed;
  }
  /** A job stopped at its per-slice cap with work left, so the scheduler should run it again soon. */
  more() { this.exhausted = true; }
  private charge(kind: "d1" | "external", count: number) {
    if (this.used + count > this.ceiling) { this.refused += 1; this.exhausted = true; throw new SchedulerBudgetError(kind === "d1" ? "D1 query" : "provider request"); }
    this[kind] += count;
  }
  chargeD1(count = 1) { this.charge("d1", count); }
  chargeExternal(count = 1) { this.charge("external", count); }
  defer(jobId: string) { this.deferred.push(jobId); }
  /** The jobs are done: the closing state write may now use the reserve. */
  close() { this.closing = true; }
  /** A slice that has to run as a whole pass (see the scheduler's stateless fallback) takes the pass's limits. */
  widen(limits: PassLimits) { this.limits = limits; }
  snapshot() { return { d1Queries: this.d1, externalRequests: this.external, deferred: [...this.deferred] }; }

  /** The database as seen by the pass: each first, all, run or raw, and each batch, charges one query. */
  database(database: D1Database): D1Database {
    const originals = new WeakMap<D1Statement, D1Statement>();
    // A refused query rejects like any failed query rather than throwing from the call itself.
    const charged = <T>(work: () => Promise<T>): Promise<T> => { try { this.chargeD1(); } catch (error) { return Promise.reject(error); } return work(); };
    const wrap = (statement: D1Statement): D1Statement => {
      const wrapped: D1Statement = {
        bind: (...values) => wrap(statement.bind(...values)),
        first: <T>() => charged(() => statement.first<T>()),
        all: <T>() => charged(() => statement.all<T>()),
        run: () => charged(() => statement.run()),
      };
      const raw = (statement as D1Statement & { raw?: (...args: unknown[]) => Promise<unknown> }).raw;
      if (raw) Object.assign(wrapped, { raw: (...args: unknown[]) => charged(() => raw.apply(statement, args)) });
      originals.set(wrapped, statement);
      return wrapped;
    };
    const counted: D1Database = {
      prepare: (query) => wrap(database.prepare(query)),
      batch: (statements) => charged(() => database.batch(statements.map((statement) => originals.get(statement) ?? statement))),
    };
    return preserveDatabaseIdentity(counted, database);
  }
}

/** The 5-minute slot a pass belongs to. */
export function passSlot(scheduledTime: number, interval = 300_000): number {
  return Math.floor((Number.isFinite(scheduledTime) ? scheduledTime : Date.now()) / interval);
}

/** The jobs in this pass's order: each slot starts one job later, so a job the budget defers runs early in a later pass. */
export function rotateJobs<T>(jobs: readonly T[], slot: number): T[] {
  if (!jobs.length) return [];
  const start = ((Math.trunc(slot) % jobs.length) + jobs.length) % jobs.length;
  return [...jobs.slice(start), ...jobs.slice(0, start)];
}
