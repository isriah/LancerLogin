// The budget of one scheduler invocation: a Durable Object alarm's single slice, or the cron fallback's pass over every
// due job. The Workers Free plan allows 50 D1 queries and 50 external requests per invocation (a db.batch is one query);
// past either limit the platform fails the rest of the invocation. The budget counts every D1 query and provider request
// instead; each job checks it before it starts and before each item of its batch. A job the budget stops part-way, or
// one that stops at its own per-slice cap (see `more`), reports more work, and the scheduler runs it again shortly.
import { preserveDatabaseIdentity, type D1Database, type D1Statement } from "./d1-usage.ts";

export type PassCost = { readonly d1?: number; readonly external?: number };
export type PassLimits = { readonly d1: number; readonly external: number };

/** A few queries and requests below the Free plan's 50 each, for a job's closing writes. The cron fallback's pass. */
export const scheduledPassLimits: PassLimits = Object.freeze({ d1: 46, external: 46 });
/**
 * One Durable Object slice: one job's small batch, well inside 50 of each, so the slice also stays near its CPU share.
 * The slice's own state read and two state writes come out of the same budget.
 */
export const scheduledSliceLimits: PassLimits = Object.freeze({ d1: 30, external: 12 });
/** What a job needs left to be worth starting: its readiness checks and at least one item. */
export const scheduledJobStartCost: PassCost = Object.freeze({ d1: 6, external: 1 });

export class SchedulerBudget {
  d1 = 0;
  external = 0;
  readonly deferred: string[] = [];
  /** Whether a check found the budget too small for the next item, or a job said it stopped at its own cap. */
  exhausted = false;
  readonly limits: PassLimits;
  constructor(limits: PassLimits = scheduledPassLimits) { this.limits = limits; }

  /** Whether the pass can still afford this much more. */
  allows(cost: PassCost): boolean {
    const allowed = this.d1 + (cost.d1 ?? 0) <= this.limits.d1 && this.external + (cost.external ?? 0) <= this.limits.external;
    if (!allowed) this.exhausted = true;
    return allowed;
  }
  /** A job stopped at its per-slice cap with work left, so the scheduler should run it again soon. */
  more() { this.exhausted = true; }
  chargeD1(count = 1) { this.d1 += count; }
  chargeExternal(count = 1) { this.external += count; }
  defer(jobId: string) { this.deferred.push(jobId); }
  snapshot() { return { d1Queries: this.d1, externalRequests: this.external, deferred: [...this.deferred] }; }

  /** The database as seen by the pass: each first, all, run or raw, and each batch, charges one query. */
  database(database: D1Database): D1Database {
    const originals = new WeakMap<D1Statement, D1Statement>();
    const wrap = (statement: D1Statement): D1Statement => {
      const wrapped: D1Statement = {
        bind: (...values) => wrap(statement.bind(...values)),
        first: <T>() => { this.chargeD1(); return statement.first<T>(); },
        all: <T>() => { this.chargeD1(); return statement.all<T>(); },
        run: () => { this.chargeD1(); return statement.run(); },
      };
      const raw = (statement as D1Statement & { raw?: (...args: unknown[]) => Promise<unknown> }).raw;
      if (raw) Object.assign(wrapped, { raw: (...args: unknown[]) => { this.chargeD1(); return raw.apply(statement, args); } });
      originals.set(wrapped, statement);
      return wrapped;
    };
    const counted: D1Database = {
      prepare: (query) => wrap(database.prepare(query)),
      batch: (statements) => { this.chargeD1(); return database.batch(statements.map((statement) => originals.get(statement) ?? statement)); },
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
