/** Per-alarm admission, counted before issuing any D1 statement or provider fetch. */
export class SchedulerBudget {
  queries = 0;
  requests = 0;
  query(count = 1) { if (this.queries + count > 32) throw new Error('Scheduler database budget exhausted'); this.queries += count; }
  request() { if (this.requests >= 12) throw new Error('Scheduler provider budget exhausted'); this.requests++; }
}
export const schedulerBudgetKey = Symbol('scheduler-budget');
