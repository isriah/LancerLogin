import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createMappingStore(path) {
  async function read() { try { const value = JSON.parse(await readFile(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch (error) { if (error?.code === "ENOENT") return {}; throw error; } }
  return {
    read,
    async memberForSlot(slot) { const mappings = await read(); return mappings[String(slot)]; },
    async replace(mappings) { const clean = Object.fromEntries(Object.entries(mappings).filter(([slot, memberId]) => /^\d{1,4}$/.test(slot) && typeof memberId === "string" && memberId.length > 0 && memberId.length <= 100)); if (Object.keys(clean).length !== Object.keys(mappings).length) throw new Error("Invalid slot mapping"); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600); return clean; },
  };
}
