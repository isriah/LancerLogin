// The background scheduler, built to fit one deployment on the Cloudflare Workers Free plan (10 ms CPU per HTTP request
// or cron trigger, 50 subrequests per invocation counting D1 queries and outbound requests together (see
// scheduler-budget.ts), 100,000 Durable Object requests a day).
//
// Work runs in slices. A slice opens with one D1 batch (maintenance, runnable modules, scheduler state), runs ONE job's
// small batch under its own SchedulerBudget, and records the outcome in D1 (platform_scheduler_state). The state lives
// in D1, not in the Durable Object, so status, Stop and the cron fallback read the same thing on every deployment.
//
// With the PLATFORM_SCHEDULER Durable Object bound, its alarm runs one slice per invocation and re-arms itself: about a
// second later while a job reports more work, otherwise when the next job falls due. Writes that create work poke the
// alarm so that work goes out within seconds. The 5-minute cron is then only a watchdog that re-arms a missing alarm.
// Without the binding, the cron runs the slices itself, each due job's slice once per tick within one pass budget.
//
// Exactly one of the two runs jobs. `schedulerRunner` decides which from the deployment's environment, and the Worker
// and the object both use it: in cron mode the object runs no slice and arms no alarm (an alarm armed before the switch
// stands down when it fires), and each cron tick first tells a bound object to stand down, which also waits for a slice
// still in flight.
import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";

export type JobOutcome = "waiting" | "running" | "ok" | "failed" | "paused";
/** `cursor` is the step a job split into several slices continues from (see JobRunResult). */
export type JobState = { next: number; last: number | null; outcome: JobOutcome; cursor?: string };
export type JobStates = Record<string, JobState>;
/**
 * A job's run may resolve `{ more: true }` to ask for another slice as soon as possible, and with it a `cursor` naming
 * the step that slice should take. The scheduler keeps the cursor in the job's state and hands it back (as
 * `schedulerPass.cursor`) on the job's next run, so a job can do one step per slice and still finish all of them
 * within seconds. Without `more` the cursor is dropped and the job starts from its first step next time.
 */
export type JobRunResult = { more?: boolean; cursor?: string } | void | unknown;
/** The cursor a run asked to continue from, if it is a short string. */
export function runCursor(result: JobRunResult): string | undefined {
  const cursor = result && typeof result === "object" ? (result as { cursor?: unknown }).cursor : undefined;
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 64 ? cursor : undefined;
}
export interface SchedulerJob<E> {
  id: string;
  interval: number;
  /** Housekeeping inside the installation (no provider requests); it still runs while delivery is stopped. */
  internal?: boolean;
  enabled?: (env: E) => Promise<boolean>;
  run(env: E): Promise<JobRunResult>;
}

/** How long an Admin's Stop lasts before delivery resumes by itself. */
export const SCHEDULER_STOP_MS = 24 * 3_600_000;
/** The delay before the next slice while a job reports more work. */
export const SLICE_CONTINUE_MS = 1_000;
/**
 * The delay before retrying a slice that could not run (maintenance, or a slice that threw). A slice that keeps throwing
 * doubles it each time up to SLICE_IDLE_MAX_MS, so a persistent failure settles at one attempt every five minutes.
 */
export const SLICE_RETRY_MS = 30_000;
/** Slices the platform may stop in a row on one job before that job is marked failed and waits out its interval. */
export const SLICE_CRASH_LIMIT = 2;
/** The longest an idle alarm sleeps; the watchdog re-arms one that is missing, and this bounds one that is late. */
export const SLICE_IDLE_MAX_MS = 5 * 60_000;
/**
 * Continuation slices allowed per UTC day before continuations slow to one a minute. Each slice is one Durable Object
 * request; a job that keeps reporting more work (for example a provider that keeps failing in a way it retries) must
 * not use up the Free plan's 100,000 a day. At this cap a whole day stays below about 12,000 requests with idle wakes.
 */
export const SLICE_DAILY_CONTINUATIONS = 10_000;
export const SLICE_SLOW_CONTINUE_MS = 60_000;

/** Which runner a deployment's environment selects; PLATFORM_SCHEDULER_MODE "cron" keeps the cron fallback. */
export type SchedulerRunner = "durable" | "cron";
type RunnerEnvironment = { PLATFORM_SCHEDULER?: unknown; PLATFORM_SCHEDULER_MODE?: string };
/** Whether the deployment forces the cron fallback. The Durable Object reads this too, so both sides agree. */
export const cronSchedulerForced = (env: RunnerEnvironment) => env.PLATFORM_SCHEDULER_MODE === "cron";
/** The one runner that may run jobs: the Durable Object whenever it is bound, unless the cron fallback is forced. */
export const schedulerRunner = (env: RunnerEnvironment): SchedulerRunner => env.PLATFORM_SCHEDULER && !cronSchedulerForced(env) ? "durable" : "cron";

const outcomes: ReadonlySet<string> = new Set(["waiting", "running", "ok", "failed", "paused"]);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function validateSchedulerRegistry<E>(jobs: readonly SchedulerJob<E>[]): void {
  if (!jobs.length || new Set(jobs.map((job) => job.id)).size !== jobs.length || jobs.some((job) => !Number.isSafeInteger(job.interval) || job.interval < 300_000)) throw new Error("Invalid scheduler registry");
}

/** Each registered job's stored state; a job without valid state is due now, and state for unknown jobs is dropped. */
export function jobStates<E>(jobs: readonly SchedulerJob<E>[], stored: unknown, now: number): JobStates {
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const states: JobStates = {};
  for (const job of jobs) {
    const value = source[job.id] as Partial<JobState> | undefined;
    states[job.id] = value && timestamp(value.next) && (value.last === null || timestamp(value.last)) && typeof value.outcome === "string" && outcomes.has(value.outcome)
      ? { next: value.next, last: value.last, outcome: value.outcome, ...(typeof value.cursor === "string" && value.cursor.length > 0 && value.cursor.length <= 64 ? { cursor: value.cursor } : {}) }
      : { next: now, last: null, outcome: "waiting" };
  }
  return states;
}

export function parseJobStates<E>(jobs: readonly SchedulerJob<E>[], json: string | null | undefined, now: number): JobStates {
  try { return jobStates(jobs, json ? JSON.parse(json) : {}, now); } catch { return jobStates(jobs, {}, now); }
}

/** When a job is due: its stored time, or now if a write poked it after its last attempt. */
function dueAt(state: JobState, poked: number | undefined, now: number): number {
  return poked !== undefined && (state.last === null || poked >= state.last) ? Math.min(state.next, now) : state.next;
}

/**
 * The due jobs in the order slices take them: earliest due first; ties keep `order` (the registry order, rotated by the
 * cron fallback so that each tick starts one job later). `slack` lets a cron tick take a job due just after the tick.
 */
export function dueJobs<E>(jobs: readonly SchedulerJob<E>[], states: JobStates, now: number, options: { pokes?: Readonly<Record<string, number>>; slack?: number; internalOnly?: boolean } = {}): SchedulerJob<E>[] {
  const slack = options.slack ?? 0;
  return jobs
    .map((job, index) => ({ job, index, due: dueAt(states[job.id]!, options.pokes?.[job.id], now) }))
    .filter(({ job, due }) => due <= now + slack && (!options.internalOnly || job.internal))
    .sort((left, right) => left.due - right.due || left.index - right.index)
    .map(({ job }) => job);
}

/** When the next slice should run, given the state after this one. */
export function nextWake<E>(jobs: readonly SchedulerJob<E>[], states: JobStates, now: number, options: { pokes?: Readonly<Record<string, number>>; pausedUntil?: number | null } = {}): number {
  const paused = options.pausedUntil !== undefined && options.pausedUntil !== null && options.pausedUntil > now;
  let earliest = now + SLICE_IDLE_MAX_MS;
  for (const job of jobs) {
    // While delivery is stopped only internal jobs run; the rest wait for the Stop to expire.
    const due = paused && !job.internal ? options.pausedUntil! : dueAt(states[job.id]!, options.pokes?.[job.id], now);
    earliest = Math.min(earliest, due);
  }
  return Math.max(now, earliest);
}

export function moduleSchedulerJobs<E>(application: {
  modules: readonly ModuleDefinition[];
  enabled(moduleId: string, env: E): Promise<boolean>;
  runJob(jobId: string, env: E): Promise<JobRunResult>;
}): readonly SchedulerJob<E>[] {
  return Object.freeze(application.modules.flatMap((module) => module.available ? module.jobs.map((job) => Object.freeze({
    id: job.id,
    interval: job.interval,
    enabled: (env: E) => application.enabled(module.id, env),
    run: (env: E) => application.runJob(job.id, env),
  })) : []));
}

// ---- The Durable Object ----

export interface SchedulerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<boolean | void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}
export interface SchedulerState { storage: SchedulerStorage; }
export interface SchedulerNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> }; }
/** What one slice did, for the alarm to decide when to run the next. */
export type SliceResult = { ran?: string; more?: boolean; nextWake: number };
/**
 * A slice the platform stopped part-way: its job, when it started, and how many slices in a row stopped on that job.
 * One stop is usually a deploy or an eviction resetting the object, not the job's fault.
 */
export type InFlight = { job: string; at: number; count?: number };
/**
 * How the Durable Object follows a slice. `started` records the job before it runs, in the object's own storage rather
 * than with a D1 write; `crashed` is the job a previous alarm started but never finished. The first time, the slice
 * simply runs the job again (it is still due). At SLICE_CRASH_LIMIT stops in a row the slice moves on from it (marked
 * failed, next due after its interval), so one job the platform keeps stopping cannot hold up the others.
 */
export type SliceHooks = { crashed?: InFlight; started(job: string): Promise<void> };
export type Pokes = Record<string, number>;

/** Requests the Worker sends its own scheduler object. The object is reachable only through this Worker's binding. */
export const schedulerRequest = (action: "poke" | "watchdog" | "status" | "standdown", body?: unknown) => new Request(`https://scheduler.internal/${action}`, action === "status" ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/**
 * `active` says whether this object is the deployment's runner (see schedulerRunner). While it is not, the object runs
 * no slice and keeps no alarm armed.
 */
export function schedulerClass<E>(jobs: readonly SchedulerJob<E>[], runSlice: (env: E, pokes: Pokes, hooks: SliceHooks) => Promise<SliceResult>, now: () => number = Date.now, active: (env: E) => boolean = () => true) {
  validateSchedulerRegistry(jobs);
  const known = new Set(jobs.map((job) => job.id));
  return class {
    private tail: Promise<unknown> = Promise.resolve();
    private state: SchedulerState;
    private env: E;

    constructor(state: SchedulerState, env: E) { this.state = state; this.env = env; }

    /** Control requests and alarms run one at a time, so a poke never interleaves with a slice. */
    private serial<T>(work: () => Promise<T>): Promise<T> {
      const result = this.tail.then(work);
      this.tail = result.catch(() => undefined);
      return result;
    }

    /** Arm the alarm for `time` unless it is already armed sooner. */
    private async arm(time: number): Promise<number> {
      const current = await this.state.storage.getAlarm();
      if (current !== null && current <= time) return current;
      await this.state.storage.setAlarm(time);
      return time;
    }

    fetch(request: Request): Promise<Response> {
      return this.serial(async () => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/status") return Response.json({ alarm: await this.state.storage.getAlarm() }, { headers: { "cache-control": "no-store" } });
        if (request.method !== "POST") return new Response(null, { status: 404 });
        // The cron fallback is the runner: nothing stays armed here. Requests run one at a time with alarms, so by the
        // time this answers no slice is in flight either, and the cron pass that asked may start.
        if (path === "/standdown" || ((path === "/watchdog" || path === "/poke") && !active(this.env))) {
          await this.standDown();
          return Response.json({ alarm: null, standby: true });
        }
        if (path === "/watchdog") {
          // The cron's only scheduler work: an alarm lost to an error, a deploy or an eviction is re-armed.
          const current = await this.state.storage.getAlarm();
          if (current !== null) return Response.json({ alarm: current, rearmed: false });
          return Response.json({ alarm: await this.arm(now()), rearmed: true });
        }
        if (path === "/poke") {
          const input = await request.json().catch(() => ({})) as { jobs?: unknown };
          const ids = Array.isArray(input.jobs) ? input.jobs.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
          const at = now();
          if (ids.length) {
            const pokes = await this.state.storage.get<Pokes>("pokes") ?? {};
            for (const id of ids) pokes[id] = at;
            await this.state.storage.put("pokes", pokes);
          }
          return Response.json({ alarm: await this.arm(at + SLICE_CONTINUE_MS) });
        }
        return new Response(null, { status: 404 });
      });
    }

    /** Leave the work to the cron fallback: no alarm, and no record of a slice in flight. */
    private async standDown(): Promise<void> {
      if (await this.state.storage.getAlarm() !== null) await this.state.storage.deleteAlarm();
      if (await this.state.storage.get<InFlight>("inflight")) await this.state.storage.delete?.("inflight");
    }

    alarm(): Promise<void> {
      return this.serial(async () => {
        // An alarm armed before the deployment switched to the cron fallback: it runs nothing and is not re-armed.
        if (!active(this.env)) { await this.standDown(); return; }
        const started = now();
        const pokes = await this.state.storage.get<Pokes>("pokes") ?? {};
        const stopped = await this.state.storage.get<InFlight>("inflight");
        const crashed = stopped && known.has(stopped.job) ? { ...stopped, count: stopped.count ?? 1 } : undefined;
        let marked = false;
        // A job that stops the slice again carries its count forward; any other job starts from one.
        const hooks: SliceHooks = { ...(crashed ? { crashed } : {}), started: async (job) => { marked = true; await this.state.storage.put("inflight", { job, at: started, count: crashed && crashed.job === job ? crashed.count + 1 : 1 }); } };
        let result: SliceResult; let threw = false;
        try { result = await runSlice(this.env, pokes, hooks); }
        catch { threw = true; result = { nextWake: started }; }
        // A slice that keeps throwing (D1 unreachable, for example) backs off: 30 s, 1 min, 2 min, 4 min, then every 5.
        const failures = await this.state.storage.get<number>("failures") ?? 0;
        if (threw) {
          await this.state.storage.put("failures", failures + 1);
          result = { nextWake: started + Math.min(SLICE_IDLE_MAX_MS, SLICE_RETRY_MS * 2 ** Math.min(failures, 8)) };
        } else if (failures) await this.state.storage.put("failures", 0);
        // Reached only when the slice finished (or failed in JavaScript): the platform did not stop it.
        if (marked || stopped) await this.state.storage.delete?.("inflight");
        // A poke that arrived after the slice started stays for the next one.
        if (result.ran && pokes[result.ran] !== undefined && pokes[result.ran]! <= started) {
          delete pokes[result.ran];
          await this.state.storage.put("pokes", pokes);
        }
        let wake = Math.max(result.nextWake, started + SLICE_CONTINUE_MS);
        if (wake - started < SLICE_SLOW_CONTINUE_MS && result.more) {
          const day = new Date(started).toISOString().slice(0, 10);
          const counter = await this.state.storage.get<{ day: string; count: number }>("continuations");
          const count = counter?.day === day ? counter.count + 1 : 1;
          await this.state.storage.put("continuations", { day, count });
          if (count > SLICE_DAILY_CONTINUATIONS) wake = Math.max(wake, started + SLICE_SLOW_CONTINUE_MS);
        }
        await this.state.storage.setAlarm(wake);
      });
    }
  };
}
