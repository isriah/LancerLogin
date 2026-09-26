type Entry<T> = { revision: number; expiresAt: number; value: Promise<T> };

/** Cache source data only. Time-sensitive attendance is evaluated on every request. */
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
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= this.now() || entry.revision !== current) entries.delete(entryKey);
    if (entries.size >= this.capacity) entries.delete(entries.keys().next().value!);
    const entry: Entry<T> = { revision: current, expiresAt: this.now() + this.lifetimeMs, value: Promise.resolve(undefined as T) };
    entry.value = (async () => {
      try {
        const value = await load();
        // A write during loading must never publish a reusable mixed snapshot.
        if (await revision() !== current && entries.get(key) === entry) entries.delete(key);
        return value;
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
    })();
    entries.set(key, entry);
    return entry.value;
  }
}
