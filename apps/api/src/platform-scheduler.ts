/** Fixed release-owned jobs; never accept executable job definitions from requests. */
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
type RecordState = { enabled: boolean; jobs: Record<string, { next: number; last: number | null; outcome: 'waiting' | 'running' | 'ok' | 'failed' | 'paused' }> };

/** KV methods on SQLite-backed DO storage are durable; one record bounds storage size. */
export function schedulerClass<E>(jobs: readonly SchedulerJob<E>[], authorize: (request: Request, env: E) => Promise<boolean>, configured: (env: E) => boolean, prepare: (env:E)=>E = env=>env, execute: <T>(env:E,work:(env:E)=>Promise<T>)=>Promise<T> = (env,work)=>work(env)) {
  if (!jobs.length || jobs.length > 16 || new Set(jobs.map(j => j.id)).size !== jobs.length || jobs.some(j => !Number.isSafeInteger(j.interval) || j.interval < 300_000)) throw new Error('Invalid scheduler registry');
  return class {
    private tail: Promise<unknown> = Promise.resolve();
    private state: SchedulerState; private env: E;
    constructor(state: SchedulerState, env: E) { this.state = state; this.env = env; }
    private serial<T>(work: () => Promise<T>): Promise<T> {
      const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
    }
    private async load(): Promise<RecordState> {
      const stored = await this.state.storage.get<RecordState>('scheduler-v1');
      const value: RecordState = { enabled: stored?.enabled ?? false, jobs: {} };
      for (const job of jobs) value.jobs[job.id] = stored?.jobs[job.id] ?? { next: Date.now() + job.interval, last: null, outcome: 'waiting' };
      return value;
    }
    private async save(value: RecordState) {
      await this.state.storage.transaction(async () => {
      await this.state.storage.put('scheduler-v1', value);
      if (value.enabled && configured(this.env)) await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...Object.values(value.jobs).map(j => j.next))));
      else await this.state.storage.deleteAlarm();
      });
    }
    fetch(request: Request): Promise<Response> { return this.serial(() => execute(this.env,async env => {
      if (!await authorize(request, env)) return Response.json({ error: 'Admin access required' }, { status: 403 });
      if (!configured(this.env)) return Response.json({ error: 'Durable scheduler is not configured' }, { status: 503 });
      const path = new URL(request.url).pathname;
      if (!(request.method === 'GET' && path === '/status') && !(request.method === 'POST' && ['/start', '/stop'].includes(path))) return new Response(null, { status: 404 });
      const value = await this.load();
      const wasEnabled = value.enabled;
      if (path === '/start' && !value.enabled) {
        value.enabled = true;
        // Re-enabling schedules future work, never replays elapsed scheduler ticks.
        for (const job of jobs) value.jobs[job.id].next = Date.now() + job.interval;
      }
      if (path === '/stop') value.enabled = false;
      if (request.method === 'POST' && wasEnabled !== value.enabled) await this.save(value);
      else if (path === '/start' && await this.state.storage.getAlarm() === null) {
        // A deployment with durable mode disabled can remove an alarm while
        // retaining enabled state. Recover without resetting any job checkpoint.
        await this.save(value);
      }
      return Response.json(value, { headers: { 'cache-control': 'no-store' } });
    })); }
    alarm(): Promise<void> { return this.serial(async () => {
      const value = await this.load();
      if (!value.enabled || !configured(this.env)) { await this.state.storage.deleteAlarm(); return; }
      const job = jobs.filter(j => value.jobs[j.id].next <= Date.now()).sort((a, b) => value.jobs[a.id].next - value.jobs[b.id].next)[0];
      if (!job) { await this.save(value); return; }
      const entry = value.jobs[job.id];
      // Persist advancement and a successor alarm before external work. Crash retries
      // cannot spin on one poison job; provider-owned operation state handles retry.
      entry.next = Date.now() + job.interval; entry.last = Date.now(); entry.outcome = 'running';
      await this.save(value);
      try { await execute(this.env,async env=>{const scoped=prepare(env); if (job.enabled && !await job.enabled(scoped)) entry.outcome = 'paused'; else { await job.run(scoped); entry.outcome = 'ok'; }}); }
      catch (error) { entry.outcome = (error as {status?:number})?.status===503 ? 'paused' : 'failed'; }
      await this.save(value);
    }); }
  };
}
