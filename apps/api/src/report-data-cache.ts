type Entry<T> = { revision: number; expiresAt: number; value: T };

/**
 * Cache source data only. Time-sensitive attendance is evaluated on every request.
 *
 * Only loaded values are kept, never a load in progress. Cloudflare ends a request when it runs out of CPU or its work
 * is abandoned, and a promise that request created can then never settle: a request that awaits it fails. Sharing a load
 * in progress let one ended request fail every later one until the entry expired. Two requests that miss at the same time
 * now each load for themselves.
 */
export class ReportDataCache<T> {
  private readonly databases = new WeakMap<object, Map<string, Entry<T>>>();
  private readonly lifetimeMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  constructor(lifetimeMs = 300_000, capacity = 32, now = Date.now) {
    this.lifetimeMs = lifetimeMs; this.capacity = capacity; this.now = now;
  }

  async read(database: object, key: string, revision: () => Promise<number | undefined>, load: () => Promise<T>): Promise<T> {
    const current = await revision();
    // A missing revision disables reuse, including with older test adapters.
    if (current === undefined) return load();
    let entries = this.databases.get(database);
    if (!entries) { entries = new Map(); this.databases.set(database, entries); }
    const found = entries.get(key);
    if (found && found.revision === current && found.expiresAt > this.now()) return found.value;
    const value = await load();
    // A write during loading must never publish a reusable mixed snapshot.
    if (await revision() !== current) return value;
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= this.now() || entry.revision !== current) entries.delete(entryKey);
    entries.delete(key);
    if (entries.size >= this.capacity) entries.delete(entries.keys().next().value!);
    entries.set(key, { revision: current, expiresAt: this.now() + this.lifetimeMs, value });
    return value;
  }
}
