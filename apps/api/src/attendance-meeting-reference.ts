import { HttpError } from "./http-error.ts";
import { preserveDatabaseIdentity, type D1Database, type D1Statement } from "./d1-usage.ts";
import { requireModuleWorkspace } from "./module-platform.ts";
import { captureModuleWorkspaceDatabase } from "./module-database-scope.ts";

export type MeetingReference = { id: string; title: string; startsAt: string; endsAt: string };
/** Permission-scoped navigation data, not attendance records or mutation authority. */
export type MeetingReferenceAccess = {
  list(): Promise<MeetingReference[]>;
  find(id: string): Promise<MeetingReference | null>;
  read<T>(operation: (db: D1Database) => Promise<T>): Promise<T>;
  /** Run `operation` while the meeting stays available. `unavailableMessage` is the 400 error when it is not available now. */
  withTarget<T>(id: string, operation: (db: D1Database) => Promise<T>, unavailableMessage?: string): Promise<T>;
};

function captureActiveTarget(db: D1Database, id: string): D1Database {
  const originals = new WeakMap<D1Statement, D1Statement>();
  const guard = () => db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM meetings WHERE installation_id='primary' AND id=? AND deleted_at IS NULL) THEN 1 ELSE json_extract('{}','meeting-reference-unavailable') END AS target_available").bind(id);
  async function batch(statements: D1Statement[]) {
    const input = statements.map((statement) => { const original = originals.get(statement); if (!original) throw new HttpError(500, "Reference statement belongs to a different request"); return original; });
    try { return (await db.batch([guard(), ...input, guard()])).slice(1, -1); }
    catch (error) { if (error instanceof Error && error.message.includes("meeting-reference-unavailable")) throw new HttpError(409, "Meeting is no longer available. Reload before linking."); throw error; }
  }
  function wrap(original: D1Statement): D1Statement {
    const statement: D1Statement = { bind: (...values) => wrap(original.bind(...values)), first: async <T>() => ((await batch([statement]))[0]?.results?.[0] as T | undefined) ?? null, all: async <T>() => (await batch([statement]))[0] as Awaited<ReturnType<D1Statement["all"]>> & { results?: T[] }, run: async () => (await batch([statement]))[0]! };
    originals.set(statement, original); return statement;
  }
  return preserveDatabaseIdentity({ prepare: (sql) => wrap(db.prepare(sql)), batch }, db);
}

/** Compose with the consuming module's captured database, retaining both guards. */
export async function createMeetingReferenceAccess(db: D1Database, actor: string): Promise<MeetingReferenceAccess | undefined> {
  let generation: number;
  try { generation = await requireModuleWorkspace(db, actor, "attendance"); }
  catch (error) { if (error instanceof HttpError && error.status === 403) return undefined; throw error; }
  const scoped = captureModuleWorkspaceDatabase(db, "attendance", generation, actor, "attendance.manage");
  const select = "SELECT id,title,starts_at AS startsAt,ends_at AS endsAt FROM meetings WHERE installation_id='primary' AND deleted_at IS NULL";
  const find = (id: string) => scoped.prepare(`${select} AND id=?`).bind(id).first<MeetingReference>();
  return {
    list: async () => (await scoped.prepare(`${select} ORDER BY starts_at DESC,id`).all<MeetingReference>()).results ?? [],
    find,
    read: (operation) => operation(scoped),
    async withTarget(id, operation, unavailableMessage = "Choose an available meeting from this installation or leave it unlinked.") { if (!await find(id)) throw new HttpError(400, unavailableMessage); return operation(captureActiveTarget(scoped, id)); },
  };
}
