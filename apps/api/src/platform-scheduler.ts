import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";

export interface SchedulerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface SchedulerState { storage: SchedulerStorage; }
export interface SchedulerNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> }; }
export interface SchedulerJob<E> { id: string; interval: number; enabled?: (env: E) => Promise<boolean>; run(env: E): Promise<unknown>; }
type JobOutcome = "waiting" | "running" | "ok" | "failed" | "paused";
type SchedulerRecord = { enabled: boolean; jobs: Record<string, { next: number; last: number | null; outcome: JobOutcome }> };

export function moduleSchedulerJobs<E>(application: {
  modules: readonly ModuleDefinition[];
  enabled(moduleId: string, env: E): Promise<boolean>;
  runJob(jobId: string, env: E): Promise<void>;
}): readonly SchedulerJob<E>[] {
  return Object.freeze(application.modules.flatMap((module) => module.available ? module.jobs.map((job) => Object.freeze({
    id: job.id,
    interval: job.interval,
    enabled: (env: E) => application.enabled(module.id, env),
    run: (env: E) => application.runJob(job.id, env),
  })) : []));
}

export function schedulerClass<E>(jobs: readonly SchedulerJob<E>[], authorize: (request: Request, env: E) => Promise<boolean>, configured: (env: E) => boolean, suspended: (env: E) => Promise<boolean> = async () => false) {
  if (!jobs.length || new Set(jobs.map((job) => job.id)).size !== jobs.length || jobs.some((job) => !Number.isSafeInteger(job.interval) || job.interval < 300_000)) throw new Error("Invalid scheduler registry");
  return class {
    private tail: Promise<unknown> = Promise.resolve();
    private state: SchedulerState;
    private env: E;

    constructor(state: SchedulerState, env: E) { this.state = state; this.env = env; }

    private serial<T>(work: () => Promise<T>): Promise<T> {
      const result = this.tail.then(work);
      this.tail = result.catch(() => undefined);
      return result;
    }

    private async load(): Promise<SchedulerRecord> {
      const stored = await this.state.storage.get<SchedulerRecord>("scheduler-v1");
      const value: SchedulerRecord = { enabled: stored?.enabled ?? false, jobs: {} };
      for (const job of jobs) value.jobs[job.id] = stored?.jobs[job.id] ?? { next: Date.now() + job.interval, last: null, outcome: "waiting" };
      return value;
    }

    private async save(value: SchedulerRecord) {
      await this.state.storage.transaction(async () => {
        await this.state.storage.put("scheduler-v1", value);
        if (value.enabled && configured(this.env)) {
          const next = Object.values(value.jobs).reduce((earliest, job) => Math.min(earliest, job.next), Number.POSITIVE_INFINITY);
          await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, next));
        } else await this.state.storage.deleteAlarm();
      });
    }

    fetch(request: Request): Promise<Response> {
      return this.serial(async () => {
        if (!await authorize(request, this.env)) return Response.json({ error: "Admin access required" }, { status: 403 });
        if (!configured(this.env)) return Response.json({ error: "Durable scheduler is not configured" }, { status: 503 });
        const path = new URL(request.url).pathname;
        if (!(request.method === "GET" && path === "/status") && !(request.method === "POST" && ["/start", "/stop"].includes(path))) return new Response(null, { status: 404 });
        const value = await this.load();
        const wasEnabled = value.enabled;
        if (path === "/start" && !value.enabled) {
          value.enabled = true;
          for (const job of jobs) value.jobs[job.id]!.next = Date.now() + job.interval;
        }
        if (path === "/stop") value.enabled = false;
        if (request.method === "POST" && wasEnabled !== value.enabled) await this.save(value);
        else if (path === "/start" && await this.state.storage.getAlarm() === null) await this.save(value);
        return Response.json(value, { headers: { "cache-control": "no-store" } });
      });
    }

    alarm(): Promise<void> {
      return this.serial(async () => {
        const value = await this.load();
        if (!value.enabled || !configured(this.env)) { await this.state.storage.deleteAlarm(); return; }
        // Keep due work intact while maintenance is active or its state cannot be read.
        // A bounded retry resumes automatically without requiring another start command.
        try {
          if (await suspended(this.env)) { await this.state.storage.setAlarm(Date.now() + 30_000); return; }
        } catch {
          await this.state.storage.setAlarm(Date.now() + 30_000); return;
        }
        const job = jobs.filter((item) => value.jobs[item.id]!.next <= Date.now()).sort((left, right) => value.jobs[left.id]!.next - value.jobs[right.id]!.next)[0];
        if (!job) { await this.save(value); return; }
        const entry = value.jobs[job.id]!;
        entry.next = Date.now() + job.interval;
        entry.last = Date.now();
        entry.outcome = "running";
        await this.save(value);
        try {
          if (job.enabled && !await job.enabled(this.env)) entry.outcome = "paused";
          else { await job.run(this.env); entry.outcome = "ok"; }
        } catch (error) {
          entry.outcome = (error as { status?: number })?.status === 409 || (error as { status?: number })?.status === 503 ? "paused" : "failed";
        }
        await this.save(value);
      });
    }
  };
}
