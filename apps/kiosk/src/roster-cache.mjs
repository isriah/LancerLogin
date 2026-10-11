import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

function cleanMembers(value) {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Roster cache is invalid");
  return value.map((member) => {
    const memberId = typeof member?.memberId === "string" ? member.memberId.trim() : "";
    if (!memberId || memberId.length > 100 || /[\u0000-\u001f\u007f]/.test(memberId)) throw new Error("Roster cache is invalid");
    return { memberId, firstName: String(member.firstName ?? "").slice(0, 100), lastName: String(member.lastName ?? "").slice(0, 100) };
  });
}

export function createRosterCache(path) {
  let members;
  async function read() {
    if (members) return members.map((member) => ({ ...member }));
    try { members = cleanMembers(JSON.parse(await readFile(path, "utf8"))?.members); }
    catch (error) { if (error?.code !== "ENOENT") throw error; members = []; }
    return members.map((member) => ({ ...member }));
  }
  return {
    read,
    async has(memberId) { const normalized = typeof memberId === "string" ? memberId.trim() : ""; return (await read()).some((member) => member.memberId === normalized); },
    async replace(value) {
      const next = cleanMembers(value); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(`${JSON.stringify({ version: 1, members: next })}\n`); await file.sync(); } finally { await file.close(); } await chmod(temporary, 0o600); await rename(temporary, path); members = next; }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
      return read();
    },
  };
}
