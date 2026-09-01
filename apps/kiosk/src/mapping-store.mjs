import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createMappingStore(path) {
  async function read() { try { const value = JSON.parse(await readFile(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch (error) { if (error?.code === "ENOENT") return {}; throw error; } }
  return {
    read,
    async memberForSlot(slot) { const mappings = await read(); const value = mappings[String(slot)]; return typeof value === "string" ? value : value?.memberId; },
    async replace(mappings) { const entries = Object.entries(mappings); const clean = {}; for (const [slot, value] of entries) { const mapping = typeof value === "string" ? { memberId: value, finger: "unspecified" } : value; if (!/^\d{1,4}$/.test(slot) || !mapping || typeof mapping.memberId !== "string" || !mapping.memberId.length || mapping.memberId.length > 100 || typeof mapping.finger !== "string" || mapping.finger.length > 40) throw new Error("Invalid slot mapping"); clean[slot] = { memberId: mapping.memberId, finger: mapping.finger || "unspecified" }; } await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600); return clean; },
  };
}
