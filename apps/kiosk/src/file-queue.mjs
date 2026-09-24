import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const emptyOutcomes = () => ({ version: 1, accepted: 0, duplicate: 0, rejected: [], pendingAck: null, historyComplete: true });

export function createFileQueue(path) {
  const outcomesPath = `${path}.outcomes.json`;
  let events = [];
  let outcomes = emptyOutcomes();
  let outcomesPresent = false;
  let loaded = false;
  let operations = Promise.resolve();
  let flushing;

  function exclusive(operation) {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persistFile(target, value, afterRename) {
    const directory = dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      afterRename();
      if (process.platform !== "win32") {
        const parent = await open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function persistQueue(next) {
    return persistFile(path, next, () => { events = next; });
  }

  function persistOutcomes(next) {
    return persistFile(outcomesPath, next, () => { outcomes = next; outcomesPresent = true; });
  }

  async function recoverPendingAck() {
    const eventId = outcomes.pendingAck?.eventId;
    if (!eventId) return;
    if (events[0]?.eventId === eventId) await persistQueue(events.slice(1));
    else if (events.some((event) => event.eventId === eventId)) throw new Error("Attendance replay order changed during recovery");
    await persistOutcomes({ ...outcomes, pendingAck: null });
  }

  async function load() {
    if (!loaded) {
      let existingQueue = false;
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (!Array.isArray(value)) throw new Error("Attendance queue is not an array");
        events = value;
        existingQueue = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        const value = JSON.parse(await readFile(outcomesPath, "utf8"));
        if (value?.version !== 1 || !Number.isSafeInteger(value.accepted) || value.accepted < 0
          || !Number.isSafeInteger(value.duplicate) || value.duplicate < 0
          || !Array.isArray(value.rejected) || typeof value.historyComplete !== "boolean"
          || (value.pendingAck !== null && (typeof value.pendingAck?.eventId !== "string" || !value.pendingAck.eventId))) {
          throw new Error("Attendance outcomes have an invalid format");
        }
        outcomes = value;
        outcomesPresent = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        outcomes.historyComplete = !existingQueue;
      }
      loaded = true;
    }
    await recoverPendingAck();
  }

  async function drain(send) {
    const delivered = [];
    while (true) {
      const event = await exclusive(async () => {
        await load();
        return events[0] && { ...events[0] };
      });
      if (!event) return delivered;
      let result;
      try { result = await send(event); } catch { return delivered; }
      await exclusive(async () => {
        if (events[0]?.eventId !== event.eventId) throw new Error("Attendance queue changed during replay");
        const updated = { ...outcomes, rejected: [...outcomes.rejected], pendingAck: { eventId: event.eventId } };
        if (result?.rejected) {
          updated.rejected.push({ eventId: event.eventId, memberId: event.memberId, occurredAt: event.occurredAt,
            ...(event.meetingId ? { meetingId: event.meetingId } : {}),
            httpStatus: Number.isInteger(result.status) ? result.status : null,
            reasonCode: /^[a-z][a-z0-9_]{0,39}$/.test(result.code ?? "") ? result.code : "unclassified",
            reviewStatus: "open" });
        } else if (result?.duplicate) updated.duplicate += 1;
        else updated.accepted += 1;
        await persistOutcomes(updated);
        await persistQueue(events.slice(1));
        await persistOutcomes({ ...outcomes, pendingAck: null });
        delivered.push(event.eventId);
      });
    }
  }

  return {
    enqueue(event) {
      return exclusive(async () => {
        await load();
        if (!event?.eventId || events.some((item) => item.eventId === event.eventId)) return false;
        if (!outcomesPresent) await persistOutcomes(outcomes);
        await persistQueue([...events, Object.freeze({ ...event })]);
        return true;
      });
    },
    pending() {
      return exclusive(async () => {
        await load();
        return events.map((event) => ({ ...event }));
      });
    },
    diagnostics() {
      return exclusive(async () => {
        await load();
        return { saved: events.length + outcomes.accepted + outcomes.duplicate + outcomes.rejected.length,
          pending: events.length, accepted: outcomes.accepted, duplicate: outcomes.duplicate,
          rejected: outcomes.rejected.length, historyComplete: outcomes.historyComplete };
      });
    },
    rejections() {
      return exclusive(async () => {
        await load();
        return outcomes.rejected.map((record) => ({ ...record }));
      });
    },
    markReviewed(eventId) {
      return exclusive(async () => {
        await load();
        const index = outcomes.rejected.findIndex((record) => record.eventId === eventId);
        if (index < 0) return false;
        if (outcomes.rejected[index].reviewStatus === "reviewed") return true;
        const rejected = outcomes.rejected.map((record, offset) => offset === index
          ? { ...record, reviewStatus: "reviewed", reviewedAt: new Date().toISOString() } : record);
        await persistOutcomes({ ...outcomes, rejected });
        return true;
      });
    },
    flush(send) {
      if (!flushing) flushing = drain(send).finally(() => { flushing = undefined; });
      return flushing;
    },
  };
}
