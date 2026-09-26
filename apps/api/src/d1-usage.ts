export type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number; rows_read?: number; rows_written?: number } };
export interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
export interface D1Database { prepare(query: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; }
const originals = new WeakMap<D1Database, D1Database>();
export const databaseIdentity = (database: D1Database): D1Database => originals.get(database) ?? database;

/** Never records SQL, parameters, URLs, identities, or returned records. */
export function measureD1(database: D1Database) {
  let measuredRowsRead = 0, measuredRowsWritten = 0, measuredQueries = 0, firstQueriesUnmeasured = 0;
  const statements = new WeakMap<D1Statement, D1Statement>();
  function record<T>(result: D1Result<T>): D1Result<T> {
    measuredQueries++;
    measuredRowsRead += result.meta?.rows_read ?? 0;
    measuredRowsWritten += result.meta?.rows_written ?? 0;
    return result;
  }
  function wrap(statement: D1Statement): D1Statement {
    const wrapped: D1Statement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: <T>() => { firstQueriesUnmeasured++; return statement.first<T>(); },
      all: async <T>() => record(await statement.all<T>()),
      run: async () => record(await statement.run()),
    };
    statements.set(wrapped, statement);
    return wrapped;
  }
  const wrapped: D1Database = {
    prepare: (query) => wrap(database.prepare(query)),
    batch: async (batch) => (await database.batch(batch.map((statement) => statements.get(statement) ?? statement))).map(record),
  };
  originals.set(wrapped, databaseIdentity(database));
  return { database: wrapped, snapshot: () => ({ measuredRowsRead, measuredRowsWritten, measuredQueries, firstQueriesUnmeasured }) };
}

export function usageCategory(pathname: string): string {
  return ["/reports", "/attendance", "/admin/members", "/discord", "/kiosk", "/admin/kiosks", "/labels", "/admin/attendance", "/meetings"].find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ?? "other";
}
