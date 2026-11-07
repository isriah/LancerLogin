import { preserveDatabaseIdentity, type D1Database, type D1Result, type D1Statement } from "./d1-usage.ts";

/** Statements that only read: the ones safe to send together in one batch. */
export const readOnlyStatement = (sql: string) => /^\s*(?:SELECT|WITH)\b/i.test(sql);

type Pending = { statement: D1Statement; resolve: (result: D1Result) => void; reject: (error: unknown) => void };

/**
 * Collect the reads a request starts in the same tick (a Promise.all of queries, say) and send them as one D1 batch. The
 * Workers Free plan allows 50 D1 queries per invocation and counts a batch as one, however many statements it holds; a
 * batch is also one transaction, so the reads see one consistent state. A lone read goes out on its own, as before. When a
 * batch fails, each read is retried alone (a failed batch rolls back, and these are reads) so every caller gets its own
 * result or error, unless `shared` says the error belongs to the whole batch.
 */
export function readCoalescer(batch: (statements: D1Statement[]) => Promise<D1Result[]>, single: (statement: D1Statement) => Promise<D1Result>, shared: (error: unknown) => boolean = () => false) {
  let queue: Pending[] | undefined;
  const settle = async (item: Pending) => { try { item.resolve(await single(item.statement)); } catch (error) { item.reject(error); } };
  async function flush(items: Pending[]) {
    if (items.length === 1) return settle(items[0]!);
    let results: D1Result[];
    try { results = await batch(items.map((item) => item.statement)); }
    catch (error) {
      if (shared(error)) { for (const item of items) item.reject(error); return; }
      await Promise.all(items.map(settle)); return;
    }
    items.forEach((item, index) => item.resolve(results[index]!));
  }
  return (statement: D1Statement): Promise<D1Result> => new Promise((resolve, reject) => {
    if (!queue) { const items: Pending[] = queue = []; queueMicrotask(() => { queue = undefined; void flush(items); }); }
    queue.push({ statement, resolve, reject });
  });
}

/**
 * A database whose read-only first() and all() calls made in the same tick share one batch. Writes, run() and explicit
 * batches pass straight through. Caches keyed by database identity still see the underlying binding.
 */
export function coalescingDatabase(db: D1Database): D1Database {
  const originals = new WeakMap<D1Statement, D1Statement>();
  const read = readCoalescer((statements) => db.batch(statements), (statement) => statement.all());
  function wrap(original: D1Statement, sql: string): D1Statement {
    const coalesce = readOnlyStatement(sql);
    const statement: D1Statement = {
      bind: (...values) => wrap(original.bind(...values), sql),
      async first<T>() { return coalesce ? (((await read(original)).results?.[0] as T | undefined) ?? null) : original.first<T>(); },
      async all<T>() { return coalesce ? (await read(original)) as D1Result<T> : original.all<T>(); },
      run: () => original.run(),
    };
    originals.set(statement, original);
    return statement;
  }
  return preserveDatabaseIdentity({
    prepare: (query: string) => wrap(db.prepare(query), query),
    batch: (statements: D1Statement[]) => db.batch(statements.map((statement) => originals.get(statement) ?? statement)),
  }, db);
}
