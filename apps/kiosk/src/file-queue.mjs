import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Durable attendance queue.
//
// State is a compacted snapshot plus an append-only journal:
// - `${path}` is the pending queue snapshot (a JSON array, the format used
//   since release 1.0.6) and `${path}.outcomes.json` holds delivery outcomes
//   and retained rejections. `outcomes.journalSeq` is the last journal record
//   already folded into the snapshot.
// - `${path}.journal` holds one JSON record per line, each fsynced before the
//   operation resolves. An enqueue costs one small append instead of a full
//   rewrite of the queue.
//
// Compaction writes the queue snapshot, then the outcomes snapshot with the
// new watermark, then removes the journal. Replay skips records at or below
// the watermark, applies queue effects idempotently (the queue snapshot may
// be newer than the outcomes watermark after a crash between the two writes)
// and applies outcome effects exactly once. Existing queue files are read as
// the snapshot, so upgrading needs no conversion and keeps every event id.
//
// A damaged journal never stops the queue. An append that fails part-way is cut
// back off the journal before the next append, so no record is ever joined to a
// torn line. At load, a line that cannot be parsed is copied to
// `${path}.journal.damaged` for diagnosis and skipped; a complete record that a
// release without this repair joined to a torn line is recovered from that line.
// setAside() counts the entries in that file, for the kiosk's diagnostics. The
// count lasts as long as the file: it clears only when someone removes the file
// after recovering what it holds (or unpairing archives it). Nothing here
// parses or replays the damaged lines.

const emptyOutcomes = () => ({ version: 1, accepted: 0, duplicate: 0, rejected: [], pendingAck: null, historyComplete: true });
const dayMs = 24 * 60 * 60_000;
export const defaultRetention = Object.freeze({ maxAgeMs: 30 * dayMs, maxRecords: 1000 });
const reviewStates = new Set(["open", "reviewed"]);

function validEvent(value) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.eventId === "string" && value.eventId.length > 0;
}

function rejectionRecord(event, result) {
  return { eventId: event.eventId, memberId: event.memberId, occurredAt: event.occurredAt,
    ...(event.meetingId ? { meetingId: event.meetingId } : {}),
    ...(event.pairingId ? { pairingId: event.pairingId } : {}),
    ...(event.clock ? { clock: { ...event.clock } } : {}),
    httpStatus: Number.isInteger(result.status) ? result.status : null,
    reasonCode: /^[a-z][a-z0-9_]{0,39}$/.test(result.code ?? "") ? result.code : "unclassified",
    reviewStatus: "open" };
}

export function createFileQueue(path, { now = Date.now, compactBytes = 1024 * 1024, compactRecords = 2000, ackBatch = 25, retention = defaultRetention, openFile = open, log = message => console.warn(message) } = {}) {
  const outcomesPath = `${path}.outcomes.json`;
  const journalPath = `${path}.journal`;
  const damagedPath = `${journalPath}.damaged`;
  const directory = dirname(path);
  let events = [];
  let outcomes = emptyOutcomes();
  let cloudReviews = new Map();
  let outcomesPresent = false;
  let loaded = false;
  let lastSeq = 0;
  let journalBytes = 0, journalRecords = 0, journalExists = false, snapshotBytes = 0;
  // Set while an append may have left bytes that no operation acknowledged.
  let journalTorn = false;
  let bufferedAcks = [];
  let operations = Promise.resolve();
  let flushing;

  function exclusive(operation) {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async function syncDirectory() {
    if (process.platform === "win32") return;
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }

  async function persistFile(target, value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const text = `${JSON.stringify(value)}\n`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await syncDirectory();
      return Buffer.byteLength(text);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function outcomesSnapshot(journalSeq) {
    return { ...outcomes, rejected: outcomes.rejected.map(record => ({ ...record })), pendingAck: null, journalSeq,
      cloudReviews: Object.fromEntries(cloudReviews) };
  }

  async function ensureOutcomes() {
    // load() compacts whenever journal records exist without a baseline, so a
    // baseline written here never hides unapplied queue records.
    if (outcomesPresent) return;
    // Record a baseline before the first journal record, so a crash during the
    // first compaction cannot be mistaken for a legacy queue without history.
    await persistFile(outcomesPath, outcomesSnapshot(lastSeq));
    outcomesPresent = true;
  }

  async function append(records) {
    if (!records.length) return;
    await ensureOutcomes();
    const lines = records.map(record => JSON.stringify({ s: ++lastSeq, ...record })).join("\n") + "\n";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (journalTorn) await trimJournal();
    const created = !journalExists;
    const file = await openFile(journalPath, "a", 0o600);
    journalTorn = true;
    try {
      await file.writeFile(lines);
      await file.sync();
    } finally { await file.close().catch(() => undefined); }
    journalTorn = false;
    if (created) { await chmod(journalPath, 0o600); await syncDirectory(); journalExists = true; }
    journalBytes += Buffer.byteLength(lines); journalRecords += records.length;
  }

  // Cut the journal back to its last acknowledged byte. A failed append can
  // leave part of a record there; its operation was rejected, so nothing saved
  // is removed. If this fails, the append fails too and the trim is retried.
  async function trimJournal() {
    let file;
    try { file = await open(journalPath, "r+"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; journalTorn = false; return; }
    try { await file.truncate(journalBytes); await file.sync(); } finally { await file.close(); }
    journalTorn = false;
  }

  // Apply one journal record. Queue effects are idempotent; outcome effects
  // run once because records at or below the outcomes watermark are skipped.
  function apply(record) {
    if (record.t === "e") {
      if (!events.some(event => event.eventId === record.event.eventId)) events.push(Object.freeze({ ...record.event }));
    } else if (record.t === "u") {
      const index = events.findIndex(event => event.eventId === record.event.eventId);
      if (index >= 0) events[index] = Object.freeze({ ...record.event });
    } else if (record.t === "d") {
      for (const item of record.items) {
        events = events.filter(event => event.eventId !== item.eventId);
        if (item.result === "accepted") outcomes.accepted += 1;
        else if (item.result === "duplicate") outcomes.duplicate += 1;
        else if (!outcomes.rejected.some(saved => saved.eventId === item.eventId)) outcomes.rejected.push(item.record);
      }
    } else if (record.t === "r") {
      const saved = outcomes.rejected.find(item => item.eventId === record.eventId);
      if (saved && saved.reviewStatus !== "reviewed") Object.assign(saved, { reviewStatus: "reviewed", reviewedAt: record.reviewedAt });
    } else if (record.t === "c") {
      for (const review of record.reviews) {
        const saved = outcomes.rejected.find(item => item.eventId === review.eventId);
        if (!saved) continue;
        cloudReviews.set(review.eventId, review.reviewStatus);
        if (review.reviewStatus === "reviewed" && saved.reviewStatus !== "reviewed") Object.assign(saved, { reviewStatus: "reviewed", reviewedAt: review.reviewedAt });
      }
    }
  }

  function validRecord(record) {
    if (!record || typeof record !== "object" || !Number.isSafeInteger(record.s) || record.s < 1) return false;
    if (record.t === "e" || record.t === "u") return validEvent(record.event);
    if (record.t === "d") return Array.isArray(record.items) && record.items.every(item => item && typeof item.eventId === "string" && item.eventId
      && (["accepted", "duplicate"].includes(item.result) || item.result === "rejected" && item.record?.eventId === item.eventId));
    if (record.t === "r") return typeof record.eventId === "string" && typeof record.reviewedAt === "string";
    if (record.t === "c") return Array.isArray(record.reviews) && record.reviews.every(review => typeof review?.eventId === "string" && reviewStates.has(review.reviewStatus));
    return false;
  }

  // A release without the trim above could append a complete record straight
  // after a torn one. That record was acknowledged, so recover it: it is the
  // first place in the line where a whole valid record starts.
  function joinedRecord(line) {
    for (let at = line.indexOf('{"s":', 1); at > 0; at = line.indexOf('{"s":', at + 1)) {
      try { const record = JSON.parse(line.slice(at)); if (validRecord(record)) return record; } catch { /* Not a record start. */ }
    }
    return undefined;
  }

  async function readJournal() {
    let bytes;
    try { bytes = await readFile(journalPath); journalExists = true; }
    catch (error) { if (error?.code === "ENOENT") return { records: [], torn: false, damaged: [] }; throw error; }
    const lines = bytes.toString("utf8").split("\n");
    const tail = lines.pop();
    const records = [], damaged = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); }
      catch {
        // Not a record: keep the line for diagnosis and carry on with the rest.
        damaged.push(line);
        const joined = joinedRecord(line);
        if (joined) records.push(joined);
        continue;
      }
      if (!validRecord(record)) throw new Error("Attendance journal has an invalid record");
      records.push(record);
    }
    // A power loss can leave a partial final line. Its append never completed,
    // so its operation was never acknowledged; a complete final line is kept.
    let torn = false;
    if (tail) {
      torn = true;
      try { const record = JSON.parse(tail); if (validRecord(record)) records.push(record); } catch { /* Unacknowledged partial append. */ }
    }
    for (let index = 1; index < records.length; index++) if (records[index].s <= records[index - 1].s) throw new Error("Attendance journal order is invalid");
    journalBytes = bytes.length; journalRecords = records.length;
    return { records, torn, damaged };
  }

  // The entries in the side file: distinct damaged lines, so a line set aside again after a crash before the journal
  // was rewritten counts once, and the time the newest was found. A side-file entry cut short by a power cut is
  // written again whole at the next start, joined to the cut one; only that whole entry counts.
  let setAsideRead = { key: "", value: { count: 0, lastAt: null } };
  async function readSetAside() {
    let info;
    try { info = await stat(damagedPath); } catch (error) { if (error?.code === "ENOENT") return { count: 0, lastAt: null }; throw error; }
    const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (setAsideRead.key === key) return { ...setAsideRead.value };
    const lines = new Set(); let lastAt = null;
    for (const text of (await readFile(damagedPath, "utf8")).split("\n")) {
      let entry;
      for (let at = 0; at >= 0 && !entry; at = text.indexOf('{"foundAt":', at + 1)) {
        try { const value = JSON.parse(text.slice(at)); if (typeof value?.line === "string") entry = value; } catch { /* Not a whole entry from here. */ }
      }
      if (!entry) continue;
      lines.add(entry.line);
      if (typeof entry.foundAt === "string" && Number.isFinite(Date.parse(entry.foundAt)) && (!lastAt || Date.parse(entry.foundAt) > Date.parse(lastAt))) lastAt = entry.foundAt;
    }
    setAsideRead = { key, value: { count: lines.size, lastAt: lines.size ? lastAt : null } };
    return { ...setAsideRead.value };
  }

  // Keep unreadable journal lines in an owner-only side file before the journal is rewritten without them.
  async function quarantine(lines) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const foundAt = new Date(now()).toISOString();
    const file = await open(damagedPath, "a", 0o600);
    try {
      await file.writeFile(lines.map(line => `${JSON.stringify({ foundAt, line })}\n`).join(""));
      await file.sync();
    } finally { await file.close(); }
    await chmod(damagedPath, 0o600); await syncDirectory();
    log(`Queue journal ${journalPath} had ${lines.length} unreadable line${lines.length === 1 ? "" : "s"}. Saved in ${damagedPath}; every readable record was kept.`);
  }

  function prune() {
    const maxAgeMs = retention?.maxAgeMs ?? defaultRetention.maxAgeMs;
    const maxRecords = retention?.maxRecords ?? defaultRetention.maxRecords;
    // Only records the cloud has acknowledged can leave the kiosk; the
    // dashboard then holds the evidence and its review state.
    const acknowledged = outcomes.rejected.filter(record => cloudReviews.has(record.eventId));
    const remove = new Set();
    const current = now();
    for (const record of acknowledged) {
      const at = Date.parse(record.reviewedAt ?? record.occurredAt);
      if (Number.isFinite(at) && current - at > maxAgeMs) remove.add(record.eventId);
    }
    for (const record of acknowledged) {
      if (outcomes.rejected.length - remove.size <= maxRecords) break;
      remove.add(record.eventId);
    }
    if (!remove.size) return;
    outcomes.rejected = outcomes.rejected.filter(record => !remove.has(record.eventId));
    for (const eventId of remove) cloudReviews.delete(eventId);
    outcomes.retired = (outcomes.retired ?? 0) + remove.size;
  }

  async function compact() {
    await flushAcks();
    prune();
    const queueBytes = await persistFile(path, events);
    const outcomesBytes = await persistFile(outcomesPath, outcomesSnapshot(lastSeq));
    outcomesPresent = true;
    outcomes.journalSeq = lastSeq;
    await unlink(journalPath).catch(error => { if (error?.code !== "ENOENT") throw error; });
    await syncDirectory();
    journalExists = false; journalBytes = 0; journalRecords = 0; snapshotBytes = queueBytes + outcomesBytes;
  }

  async function maybeCompact() {
    if (journalRecords >= compactRecords || journalBytes >= Math.max(compactBytes, snapshotBytes)) await compact();
  }

  async function flushAcks() {
    if (!bufferedAcks.length) return;
    const items = bufferedAcks;
    await append([{ t: "d", items }]);
    bufferedAcks = [];
  }

  async function load() {
    if (loaded) return;
    let existingQueue = false;
    let nextEvents = [], nextOutcomes = emptyOutcomes(), present = false;
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(value) || !value.every(validEvent)) throw new Error("Attendance queue is not an array of events");
      nextEvents = value.map(event => Object.freeze({ ...event }));
      existingQueue = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      const value = JSON.parse(await readFile(outcomesPath, "utf8"));
      if (value?.version !== 1 || !Number.isSafeInteger(value.accepted) || value.accepted < 0
        || !Number.isSafeInteger(value.duplicate) || value.duplicate < 0
        || !Array.isArray(value.rejected) || typeof value.historyComplete !== "boolean"
        || (value.pendingAck !== null && (typeof value.pendingAck?.eventId !== "string" || !value.pendingAck.eventId))
        || (value.journalSeq !== undefined && (!Number.isSafeInteger(value.journalSeq) || value.journalSeq < 0))
        || (value.retired !== undefined && (!Number.isSafeInteger(value.retired) || value.retired < 0))
        || (value.cloudReviews !== undefined && (!value.cloudReviews || typeof value.cloudReviews !== "object" || Array.isArray(value.cloudReviews)
          || Object.values(value.cloudReviews).some(status => !reviewStates.has(status))))) {
        throw new Error("Attendance outcomes have an invalid format");
      }
      nextOutcomes = { ...value, rejected: value.rejected.map(record => ({ ...record })) };
      present = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      nextOutcomes.historyComplete = !existingQueue;
    }
    const watermark = nextOutcomes.journalSeq ?? 0;
    const { records, torn, damaged } = await readJournal();
    events = nextEvents; outcomes = nextOutcomes; outcomesPresent = present;
    cloudReviews = new Map(Object.entries(nextOutcomes.cloudReviews ?? {}));
    delete outcomes.cloudReviews;
    // An older release finished an outcome write but not the queue rewrite.
    let recovered = false;
    const pendingAck = outcomes.pendingAck?.eventId;
    if (pendingAck) {
      if (events[0]?.eventId === pendingAck) events = events.slice(1);
      else if (events.some(event => event.eventId === pendingAck)) throw new Error("Attendance replay order changed during recovery");
      outcomes.pendingAck = null; recovered = true;
    }
    for (const record of records) if (record.s > watermark) apply(record);
    lastSeq = Math.max(watermark, records.at(-1)?.s ?? 0);
    if (damaged.length) await quarantine(damaged);
    // Rewrite immediately when the journal tail is partial (a later append
    // would otherwise follow a broken line), unreadable lines were set aside,
    // a legacy recovery ran, or the outcomes baseline is missing while journal
    // records exist.
    if (torn || damaged.length || recovered || (!present && records.length)) await compact();
    loaded = true;
  }

  async function drain(send, prepare) {
    const delivered = [];
    try {
      while (true) {
        let prepared;
        const event = await exclusive(async () => {
          await load();
          if (events[0] && prepare) {
            prepared = await prepare({ ...events[0] });
            if (prepared?.event && JSON.stringify(prepared.event) !== JSON.stringify(events[0])) {
              if (prepared.event.eventId !== events[0].eventId) throw new Error("Prepared scan identity changed");
              // The resolved scan must be durable before it is sent.
              await append([{ t: "u", event: prepared.event }]);
              events[0] = Object.freeze({ ...prepared.event });
            }
          }
          return events[0] && { ...events[0] };
        });
        if (!event || prepared?.deferred) return delivered;
        let result;
        try { result = prepared?.rejected ? prepared : await send(event); } catch { return delivered; }
        await exclusive(async () => {
          if (events[0]?.eventId !== event.eventId) throw new Error("Attendance queue changed during replay");
          // Acknowledgements are batched. A crash before the batch is written
          // resends those scans; the server dedupes them on kiosk_event_id.
          // A scan refused as a possible wrong match recorded nothing and needs no review. It is journaled as a
          // duplicate so releases that know only these three results can still read the journal.
          const item = result?.rejected ? { eventId: event.eventId, result: "rejected", record: rejectionRecord(event, result) }
            : { eventId: event.eventId, result: result?.duplicate || result?.rescan ? "duplicate" : "accepted" };
          apply({ t: "d", items: [item] });
          bufferedAcks.push(item);
          if (bufferedAcks.length >= ackBatch) { await flushAcks(); await maybeCompact(); }
          delivered.push(event.eventId);
        });
      }
    } finally {
      await exclusive(async () => { if (loaded) { await flushAcks(); await maybeCompact(); } });
    }
  }

  return {
    enqueue(event) {
      return exclusive(async () => {
        await load();
        if (!event?.eventId || events.some((item) => item.eventId === event.eventId)) return false;
        const saved = Object.freeze({ ...event });
        await append([{ t: "e", event: saved }]);
        events.push(saved);
        await maybeCompact();
        return true;
      });
    },
    pending() {
      return exclusive(async () => {
        await load();
        return events.map((event) => ({ ...event }));
      });
    },
    /** Unreadable journal entries kept in the side file: { count, lastAt, file }. Does not load the queue. */
    setAside() {
      return exclusive(async () => ({ ...await readSetAside(), file: damagedPath }));
    },
    diagnostics() {
      return exclusive(async () => {
        await load();
        const retired = outcomes.retired ?? 0;
        return { saved: events.length + outcomes.accepted + outcomes.duplicate + outcomes.rejected.length + retired,
          pending: events.length, accepted: outcomes.accepted, duplicate: outcomes.duplicate,
          rejected: outcomes.rejected.length + retired, needsReview: outcomes.rejected.filter(record => record.reviewStatus !== "reviewed").length,
          clockPending: events.filter(event => event.clock?.verified === false).length, historyComplete: outcomes.historyComplete };
      });
    },
    rejections() {
      return exclusive(async () => {
        await load();
        return outcomes.rejected.map((record) => ({ ...record }));
      });
    },
    // Cloud acknowledgement state for incremental review sync.
    cloudReviews() {
      return exclusive(async () => {
        await load();
        return new Map(cloudReviews);
      });
    },
    // Persist one validated batch of cloud acknowledgements in one append.
    // Local review is monotonic: an open cloud record never reopens it.
    recordCloudReviews(reviews) {
      return exclusive(async () => {
        await load();
        const reviewedAt = new Date(now()).toISOString();
        const changed = reviews.filter(review => reviewStates.has(review?.reviewStatus) && outcomes.rejected.some(record => record.eventId === review.eventId)
          && (cloudReviews.get(review.eventId) !== review.reviewStatus || review.reviewStatus === "reviewed" && outcomes.rejected.find(record => record.eventId === review.eventId).reviewStatus !== "reviewed"))
          .map(review => ({ eventId: review.eventId, reviewStatus: review.reviewStatus, ...(review.reviewStatus === "reviewed" ? { reviewedAt } : {}) }));
        if (!changed.length) return 0;
        const record = { t: "c", reviews: changed };
        await append([record]);
        apply(record);
        await maybeCompact();
        return changed.length;
      });
    },
    markReviewed(eventId) {
      return exclusive(async () => {
        await load();
        const saved = outcomes.rejected.find((record) => record.eventId === eventId);
        if (!saved) return false;
        if (saved.reviewStatus === "reviewed") return true;
        const record = { t: "r", eventId, reviewedAt: new Date(now()).toISOString() };
        await append([record]);
        apply(record);
        await maybeCompact();
        return true;
      });
    },
    flush(send, { prepare } = {}) {
      if (!flushing) flushing = drain(send, prepare).finally(() => { flushing = undefined; });
      return flushing;
    },
    // Fold the journal into the snapshot files and apply retention. Called on
    // orderly shutdown (so an installed older release would still read every
    // saved scan) and periodically by the service.
    compact() {
      return exclusive(async () => {
        await load();
        await compact();
      });
    },
  };
}
