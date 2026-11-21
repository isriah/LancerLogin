// A D1 database that records every query it is asked to run, as the platform counts them: each first, all or run is
// one query and each batch is one. `fail` may throw for a statement or batch, to stand in for a D1 error.
import type { D1Database, D1Statement } from "../../apps/api/src/d1-usage.ts";

type Inner = D1Statement & { readonly sql: string };
type Wrapped = D1Statement & { readonly sql: string; readonly inner: Inner };
export type CountingDatabase = D1Database & {
  /** One entry per query: a statement's SQL, or a batch's statements joined by " ;; " after "BATCH ". */
  readonly queries: string[];
  /** Called before each query with the SQL of every statement in it; throw to make that query fail. */
  fail?: (statements: readonly string[]) => void;
};

export function countingDatabase(database: D1Database): CountingDatabase {
  const queries: string[] = [];
  const counted = { queries } as CountingDatabase;
  const single = <T>(statement: Inner, work: () => Promise<T>): Promise<T> => {
    try { counted.fail?.([statement.sql]); } catch (error) { return Promise.reject(error); }
    queries.push(statement.sql); return work();
  };
  const wrap = (statement: Inner): Wrapped => ({
    sql: statement.sql, inner: statement,
    bind: (...values) => wrap(statement.bind(...values) as Inner),
    first: <T>() => single(statement, () => statement.first<T>()),
    all: <T>() => single(statement, () => statement.all<T>()),
    run: () => single(statement, () => statement.run()),
  });
  Object.assign(counted, {
    prepare: (sql: string) => wrap(database.prepare(sql) as Inner),
    batch: (statements: D1Statement[]) => {
      const inner = statements.map((statement) => (statement as Partial<Wrapped>).inner ?? statement as Inner);
      try { counted.fail?.(inner.map((statement) => statement.sql)); } catch (error) { return Promise.reject(error); }
      queries.push(`BATCH ${inner.map((statement) => statement.sql).join(" ;; ")}`);
      return database.batch(inner);
    },
  });
  return counted;
}
