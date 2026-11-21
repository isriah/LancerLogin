import type { D1Database, D1Result, D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

/**
 * Dashboard backups and restores in parts (migration 0105).
 *
 * Reading, checking or writing a whole multi-season backup in one request costs several times the Workers Free CPU
 * allowance (10 ms per invocation), so the dashboard moves a backup in parts of about 64 KiB and no request handles more
 * than one part. The rows wait in `data_transfer_chunks` between requests, and D1 does the heavy copying itself:
 *
 * - Restore: the dashboard sends the backup document with its large tables emptied, then each part of those tables. The
 *   Worker checks each part as it arrives and stages its rows. One final batch replaces the live rows, reading the staged
 *   parts with json_each inside D1. That batch is the only request that changes live data, so a restore that fails or
 *   is abandoned at any earlier point leaves the installation exactly as it was.
 * - Backup: one batch copies every table into staged parts, so the backup is one snapshot as before, and the dashboard
 *   downloads the parts and puts the same file together.
 *
 * A staged part's payload is a JSON array of rows, each row a JSON array of values in the table's column order. The
 * Worker writes restore payloads itself from the rows it checked, never the uploaded text, so SQLite reads exactly the
 * values JavaScript validated.
 */

/** A session nobody finished is removed this long after it started. */
export const TRANSFER_SESSION_MS = 2 * 60 * 60_000;
/** The part size the dashboard aims for when it splits a table, in bytes of JSON. */
export const RESTORE_PART_TARGET_BYTES = 65_536;
/** The largest part the Worker accepts. */
export const RESTORE_PART_MAX_BYTES = 262_144;
/** The most parts one restore may declare. */
export const RESTORE_MAX_PARTS = 4_096;
/** The size a backup part is cut at, in characters of JSON. A part ends with the row that crosses it. */
export const BACKUP_PART_TARGET_CHARS = 60_000;
/** D1 stores at most 2 MB in one value; the restore's backup document is kept in pieces of this many characters. */
const DOCUMENT_PIECE_CHARS = 500_000;
const COMMIT_MARKER_SEQ = -1_000_000_000;
/** Each backup source numbers its parts from a multiple of this. */
const BACKUP_SOURCE_SPAN = 1_000_000;
/** D1 allows 32 arguments in one SQL function call. */
const MAX_FUNCTION_ARGUMENTS = 32;

export type TransferKind = "restore" | "backup";
export type RestorePart = { readonly seq: number; readonly table: string; readonly rows: number; readonly sha256: string };
type Row = Record<string, unknown>;

const isObject = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeName = /^[a-z][a-z0-9_]*$/;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const validTransferSessionId = (value: string) => sessionIdPattern.test(value);
// A finished restore answers its final request again for as long as its session is kept, so by the time a session is
// missing the restore was cancelled, replaced by another of the same Admin's, or ended more than two hours ago.
export const sessionGone = (kind: TransferKind) => new HttpError(404, kind === "restore"
  ? "This restore is no longer in progress: it was cancelled or replaced, or it ended more than two hours ago. Check the data before starting the restore again."
  : "This backup is no longer being prepared. Download the backup again.", undefined, "transfer_session_missing");
/** The most sessions of one kind kept at a time, over every Admin; starting another removes the oldest. */
export const TRANSFER_SESSION_LIMIT = 4;
/** Lone surrogates become U+FFFD, as D1 stores them when a string is bound, so text reads back as it was stored and hashed. */
const wellFormed = (text: string): string => (text as string & { isWellFormed(): boolean; toWellFormed(): string }).isWellFormed() ? text : (text as string & { toWellFormed(): string }).toWellFormed();

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));
  let hex = ""; for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The statement that removes sessions nobody finished, for the scheduled clean-up batch (stale-row-pruning.ts). Their parts cascade. */
export function dataTransferPruning(db: D1Database, now = Date.now()): D1Statement {
  return db.prepare("DELETE FROM data_transfer_sessions WHERE expires_at < ?").bind(new Date(now).toISOString());
}

/**
 * Starting a session ends the same Admin's other session of its kind: one restore, and one backup download, is staged
 * for an Admin at a time, and another Admin's (a web update's backup being downloaded, say) is left alone. No more than
 * TRANSFER_SESSION_LIMIT of a kind are kept in all; the oldest go first.
 */
function sessionStatements(db: D1Database, kind: TransferKind, id: string, session: { userId: string; scope: string; digest: string | null; context: unknown }, now: number): D1Statement[] {
  const createdAt = new Date(now).toISOString(); const expiresAt = new Date(now + TRANSFER_SESSION_MS).toISOString();
  return [
    db.prepare("DELETE FROM data_transfer_sessions WHERE kind = ? AND created_by = ? OR expires_at < ?").bind(kind, session.userId, createdAt),
    db.prepare(`DELETE FROM data_transfer_sessions WHERE kind = ? AND id IN (SELECT id FROM data_transfer_sessions WHERE kind = ? ORDER BY created_at DESC, id LIMIT -1 OFFSET ${TRANSFER_SESSION_LIMIT - 1})`).bind(kind, kind),
    db.prepare("INSERT INTO data_transfer_sessions (id, kind, scope, created_by, created_at, expires_at, digest, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, kind, session.scope, session.userId, createdAt, expiresAt, session.digest, JSON.stringify(session.context)),
  ];
}

/** Remove a session and its parts. Returns whether it existed. */
export async function deleteTransferSession(db: D1Database, kind: TransferKind, id: string, userId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM data_transfer_sessions WHERE id = ? AND kind = ? AND created_by = ?").bind(id, kind, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}

// Restore

/** The parts a restore declares before it uploads them: which staged table each belongs to, how many rows, and the SHA-256 of its bytes. */
export function parseRestoreParts(value: unknown, stagedTables: ReadonlySet<string>): RestorePart[] {
  if (value === undefined) return [];
  const invalid = () => new HttpError(400, "The restore's list of parts is invalid");
  if (!Array.isArray(value) || value.length > RESTORE_MAX_PARTS) throw invalid();
  return value.map((part, seq) => {
    if (!isObject(part) || typeof part.table !== "string" || !stagedTables.has(part.table) || !Number.isSafeInteger(part.rows) || Number(part.rows) < 1 || typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256)) throw invalid();
    return { seq, table: part.table, rows: Number(part.rows), sha256: part.sha256 };
  });
}

/**
 * Cut text into pieces of at most DOCUMENT_PIECE_CHARS UTF-16 units, never between the two halves of a surrogate pair:
 * D1 stores text as UTF-8, and half a pair alone would be stored as U+FFFD.
 */
export function documentPieces(text: string, size = DOCUMENT_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && end - start > 1) end -= 1;
    pieces.push(text.slice(start, end)); start = end;
  }
  return pieces;
}

/**
 * Stage a checked restore: the backup document as received and a placeholder for every part still to come. Nothing
 * outside the staging tables is written. Queries: one batch.
 */
export async function createRestoreSession(db: D1Database, input: { userId: string; scope: string; document: string; parts: readonly RestorePart[]; context: Row; now?: number }) {
  const now = input.now ?? Date.now(); const id = crypto.randomUUID();
  // The document is kept as well-formed text and its SHA-256 with it; the final request checks the stored copy against it.
  const document = wellFormed(input.document); const documentSha256 = await sha256Hex(document);
  const digest = await sha256Hex(`${documentSha256}\n${input.parts.map((part) => `${part.seq}:${part.table}:${part.rows}:${part.sha256}`).join("\n")}`);
  const statements = sessionStatements(db, "restore", id, { userId: input.userId, scope: input.scope, digest, context: { ...input.context, documentSha256 } }, now);
  for (const [piece, text] of documentPieces(document).entries()) {
    statements.push(db.prepare("INSERT INTO data_transfer_chunks (session_id, seq, table_name, row_count, payload) VALUES (?, ?, '#document', 0, ?)").bind(id, -1 - piece, text));
  }
  if (input.parts.length) statements.push(db.prepare(`INSERT INTO data_transfer_chunks (session_id, seq, table_name, row_count, digest)
    SELECT ?, json_extract(part.value, '$.seq'), json_extract(part.value, '$.table'), json_extract(part.value, '$.rows'), json_extract(part.value, '$.sha256') FROM json_each(?) part`).bind(id, JSON.stringify(input.parts)));
  await db.batch(statements);
  return { id, digest, expiresAt: new Date(now + TRANSFER_SESSION_MS).toISOString() };
}

export type RestorePartMeta = { scope: string; context: Row; table: string; rows: number; sha256: string };
/** The session and the declared part an upload belongs to. Queries: one. */
export async function restorePartMeta(db: D1Database, id: string, userId: string, seq: number, now = Date.now()): Promise<RestorePartMeta> {
  const row = await db.prepare(`SELECT s.scope AS scope, s.context_json AS context, c.table_name AS tableName, c.row_count AS rowCount, c.digest AS digest
    FROM data_transfer_sessions s JOIN data_transfer_chunks c ON c.session_id = s.id AND c.seq = ?
    WHERE s.id = ? AND s.kind = 'restore' AND s.created_by = ? AND s.expires_at > ?`).bind(seq, id, userId, new Date(now).toISOString()).first<{ scope: string; context: string; tableName: string; rowCount: number; digest: string }>();
  if (!row || seq < 0) throw sessionGone("restore");
  return { scope: row.scope, context: JSON.parse(row.context) as Row, table: row.tableName, rows: row.rowCount, sha256: row.digest };
}

/** The staged form of checked rows: a JSON array of arrays in column order. A value no column of the row holds is refused. */
export function stagedPayload(table: string, columns: readonly string[], rows: readonly Row[]): string {
  const staged = rows.map((row) => columns.map((column) => {
    const value = row[column];
    if (value === undefined) throw new HttpError(400, `Backup table ${table} contains an invalid row`);
    return value;
  }));
  const payload = JSON.stringify(staged);
  // JSON.stringify writes half a surrogate pair as an escape (\ud800), which SQLite's JSON functions would store as bytes
  // that are not UTF-8. A bound string stores U+FFFD instead (the single-request restore), so the staged text says that.
  // The escape can only follow a backslash, so nearly every payload skips the second pass.
  return payload.includes("\\ud") ? JSON.stringify(staged, (_key, value: unknown) => typeof value === "string" ? wellFormed(value) : value) : payload;
}

/** Record an uploaded part. Sending the same part again replaces it with the same rows. Queries: one. */
export async function storeRestorePart(db: D1Database, id: string, seq: number, payload: string, paused: number): Promise<void> {
  const result = await db.prepare("UPDATE data_transfer_chunks SET payload = ?, paused = ? WHERE session_id = ? AND seq = ?").bind(payload, paused, id, seq).run();
  if (!(result.meta?.changes ?? 0)) throw sessionGone("restore");
}

/** Which declared parts have not arrived, so an interrupted upload can continue, and whether the restore has completed. Queries: one. */
export async function restoreSessionStatus(db: D1Database, id: string, userId: string, now = Date.now()) {
  const result = await db.prepare(`SELECT s.expires_at AS expiresAt, s.result_json IS NOT NULL AS committed, c.seq AS seq, c.payload IS NULL AS missing
    FROM data_transfer_sessions s LEFT JOIN data_transfer_chunks c ON c.session_id = s.id AND c.seq >= 0
    WHERE s.id = ? AND s.kind = 'restore' AND s.created_by = ? AND s.expires_at > ? ORDER BY c.seq`).bind(id, userId, new Date(now).toISOString()).all<{ expiresAt: string; committed: number; seq: number | null; missing: number | null }>();
  const rows = result.results ?? [];
  if (!rows.length) throw sessionGone("restore");
  return { id, expiresAt: rows[0]!.expiresAt, committed: rows[0]!.committed === 1, parts: rows.filter((row) => row.seq !== null).length, missing: rows.filter((row) => row.seq !== null && row.missing === 1).map((row) => Number(row.seq)) };
}

export type StagedRestore = {
  readonly id: string;
  readonly scope: string;
  readonly digest: string;
  readonly context: Row;
  /** The backup document as the dashboard sent it, with the staged tables empty. */
  readonly document: string;
  /** The answer of the final request, once it has completed; a repeat of that request is answered with it. */
  readonly result?: Row;
  readonly missing: number;
  /** Provider operations the staged parts held as pending; they restore paused. */
  readonly paused: number;
};
/** Everything the final batch needs to know about a staged restore. Queries: one batch. */
export async function loadStagedRestore(db: D1Database, id: string, userId: string, now = Date.now()): Promise<StagedRestore> {
  const [session, pieces, parts] = await db.batch([
    db.prepare("SELECT scope, digest, context_json AS context, result_json AS result FROM data_transfer_sessions WHERE id = ? AND kind = 'restore' AND created_by = ? AND expires_at > ?").bind(id, userId, new Date(now).toISOString()),
    db.prepare("SELECT payload FROM data_transfer_chunks WHERE session_id = ? AND table_name = '#document' ORDER BY seq DESC").bind(id),
    db.prepare("SELECT COALESCE(SUM(payload IS NULL), 0) AS missing, COALESCE(SUM(paused), 0) AS paused FROM data_transfer_chunks WHERE session_id = ? AND seq >= 0").bind(id),
  ]) as [D1Result<{ scope: string; digest: string; context: string; result: string | null }>, D1Result<{ payload: string }>, D1Result<{ missing: number; paused: number }>];
  const row = session.results?.[0];
  if (!row) throw sessionGone("restore");
  const totals = parts.results?.[0]; const context = JSON.parse(row.context) as Row; const document = (pieces.results ?? []).map((piece) => piece.payload).join("");
  if (row.result) return { id, scope: row.scope, digest: row.digest, context, document: "", missing: 0, paused: 0, result: JSON.parse(row.result) as Row };
  // The stored copy must be the text that was checked when the restore started.
  if (await sha256Hex(document) !== context.documentSha256) throw new HttpError(409, "The staged backup document no longer matches the one that was checked. Nothing was changed. Start the restore again.", undefined, "restore_document_mismatch");
  return { id, scope: row.scope, digest: row.digest, context, document, missing: Number(totals?.missing ?? 0), paused: Number(totals?.paused ?? 0) };
}
/** The recorded answer of a session's final request, undefined while it has none, or null when the session is gone. Queries: one. */
export async function restoreSessionResult(db: D1Database, id: string): Promise<Row | undefined | null> {
  const row = await db.prepare("SELECT result_json AS result FROM data_transfer_sessions WHERE id = ? AND kind = 'restore'").bind(id).first<{ result: string | null }>();
  return row ? (row.result ? JSON.parse(row.result) as Row : undefined) : null;
}

/**
 * First statements of the final batch. Each fails, and so rolls the whole batch back, when the restore must not go on:
 * the marker has no session to belong to once the session is gone (cancelled or replaced), a session that already
 * committed keeps its marker, so a second one breaks the primary key, and so does re-inserting a part that has not arrived.
 */
export function stagedCommitGuards(db: D1Database, id: string): D1Statement[] {
  return [
    db.prepare("INSERT INTO data_transfer_chunks (session_id, seq, table_name, row_count) VALUES (?, ?, '#commit', 0)").bind(id, COMMIT_MARKER_SEQ),
    db.prepare("INSERT INTO data_transfer_chunks (session_id, seq, table_name, row_count) SELECT session_id, seq, table_name, row_count FROM data_transfer_chunks WHERE session_id = ? AND seq >= 0 AND payload IS NULL").bind(id),
  ];
}
/**
 * Last statements of the final batch, in the same transaction as the restore: the staged parts go, and the session keeps
 * the answer and its marker until it expires, so the final request can be sent again (its answer may have been lost on
 * the way) and is answered the same without running twice.
 */
export const stagedCommitCleanup = (db: D1Database, id: string, result: unknown): D1Statement[] => [
  db.prepare("DELETE FROM data_transfer_chunks WHERE session_id = ? AND seq <> ?").bind(id, COMMIT_MARKER_SEQ),
  db.prepare("UPDATE data_transfer_sessions SET result_json = ? WHERE id = ?").bind(JSON.stringify(result), id),
];

const stagedRows = "FROM data_transfer_chunks part, json_each(part.payload) staged WHERE part.session_id = ? AND part.table_name = ?";
/**
 * A staged value as a bound parameter would arrive: D1 binds every JavaScript number and boolean as a REAL, which a TEXT
 * column stores as '777.0' and an INTEGER column as 777. json_extract alone would hand a whole number over as an INTEGER.
 */
const stagedValue = (index: number) => `CASE WHEN json_type(staged.value, '$[${index}]') IN ('integer', 'true', 'false') THEN CAST(json_extract(staged.value, '$[${index}]') AS REAL) ELSE json_extract(staged.value, '$[${index}]') END`;
/** One INSERT that copies a table's staged rows into place inside D1, whatever their number. `suffix` is an optional conflict clause. */
export function stagedRowsInsert(db: D1Database, id: string, table: string, columns: readonly string[], suffix = ""): D1Statement {
  if (!safeName.test(table) || columns.some((column) => !safeName.test(column))) throw new Error("Staged tables and columns must be plain identifiers");
  return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map((_, index) => stagedValue(index)).join(", ")} ${stagedRows}${suffix}`).bind(id, table);
}
/** A JSON array of one column of a table's staged rows, built inside D1. Queries: one. */
export async function stagedColumnValues(db: D1Database, id: string, table: string, columnIndex: number): Promise<string> {
  const row = await db.prepare(`SELECT json_group_array(json_extract(staged.value, '$[${Number(columnIndex)}]')) AS list ${stagedRows}`).bind(id, table).first<{ list: string }>();
  return row?.list ?? "[]";
}

// Backup

/** A table (or a filtered part of one) a backup copies. `expressions` replaces a column with a computed value. */
export type BackupSource = { readonly table: string; readonly columns: readonly string[]; readonly expressions?: Readonly<Record<string, string>>; readonly where: string };

/** A JSON array of the given SQL values, within D1's limit of 32 arguments per function. */
function jsonArraySql(values: readonly string[]): string {
  const groups: string[] = [];
  for (let start = 0; start < values.length; start += MAX_FUNCTION_ARGUMENTS) groups.push(`json_array(${values.slice(start, start + MAX_FUNCTION_ARGUMENTS).join(", ")})`);
  if (groups.length === 1) return groups[0]!;
  // "[a,b]" and "[c,d]" joined as "[a,b,c,d]".
  return groups.map((group, index) => index === 0 ? `substr(${group}, 1, length(${group}) - 1)` : index === groups.length - 1 ? `substr(${group}, 2)` : `substr(${group}, 2, length(${group}) - 2)`).join(" || ',' || ");
}

/**
 * Copy a table into staged parts in one statement: each row becomes a JSON array, and a new part starts each time the
 * rows before it pass another BACKUP_PART_TARGET_CHARS. Rows keep the order the table is read in. The part size and
 * numbering are written into the SQL as integers: a bound number is a REAL, and dividing by one would not truncate.
 */
function backupSourceStatement(db: D1Database, id: string, index: number, source: BackupSource): D1Statement {
  if (!safeName.test(source.table) || source.columns.some((column) => !safeName.test(column))) throw new Error("Backup tables and columns must be plain identifiers");
  const item = jsonArraySql(source.columns.map((column) => source.expressions?.[column] ?? column));
  return db.prepare(`INSERT INTO data_transfer_chunks (session_id, seq, table_name, row_count, payload)
    SELECT ?, ${index * BACKUP_SOURCE_SPAN} + piece, ?, COUNT(*), '[' || group_concat(item, ',' ORDER BY position) || ']'
    FROM (SELECT item, COUNT(*) OVER scanned AS position, (SUM(length(item)) OVER scanned - length(item)) / ${BACKUP_PART_TARGET_CHARS} AS piece
      FROM (SELECT ${item} AS item FROM ${source.table} WHERE ${source.where})
      WINDOW scanned AS (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))
    GROUP BY piece`).bind(id, source.table);
}

/**
 * Stage a backup: one batch copies every source into parts, so the parts are a single snapshot however long the dashboard
 * takes to download them. `reads` are further statements for the same snapshot; their results come back in order.
 * Queries: one batch.
 */
export async function createBackupSession(db: D1Database, input: { userId: string; scope: string; sources: readonly BackupSource[]; reads?: readonly D1Statement[]; writes?: readonly D1Statement[]; context?: unknown; now?: number }) {
  const now = input.now ?? Date.now(); const id = crypto.randomUUID(); const reads = input.reads ?? []; const writes = input.writes ?? [];
  const opening = sessionStatements(db, "backup", id, { userId: input.userId, scope: input.scope, digest: null, context: input.context ?? {} }, now);
  const results = await db.batch([
    ...opening, ...input.sources.map((source, index) => backupSourceStatement(db, id, index, source)), ...reads, ...writes,
    db.prepare("SELECT seq, row_count AS rows FROM data_transfer_chunks WHERE session_id = ? ORDER BY seq").bind(id),
  ]);
  const parts = ((results.at(-1)?.results ?? []) as { seq: number; rows: number }[]).map((part) => ({ seq: part.seq, rows: part.rows, source: Math.floor(part.seq / BACKUP_SOURCE_SPAN) }));
  const firstRead = opening.length + input.sources.length;
  return { id, expiresAt: new Date(now + TRANSFER_SESSION_MS).toISOString(), parts, reads: results.slice(firstRead, firstRead + reads.length) };
}

/** One staged backup part, as the JSON text to send. Queries: one. */
export async function backupPartPayload(db: D1Database, id: string, userId: string, seq: number, now = Date.now()): Promise<string> {
  const row = await db.prepare(`SELECT c.payload AS payload FROM data_transfer_sessions s JOIN data_transfer_chunks c ON c.session_id = s.id AND c.seq = ?
    WHERE s.id = ? AND s.kind = 'backup' AND s.created_by = ? AND s.expires_at > ?`).bind(seq, id, userId, new Date(now).toISOString()).first<{ payload: string | null }>();
  if (!row || typeof row.payload !== "string") throw sessionGone("backup");
  return row.payload;
}

/** End a backup session and return what it was started with, or undefined when it is already gone. Queries: one. */
export async function finishBackupSession(db: D1Database, id: string, userId: string): Promise<Row | undefined> {
  const row = await db.prepare("DELETE FROM data_transfer_sessions WHERE id = ? AND kind = 'backup' AND created_by = ? RETURNING context_json AS context").bind(id, userId).first<{ context: string }>();
  return row ? JSON.parse(row.context) as Row : undefined;
}
