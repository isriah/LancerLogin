import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createFileQueue(path) {
  let events = []; let loaded = false;
  async function load() { if (loaded) return; try { const value = JSON.parse(await readFile(path, "utf8")); events = Array.isArray(value) ? value : []; } catch (error) { if (error?.code !== "ENOENT") throw error; } loaded = true; }
  async function persist() { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(events)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600); }
  return {
    async enqueue(event) { await load(); if (!event?.eventId || events.some((item) => item.eventId === event.eventId)) return false; events.push(Object.freeze({ ...event })); await persist(); return true; },
    async pending() { await load(); return events.map((event) => ({ ...event })); },
    async flush(send) { await load(); const delivered = []; while (events.length) { try { await send(events[0]); } catch { break; } delivered.push(events.shift().eventId); await persist(); } return delivered; },
  };
}
