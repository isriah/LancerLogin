import { pruneAuthProtection } from "../auth-protection.ts";
import { webUpdateMaintenanceStatement } from "../web-updates.ts";
import { pruneStaleRows, pruneStaleRowsWith } from "../stale-row-pruning.ts";
import { pruneDiscordKioskCodes } from "../discord-kiosk-codes.ts";
import { type D1Database } from "../d1-usage.ts";
import { correctParticipationStarts, startCorrectionStateRead } from "../participation-start-correction.ts";
import { SchedulerBudget, SchedulerBudgetError, rotateJobs, scheduledJobStartCost, scheduledPassLimits, scheduledSliceLimits, type PassCost, type PassLimits } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { moduleServiceGenerations, moduleServiceGenerationsStatement, requireModuleService } from "../module-platform.ts";
import { captureModuleServiceDatabase } from "../module-database-scope.ts";
import { reconcileInstalledModules } from "../module-catalog.ts";
import { runModuleCleanup } from "../module-cleanup.ts";
import { SCHEDULER_STOP_MS, SLICE_CONTINUE_MS, SLICE_CRASH_LIMIT, SLICE_IDLE_MAX_MS, SLICE_RETRY_MS, cronSchedulerForced, dueJobs, moduleSchedulerJobs, nextWake, parseJobStates, runCursor, schedulerClass, schedulerRequest, type JobRunResult, type JobStates, type Pokes, type SchedulerJob, type SliceHooks, type SliceResult } from "../platform-scheduler.ts";
import { type Env, type SchedulerPass, type WorkerContext, auditStatement, isObject, moduleScopedEnvironment, parseJson, passAllows, passFits, requireDatabase, requireRole, response } from "./core.ts";
import { durableScheduler, pausedUntilTime, pokeScheduler, schedulerJobsFor, schedulerObject, schedulerStateTime } from "./delivery.ts";
import { autoReconcileDiscordCommands } from "./discord-commands.ts";
import { apiModules, attendanceRuntime, coreModuleServices, moduleEnvironment } from "./module-runtime.ts";


async function moduleJobEnabled(moduleId: string, env: Env): Promise<boolean> {
  if (env.schedulerPass) return env.schedulerPass.moduleGenerations.has(moduleId);
  try { await requireModuleService(requireDatabase(env), moduleId); return true; }
  catch (error) { if (error instanceof HttpError && [409, 503].includes(error.status)) return false; throw error; }
}

async function runRegisteredModuleJob(jobId: string, env: Env): Promise<JobRunResult> {
  const owner = bundledModuleRegistry.modules.find((module) => module.jobs.some((job) => job.id === jobId));
  const handler = owner && apiModules.get(owner.id)?.jobs?.[jobId];
  if (!owner || !handler) throw new Error("Registered module job is unavailable");
  // Every statement the job runs rechecks this generation, so a module disabled during the pass stops there.
  const db = requireDatabase(env); const generation = env.schedulerPass?.moduleGenerations.get(owner.id) ?? await requireModuleService(db, owner.id);
  const scopedDatabase = captureModuleServiceDatabase(db, owner.id, generation); const scopedEnvironment = moduleScopedEnvironment(env, scopedDatabase);
  const pass = env.schedulerPass;
  return await handler({ env: moduleEnvironment(owner.id, scopedEnvironment), db: scopedDatabase, services: coreModuleServices(scopedEnvironment, owner.id), ...(pass ? { scheduler: Object.freeze({ steps: pass.steps === true, ...(pass.cursor ? { cursor: pass.cursor } : {}) }) } : {}) });
}

export const registeredModuleSchedulerJobs = moduleSchedulerJobs<Env>({ modules: bundledModuleRegistry.modules, enabled: moduleJobEnabled, runJob: runRegisteredModuleJob });
/**
 * Installation housekeeping: module reconciliation, expired sign-in throttles, and module cleanup. On the Durable Object
 * each is its own slice, a second apart, so the slice that leads every five-minute round (and pays for waking the
 * object) stays small; the cron fallback runs all three in one pass as before. A cleanup with rows left asks for another
 * slice instead of looping inside this one.
 */
// What each housekeeping step may cost before it starts. Each is checked against the pass budget first, so a step that
// does not fit is left for the next round (the cron fallback) or the next slice instead of being cut off part-way.
const HOUSEKEEPING_RECONCILE_COST: PassCost = { d1: 8 };
const HOUSEKEEPING_PRUNE_COST: PassCost = { d1: 4 };
const HOUSEKEEPING_CLEANUP_COST: PassCost = { d1: 8 };
/**
 * One pass of the participation start correction (participation-start-correction.ts). Returns whether members are left
 * to examine. `read` is its state when the clean-up batch already read it; without it the pass reads the state itself.
 * A failure (a schema before migration 0107 has no state table) is left for a later round.
 */
async function correctStoredParticipationStarts(env: Env, db: D1Database, read?: { row: unknown }): Promise<boolean> {
  if (!read && !passFits(env, { d1: 1 })) return false;
  try { return (await correctParticipationStarts(db, { fits: (queries) => passAllows(env, { d1: queries }), ...(read ? { read: read.row } : {}) })).more; }
  catch (error) { if (error instanceof SchedulerBudgetError) throw error; return false; }
}
async function runSchedulerHousekeeping(env: Env): Promise<JobRunResult> {
  const db = requireDatabase(env); const step = env.schedulerPass?.steps ? env.schedulerPass.cursor ?? "reconcile" : undefined;
  // A step the budget cannot cover ends the run. The failed check marks the pass as having more work; on the cron
  // fallback that only means the next tick, which starts housekeeping from its first step again.
  const fits = (cost: PassCost) => passAllows(env, cost);
  if (!step || step === "reconcile") {
    if (!fits(HOUSEKEEPING_RECONCILE_COST)) return step ? { more: true, cursor: "reconcile" } : {};
    try { await reconcileInstalledModules(db); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; /* Reconciliation retries on the next round and on requests. */ }
    if (step) return { more: true, cursor: "prune" };
  }
  if (!step || step === "prune") {
    if (!fits(HOUSEKEEPING_PRUNE_COST)) return step ? { more: true, cursor: "prune" } : {};
    try { await pruneAuthProtection(db); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; /* Expired throttle rows are pruned on a later round. */ }
    // One batch: used and expired kiosk codes, PIN requests, label previews and report ids 30 days past their use,
    // email sends left pending past their stale age, marked failed so they stop blocking Attendance disablement, and a
    // few finished rows of the tables retainedRowPruning lists, so the step's cost is unchanged.
    // A schema before 0101 lacks one of its tables, and then the codes are removed alone, as before; one before 0100 has none.
    // The same batch reads where the one-time correction of stored participation start dates is. Once that is complete
    // it costs nothing more; while it has members left it takes slices of its own before cleanup, so this one stays small.
    let starts: { row: unknown } | undefined;
    // A schema before 0107 has no state to read, and then the clean-up runs without it.
    try { starts = { row: (await pruneStaleRowsWith(db, [startCorrectionStateRead(db)])).alongside[0]?.results?.[0] }; }
    catch (first) {
      if (first instanceof SchedulerBudgetError) throw first;
      try { await pruneStaleRows(db); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; try { await pruneDiscordKioskCodes(db); } catch (inner) { if (inner instanceof SchedulerBudgetError) throw inner; /* Pruned on a later round. */ } }
    }
    const startsLeft = starts ? await correctStoredParticipationStarts(env, db, starts) : false;
    if (step) return { more: true, cursor: startsLeft ? "starts" : "cleanup" };
  }
  if (step === "starts" && await correctStoredParticipationStarts(env, db)) return { more: true, cursor: "starts" };
  if (!fits(HOUSEKEEPING_CLEANUP_COST)) return step ? { more: true, cursor: "cleanup" } : {};
  return (await runModuleCleanup(db)).status === "progress" ? { more: true, cursor: "cleanup" } : {};
}
export const registeredCoreSchedulerJobs: readonly SchedulerJob<Env>[] = Object.freeze([
  Object.freeze({ id: "core.housekeeping", interval: 300_000, internal: true, run: runSchedulerHousekeeping }),
  Object.freeze({ id: "core.discord-commands", interval: 300_000, run: autoReconcileDiscordCommands }),
]);
export const registeredPlatformSchedulerJobs = Object.freeze([...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs]);
// Core's jobs check the budget before each item, so they start with a small reserve. A plugin's job cannot see the
// budget, so it starts only with room for its own checks and a short batch.
const selfLimitingJobs: ReadonlySet<string> = new Set([...registeredCoreSchedulerJobs.map((job) => job.id), ...Object.keys(attendanceRuntime.jobs)]);
const pluginJobStartCost: PassCost = Object.freeze({ d1: 12, external: 3 });
/** The jobs a module's own writes poke: a plugin route that queues work gets its jobs run within seconds. */
const moduleSchedulerJobIds = (moduleId: string) => (bundledModuleRegistry.modules.find((module) => module.id === moduleId)?.jobs ?? []).map((job) => job.id);

type SchedulerStateRow = { pausedUntil: string | null; pausedAt: string | null; pausedBy: string | null; jobsJson: string | null; updatedAt: string | null };
const schedulerStateSql = "SELECT paused_until AS pausedUntil, paused_at AS pausedAt, paused_by AS pausedBy, jobs_json AS jobsJson, updated_at AS updatedAt FROM platform_scheduler_state WHERE installation_id = 'primary'";
/**
 * Writes the state of the named jobs only, each set in place inside jobs_json, so a write never puts back what its
 * runner read earlier for a job it did not run: two writers (a cron pass and a slice during a change of mode, or two
 * deliveries of one cron tick) no longer overwrite each other's jobs. The state row exists only once the installation
 * does; until then nothing is written and every job is due.
 *
 * `claim` makes the write a compare-and-swap on the row as the runner read it (its updated_at, or null for no row):
 * it changes nothing when another runner wrote first, and the caller then leaves the jobs to that runner.
 */
function schedulerJobsWrite(db: D1Database, jobs: JobStates, ids: readonly string[], now: number, claim?: { readAt: string | null }) {
  const touched = Object.fromEntries(ids.map((id) => [id, jobs[id]!]));
  const sets = ids.map(() => ", ?, json(?)").join("");
  const guard = claim ? " WHERE platform_scheduler_state.updated_at IS ?" : "";
  return db.prepare(`INSERT INTO platform_scheduler_state (installation_id, jobs_json, updated_at) SELECT 'primary', ?, ? WHERE EXISTS (SELECT 1 FROM installations WHERE id = 'primary') ON CONFLICT(installation_id) DO UPDATE SET jobs_json = json_set(platform_scheduler_state.jobs_json${sets}), updated_at = excluded.updated_at${guard}`)
    .bind(JSON.stringify(touched), schedulerStateTime(now, claim?.readAt), ...ids.flatMap((id) => [`$.${JSON.stringify(id)}`, JSON.stringify(jobs[id])]), ...(claim ? [claim.readAt] : []));
}
/**
 * The jobs a successful write should poke, by route: writes that queue calendar operations, label role changes, notice
 * changes, channel changes, or a plugin's own work (its publication requests or visit notifications, for example).
 * Kiosk scans, reads and previews (responses made with previewResponse) never poke.
 */
export function schedulerPokesFor(pathname: string): readonly string[] {
  if (/^\/(meetings|meeting-series|meeting-templates|calendars\/sync|discord\/calendar)(\/|$)/.test(pathname) || /^\/admin\/integrations\/(google-calendar|discord\/calendar)(\/|$)/.test(pathname)) return [...schedulerJobsFor.calendar, ...schedulerJobsFor.notices];
  // Delete attendance data leaves remote calendar events for the calendar jobs to remove.
  if (pathname === "/admin/data") return schedulerJobsFor.calendar;
  if (/^\/labels(\/|$)/.test(pathname) || pathname.startsWith("/admin/integrations/discord/label-roles")) return schedulerJobsFor.labels;
  if (pathname === "/admin/integrations/discord/anomaly-reports" || pathname === "/discord/missing") return schedulerJobsFor.notices;
  if (pathname === "/admin/integrations/discord/channel-manager" || pathname === "/discord/kiosk-status") return schedulerJobsFor.channel;
  const owner = bundledModuleRegistry.routeOwner(pathname)?.module;
  return owner && owner.id !== "attendance" ? moduleSchedulerJobIds(owner.id) : [];
}

/**
 * `hooks` is set by the Durable Object: it records the running job in its own storage instead of the D1 "running" write,
 * saving one D1 query in every slice. `steps` lets a job split its work into one step per slice (see JobRunResult).
 */
type SchedulerPassOptions = { now?: number; pokes?: Pokes; maxJobs: number; limits: PassLimits; slack?: number; order?: number; hooks?: SliceHooks; steps?: boolean };
/**
 * `skipped: "claimed"` is a cron pass that found another runner had written the state since it read it, and left the
 * jobs to that runner. `stateless` is a pass that could not read the scheduler state and so kept none.
 */
export type SchedulerPassReport = SliceResult & { attempted: string[]; deferred: string[]; d1Queries: number; externalRequests: number; skipped?: "maintenance" | "unconfigured" | "claimed"; stateless?: boolean };
/**
 * One scheduler invocation's work. A Durable Object alarm runs it with maxJobs 1 (one slice); the cron fallback runs it
 * over every due job. It opens with one batched read, marks the jobs it takes as running with their next time already
 * set (so a slice the platform kills still lets other jobs go next), runs them, and writes their outcomes.
 */
export async function runSchedulerPass(env: Env, options: SchedulerPassOptions): Promise<SchedulerPassReport> {
  const now = options.now ?? Date.now();
  const budget = new SchedulerBudget(options.limits);
  const report = (result: Omit<SchedulerPassReport, "d1Queries" | "externalRequests">): SchedulerPassReport => ({ ...result, d1Queries: budget.d1, externalRequests: budget.external });
  if (!env.DB) return report({ nextWake: now + SLICE_IDLE_MAX_MS, attempted: [], deferred: [], skipped: "unconfigured" });
  const passEnv: Env = { ...env, DB: budget.database(env.DB) }; const db = requireDatabase(passEnv);
  let maintenance: { results?: unknown[] } | undefined, modules: { results?: unknown[] } | undefined, stateRow: SchedulerStateRow | null = null, stateKept = true;
  try {
    const [maintenanceResult, moduleResult, stateResult] = await db.batch([webUpdateMaintenanceStatement(db), moduleServiceGenerationsStatement(db), db.prepare(schedulerStateSql)]);
    maintenance = maintenanceResult; modules = moduleResult; stateRow = (stateResult?.results?.[0] as SchedulerStateRow | undefined) ?? null;
  } catch {
    // Without the state table (an installation whose migrations have not reached 0097) the jobs still run, as the
    // cron ran them before, with no state kept.
    stateKept = false;
    const [maintenanceResult, moduleResult] = await db.batch([webUpdateMaintenanceStatement(db), moduleServiceGenerationsStatement(db)]);
    maintenance = maintenanceResult; modules = moduleResult;
  }
  // Due work stays intact while an update holds maintenance; a later slice resumes it without another command.
  if (maintenance?.results?.length) return report({ nextWake: now + SLICE_RETRY_MS, attempted: [], deferred: [], skipped: "maintenance" });
  const pausedUntil = pausedUntilTime(stateRow, now);
  const states = parseJobStates(registeredPlatformSchedulerJobs, stateRow?.jobsJson, now);
  // Without state every job looks due on every invocation, and a job's request for another slice could never be
  // recorded as served: a Durable Object would run the first job's first step again every second. So a slice without
  // state runs as the cron fallback's pass does (every due job once, each job's steps together, the pass's limits) and
  // then sleeps the idle maximum, however much work the jobs report.
  const stateless = !stateKept; const steps = options.steps === true && !stateless;
  const maxJobs = stateless ? registeredPlatformSchedulerJobs.length : options.maxJobs;
  if (stateless && options.steps) budget.widen(scheduledPassLimits);
  // A job whose slice the platform stopped (it never reached its closing write). Once is usually a deploy or an eviction
  // resetting the object mid-slice, so the job is simply still due and runs again. At SLICE_CRASH_LIMIT in a row the
  // job itself is the likely cause and it moves on: failed, due after its interval.
  const crashed = options.hooks?.crashed; const stoppedJob = crashed && registeredPlatformSchedulerJobs.find((job) => job.id === crashed.job);
  const crashedJob = stoppedJob && (crashed!.count ?? SLICE_CRASH_LIMIT) >= SLICE_CRASH_LIMIT ? stoppedJob : undefined;
  if (crashedJob) states[crashedJob.id] = { next: now + crashedJob.interval, last: crashed!.at, outcome: "failed" };
  const pokes = crashedJob ? withoutPokes(options.pokes, [crashedJob.id]) : options.pokes;
  const ordered = rotateJobs(registeredPlatformSchedulerJobs, options.order ?? 0);
  const due = dueJobs(ordered, states, now, { pokes, slack: options.slack, internalOnly: pausedUntil !== null }).slice(0, maxJobs);
  if (!due.length) {
    budget.close();
    if (crashedJob && stateKept) await schedulerJobsWrite(db, states, [crashedJob.id], now).run();
    return report({ ran: crashedJob?.id, nextWake: nextWake(registeredPlatformSchedulerJobs, states, now, { pokes, pausedUntil }), attempted: [], deferred: [] });
  }
  const before = structuredClone(states);
  for (const job of due) states[job.id] = { next: now + job.interval, last: now, outcome: "running" };
  // The ids this invocation writes at its close: the jobs it took, and a job it moved on from.
  const written = [...new Set([...due.map((job) => job.id), ...(crashedJob ? [crashedJob.id] : [])])];
  if (options.hooks) await options.hooks.started(due[0]!.id);
  else if (stateKept) {
    // The cron fallback has no object to serialize it, so its "running" write is also its claim: it succeeds only if
    // nobody has written the state since this pass read it. A second delivery of the tick, or a runner from before a
    // change of mode, finds the jobs taken and runs none of them.
    const claim = await schedulerJobsWrite(db, states, written, now, { readAt: stateRow?.updatedAt ?? null }).run();
    if ((claim.meta?.changes ?? 1) === 0 && await installationExists(db)) return report({ nextWake: now + SLICE_RETRY_MS, attempted: [], deferred: [], skipped: "claimed" });
  }
  const schedulerPass: SchedulerPass = { budget, moduleGenerations: moduleServiceGenerations(modules?.results as { moduleId: string; generation: number }[] | undefined), integrations: new Map(), pausedUntil, steps };
  // Core's own jobs make provider requests outside a module scope; counting them is all their authority check does.
  const jobEnv: Env = { ...passEnv, schedulerPass, moduleProviderAuthority: async () => budget.chargeExternal() };
  const attempted: string[] = []; let more = false;
  for (const job of due) {
    try {
      // A disabled module's job is skipped, not deferred: its check reads the module state this pass already has.
      if (job.enabled && !await job.enabled(jobEnv)) { states[job.id]!.outcome = "paused"; attempted.push(job.id); continue; }
      // The budget keeps its own reserve for the closing write, so this is the job's cost alone.
      if (!budget.allows(selfLimitingJobs.has(job.id) ? scheduledJobStartCost : pluginJobStartCost)) { budget.defer(job.id); states[job.id] = before[job.id]!; continue; }
      budget.exhausted = false; attempted.push(job.id);
      const refusedBefore = budget.refused;
      // The job sees the step it asked to continue from; jobs run one after another, so the shared pass can carry it.
      schedulerPass.cursor = before[job.id]!.cursor;
      const result = await job.run(jobEnv);
      // The budget refused one of the job's queries or requests at the limit: whatever the job made of that error, its
      // work is unfinished. It is recorded as failed and waits out its interval rather than asking for another slice.
      if (budget.refused > refusedBefore) throw new SchedulerBudgetError("D1 query");
      const jobMore = budget.exhausted || Boolean(result && typeof result === "object" && (result as { more?: unknown }).more === true);
      const cursor = jobMore ? runCursor(result) : undefined;
      states[job.id] = { next: jobMore ? now + SLICE_CONTINUE_MS : now + job.interval, last: now, outcome: "ok", ...(cursor ? { cursor } : {}) };
      more ||= jobMore;
    } catch (error) {
      // Each job's failure is its own; it retries when it next falls due.
      const status = (error as { status?: number })?.status;
      states[job.id]!.outcome = status === 409 || status === 503 ? "paused" : "failed";
      if (error instanceof SchedulerBudgetError) console.log(JSON.stringify({ event: "scheduler_budget_refused", job: job.id, ...budget.snapshot() }));
    }
  }
  // The jobs are done; the closing write may use the budget's reserve, so a busy pass still records its outcomes.
  budget.close();
  if (stateKept) await schedulerJobsWrite(db, states, written, now).run();
  if (budget.deferred.length) console.log(JSON.stringify({ event: "scheduler_jobs_deferred", ...budget.snapshot() }));
  if (stateless) return report({ ran: due[0]!.id, more: false, nextWake: now + SLICE_IDLE_MAX_MS, attempted, deferred: [...budget.deferred], stateless: true });
  const wake = more ? now + SLICE_CONTINUE_MS : nextWake(registeredPlatformSchedulerJobs, states, now, { pokes: withoutPokes(options.pokes, attempted), pausedUntil });
  return report({ ran: due[0]!.id, more, nextWake: wake, attempted, deferred: [...budget.deferred] });
}
const installationExists = async (db: D1Database) => Boolean(await db.prepare("SELECT 1 FROM installations WHERE id = 'primary'").first());
const withoutPokes = (pokes: Pokes | undefined, ran: readonly string[]): Pokes | undefined => pokes && Object.fromEntries(Object.entries(pokes).filter(([id]) => !ran.includes(id)));

/** One Durable Object slice: one job's small batch (or one step of it) inside one alarm invocation. */
export function runSchedulerSlice(env: Env, pokes: Pokes = {}, now?: number, hooks?: SliceHooks): Promise<SchedulerPassReport> {
  return runSchedulerPass(env, { now, pokes, maxJobs: 1, limits: scheduledSliceLimits, hooks, steps: true });
}

// The object and the Worker read the same setting: with the cron fallback forced, the object runs no slice.
export const PlatformScheduler = schedulerClass<Env>(registeredPlatformSchedulerJobs, (env, pokes, hooks) => runSchedulerSlice(env, pokes, undefined, hooks), Date.now, (env) => !cronSchedulerForced(env));

/** Scheduler status and Stop/Start, read from D1 so they work with or without the Durable Object. */
export async function platformScheduler(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const action = request.method === "GET" ? "status" : new URL(request.url).pathname.endsWith("/start") ? "start" : "stop";
  if (request.method === "POST") {
    const input = await parseJson<Record<string, unknown>>(request, 128);
    if (!isObject(input) || Object.keys(input).length) throw new HttpError(400, "Scheduler controls accept no configuration fields");
    const at = new Date();
    if (action === "stop") {
      // A Stop always lasts 24 hours from the latest Stop, so a forgotten Stop cannot hold delivery indefinitely.
      const until = new Date(at.getTime() + SCHEDULER_STOP_MS).toISOString();
      await db.batch([
        db.prepare("INSERT INTO platform_scheduler_state (installation_id, paused_until, paused_at, paused_by, updated_at) VALUES ('primary', ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET paused_until = excluded.paused_until, paused_at = excluded.paused_at, paused_by = excluded.paused_by, updated_at = excluded.updated_at").bind(until, at.toISOString(), principal.userId, at.toISOString()),
        auditStatement(db, principal, "scheduler.stop", "platform_scheduler", "primary", { pausedUntil: until }),
      ]);
    } else {
      await db.batch([
        db.prepare("UPDATE platform_scheduler_state SET paused_until = NULL, paused_at = NULL, paused_by = NULL, updated_at = ? WHERE installation_id = 'primary'").bind(at.toISOString()),
        auditStatement(db, principal, "scheduler.start", "platform_scheduler", "primary"),
      ]);
      // Work the Stop held goes out now rather than when each job next falls due.
      pokeScheduler(env, context, registeredPlatformSchedulerJobs.map((job) => job.id));
    }
  }
  const now = Date.now();
  const row = await db.prepare(schedulerStateSql).first<SchedulerStateRow>();
  const pausedUntil = pausedUntilTime(row, now);
  const durable = durableScheduler(env);
  // Reading status also re-arms a missing alarm, as the cron watchdog does, so opening the page recovers a lost one.
  let alarm: number | null | undefined;
  if (durable) try { alarm = ((await (await schedulerObject(env)!.fetch(schedulerRequest("watchdog"))).json()) as { alarm?: number | null }).alarm ?? null; } catch { alarm = undefined; }
  return response({
    enabled: pausedUntil === null,
    mode: durable ? "durable" : "cron",
    pausedUntil: pausedUntil === null ? null : new Date(pausedUntil).toISOString(),
    pausedAt: pausedUntil === null ? null : row?.pausedAt ?? null,
    alarm: alarm ?? null,
    jobs: parseJobStates(registeredPlatformSchedulerJobs, row?.jobsJson, now),
  }, 200, { "cache-control": "no-store" });
}
