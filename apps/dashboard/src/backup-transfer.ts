// Backups and restores in parts.
//
// A multi-season backup is tens of megabytes. Reading or checking that much in one Worker request costs several times the
// Workers Free CPU allowance, so the browser does the heavy work instead: it splits a backup file into parts of about
// 64 KiB, uploads them one request each, and asks the API to switch over in one final request; and it downloads a
// backup's parts and puts the file together. The API side is apps/api/src/data-transfer.ts. Nothing here touches the
// page, so the same code drives the API in tests.

export type TransferScope = "meetings" | "roster" | "installation";
/** Sends one API request: a path below the API root, with the session cookie. */
export type TransferRequest = (path: string, init?: { method?: string; body?: string | Uint8Array }) => Promise<Response>;
export type TransferProgress = (done: number, total: number) => void;

/**
 * Tables whose rows may be uploaded in parts: the ones that grow with every meeting, scan and audited action. The API
 * accepts parts for exactly these (stagedBackupTables in apps/api/src/index.ts); every other table stays in the document.
 */
export const stagedTables: readonly string[] = ["meetings", "meeting_audience_labels", "attendance_events", "attendance_corrections", "member_label_changes", "audit_log", "integration_deliveries", "integration_state", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports", "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations"];
/** Aim for parts of this many bytes; the API accepts up to four times that. */
export const partTargetBytes = 65_536;
const partMaximumBytes = 262_144;
/** A table smaller than this stays in the document: a part of its own would cost a request and save nothing. */
const inlineTableBytes = 16_384;
const parallelRequests = 4;
const attempts = 3;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const encoder = new TextEncoder();

const roundConstants = /* @__PURE__ */ (() => {
  // The fractional parts of the cube roots of the first 64 primes (FIPS 180-4).
  const constants: number[] = [];
  for (let candidate = 2; constants.length < 64; candidate += 1) {
    let prime = true; for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) if (candidate % divisor === 0) { prime = false; break; }
    if (prime) constants.push(Math.floor((Math.cbrt(candidate) % 1) * 0x1_0000_0000));
  }
  return constants;
})();
/** SHA-256 in plain JavaScript, for pages the browser gives no Web Crypto (a preview on a LAN address over HTTP). */
export function sha256Fallback(bytes: Uint8Array): string {
  const rotate = (value: number, by: number) => (value >>> by) | (value << (32 - by));
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer); view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x2000_0000)); view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const words = new Int32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getInt32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const early = words[index - 15]!, late = words[index - 2]!;
      words[index] = (words[index - 16]! + (rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)) + words[index - 7]! + (rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + roundConstants[index]! + words[index]!) | 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + first) | 0; d = c; c = b; b = a; a = (first + second) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { state[index] = (state[index]! + value) | 0; });
  }
  return state.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Fallback(bytes);
  let hex = ""; for (const byte of new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource))) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export type BackupPart = { table: string; rows: number; body: Uint8Array };
/**
 * Split a parsed backup file for upload: the document with its large tables emptied, and those tables' rows in parts of
 * about `targetBytes`. A file that is not shaped like a backup is returned whole, for the API to refuse with its own message.
 */
export function splitBackup(backup: unknown, targetBytes = partTargetBytes): { document: string; parts: BackupPart[] } {
  if (!isObject(backup) || !isObject(backup.tables)) return { document: JSON.stringify(backup), parts: [] };
  const tables: Record<string, unknown> = { ...backup.tables }; const parts: BackupPart[] = [];
  for (const table of stagedTables) {
    const rows = tables[table];
    if (!Array.isArray(rows) || !rows.length) continue;
    const encoded = rows.map((row) => encoder.encode(JSON.stringify(row)));
    const total = encoded.reduce((sum, row) => sum + row.length + 1, 1);
    // A row too large for one part cannot be staged, so its table stays in the document.
    if (total < inlineTableBytes || encoded.some((row) => row.length + 2 > partMaximumBytes)) continue;
    for (let start = 0; start < encoded.length;) {
      let end = start, size = 1;
      while (end < encoded.length && (end === start || size + encoded[end]!.length + 1 <= targetBytes)) { size += encoded[end]!.length + 1; end += 1; }
      // "[" row "," row ... "]": the same bytes JSON.stringify gives for the slice.
      const body = new Uint8Array(size); body[0] = 0x5b; let offset = 1;
      for (let index = start; index < end; index += 1) { body.set(encoded[index]!, offset); offset += encoded[index]!.length; body[offset] = index === end - 1 ? 0x5d : 0x2c; offset += 1; }
      parts.push({ table, rows: end - start, body }); start = end;
    }
    tables[table] = [];
  }
  return { document: JSON.stringify({ ...backup, tables }), parts };
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });
/** A request that failed in transit, was rate limited or met a server error is sent again; any other answer is final. */
async function sendWithRetry(send: () => Promise<Response>, wait: (milliseconds: number) => Promise<void>): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await send();
      if ((result.status < 500 && result.status !== 429) || attempt === attempts) return result;
    } catch (error) { if (attempt === attempts) throw error; }
    await wait(400 * attempt);
  }
}
/** Run `work` over the items, a few at a time, stopping at the first failure. */
async function inParallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failed = false;
  const run = async () => { while (!failed && next < items.length) { const item = items[next]!; next += 1; try { await work(item); } catch (error) { failed = true; throw error; } } };
  await Promise.all(Array.from({ length: Math.min(parallelRequests, items.length) }, run));
}
/** How many times a transfer picks up again after its connection dropped, waiting 1, 2, 4 and 8 seconds. */
const resumes = 4;
/**
 * Move every item, and carry on after a dropped connection instead of starting over: wait, ask `remaining` what is still
 * to move, and continue with that. An answer the API gave (TransferRefused) is final.
 */
async function moveAll<T>(items: readonly T[], work: (item: T) => Promise<void>, remaining: () => Promise<readonly T[]>, wait: (milliseconds: number) => Promise<void>): Promise<void> {
  let pending = items;
  for (let round = 0; ; round += 1) {
    try { await inParallel(pending, work); return; }
    catch (error) {
      if (error instanceof TransferRefused || round === resumes) throw error;
      await wait(1_000 * 2 ** round);
      try { pending = await remaining(); } catch (inner) { if (inner instanceof TransferRefused) throw inner; /* Still unreachable: the next round tries the same items. */ }
    }
  }
}

/** A transfer stopped by an answer the API gave. A restore refused before its final request changed nothing. */
export class TransferRefused extends Error {
  readonly response: Response;
  constructor(response: Response) { super(`Request failed with status ${response.status}`); this.response = response; }
}
/**
 * The final request was sent but no answer arrived, even on asking again, so the restore may or may not have completed.
 * `signedOut` is set when asking again found the session ended, as it is for everyone once an entire-installation
 * restore completes.
 */
export class RestoreOutcomeUnknown extends Error {
  readonly signedOut: boolean;
  constructor(signedOut = false) { super(signedOut ? "The restore completed and ended this session." : "The connection dropped while the restore was finishing."); this.signedOut = signedOut; }
}

export type RestoreInput = { scope: TransferScope; confirmation: string; backup: unknown; excludeModules?: readonly string[]; onProgress?: TransferProgress; wait?: (milliseconds: number) => Promise<void> };
/**
 * Restore a parsed backup file in parts and return the API's final answer: the completed restore, or the refusal of the
 * backup document (a 409 names modules the installation cannot restore). Every part is staged before one last request
 * replaces the data, so a failure before that request changes nothing; staged parts are then cancelled. After a dropped
 * connection the upload asks the API which parts are missing and continues with those. The final request is safe to
 * repeat (the API answers a repeat with the first answer), so it is sent again when its answer is lost.
 * Throws TransferRefused when a part is refused and RestoreOutcomeUnknown when the final answer cannot be had.
 * Returns undefined when the API has no restore in parts (an earlier release), for the caller to use the single request.
 */
export async function restoreInParts(request: TransferRequest, input: RestoreInput): Promise<Response | undefined> {
  const wait = input.wait ?? pause; const { document, parts } = splitBackup(input.backup);
  const declared = await Promise.all(parts.map(async (part) => ({ table: part.table, rows: part.rows, sha256: await sha256Hex(part.body) })));
  const begun = await request("/admin/data/restore/sessions", { method: "POST", body: JSON.stringify({ scope: input.scope, confirmation: input.confirmation, document, parts: declared, ...(input.excludeModules ? { excludeModules: input.excludeModules } : {}) }) });
  if (begun.status === 404) return undefined;
  if (begun.status !== 201) return begun;
  const session = await begun.json() as { id: string; digest: string; parts: number[] };
  const base = `/admin/data/restore/sessions/${session.id}`; const total = session.parts.length;
  const cancel = () => request(base, { method: "DELETE" }).then(() => undefined, () => undefined);
  let done = 0; input.onProgress?.(0, total);
  const upload = async (seq: number) => {
    const result = await sendWithRetry(() => request(`${base}/parts/${seq}`, { method: "PUT", body: parts[seq]!.body }), wait);
    if (!result.ok) throw new TransferRefused(result);
    done += 1; input.onProgress?.(Math.min(done, total), total);
  };
  const missing = async () => {
    const status = await request(base);
    if (!status.ok) throw new TransferRefused(status);
    const left = (await status.json() as { missing: number[] }).missing;
    done = total - left.length; input.onProgress?.(done, total);
    return left;
  };
  try { await moveAll(session.parts, upload, missing, wait); }
  catch (error) { await cancel(); throw error; }
  const commit = () => request(`${base}/commit`, { method: "POST", body: JSON.stringify({ confirmation: input.confirmation, digest: session.digest }) });
  for (let attempt = 1; ; attempt += 1) {
    let committed: Response;
    try { committed = await commit(); }
    catch { if (attempt === attempts) throw new RestoreOutcomeUnknown(); await wait(1_000 * attempt); continue; }
    // Asked again after a lost answer, an entire-installation restore that completed has ended this session with every other.
    if (attempt > 1 && committed.status === 401 && input.scope === "installation") throw new RestoreOutcomeUnknown(true);
    // The final batch either completed whole or changed nothing; a refusal leaves only staged parts to remove.
    if (!committed.ok) await cancel();
    return committed;
  }
}

type BackupSession = { id: string; filename: string; document: { tables: Record<string, unknown[]>; externalModules?: { id: string; tables: Record<string, unknown[]> }[] }; columns: Record<string, string[]>; parts: { seq: number; rows: number; table: string; module?: string }[] };
export type DownloadInput = { scope: TransferScope; updateRequestId?: string; onProgress?: TransferProgress; wait?: (milliseconds: number) => Promise<void> };
/**
 * Download a backup in parts and return the file: the same JSON document the single-request backup produces. The API
 * copied every table in one snapshot when the download started, so the parts agree with each other however long they
 * take, and a download whose connection dropped continues with the parts it does not have yet. The file is put together
 * and checked before the API is told the download completed, which is what records a web update's backup.
 * Returns undefined when the API cannot stage a backup now (an earlier release, or writes suspended for an update), for
 * the caller to use the single request. Throws TransferRefused on any other refusal.
 */
export async function downloadBackup(request: TransferRequest, input: DownloadInput): Promise<{ filename: string; text: string } | undefined> {
  const wait = input.wait ?? pause;
  const begun = await request("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: input.scope, ...(input.updateRequestId ? { updateRequestId: input.updateRequestId } : {}) }) });
  if (begun.status === 404 || begun.status === 503) return undefined;
  if (begun.status !== 201) throw new TransferRefused(begun);
  const session = await begun.json() as BackupSession; const base = `/admin/data/backup/sessions/${session.id}`; const total = session.parts.length;
  const received = new Map<number, Record<string, unknown>[]>(); input.onProgress?.(0, total);
  const cancel = () => request(base, { method: "DELETE" }).then(() => undefined, () => undefined);
  const fetchPart = async (part: BackupSession["parts"][number]) => {
    const result = await sendWithRetry(() => request(`${base}/parts/${part.seq}`), wait);
    if (!result.ok) throw new TransferRefused(result);
    const rows = await result.json() as unknown[][];
    const columns = session.columns[part.table];
    if (!Array.isArray(rows) || rows.length !== part.rows || !columns) throw new Error("A part of the backup arrived incomplete.");
    received.set(part.seq, rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))));
    input.onProgress?.(received.size, total);
  };
  let text: string;
  try {
    await moveAll(session.parts, fetchPart, async () => session.parts.filter((part) => !received.has(part.seq)), wait);
    // Parts are numbered in table order, then row order.
    let expected = 0, assembled = 0;
    for (const part of [...session.parts].sort((left, right) => left.seq - right.seq)) {
      const tables = part.module ? session.document.externalModules?.find((module) => module.id === part.module)?.tables : session.document.tables;
      if (!tables || !Array.isArray(tables[part.table])) throw new Error("The backup's parts do not match its tables.");
      for (const row of received.get(part.seq)!) tables[part.table]!.push(row);
      expected += part.rows;
    }
    for (const tables of [session.document.tables, ...(session.document.externalModules ?? []).map((module) => module.tables)]) for (const rows of Object.values(tables)) assembled += rows.length;
    if (assembled !== expected) throw new Error("The backup's parts do not match its tables.");
    text = JSON.stringify(session.document);
  } catch (error) { await cancel(); throw error; }
  // Only now is the download complete. For a web update this records its backup, so it must succeed; otherwise it only
  // removes the staged parts, which expire by themselves.
  // A repeat of a completion whose answer was lost finds the session already gone; the update card then reads whether the
  // backup was recorded.
  let completed: Response | undefined; let lost = false;
  try { completed = await sendWithRetry(() => request(`${base}/complete`, { method: "POST", body: "{}" }).catch((error: unknown) => { lost = true; throw error; }), wait); } catch (error) { if (input.updateRequestId) throw error; }
  if (input.updateRequestId && completed && !completed.ok && !(lost && completed.status === 404)) throw new TransferRefused(completed);
  return { filename: session.filename, text };
}
