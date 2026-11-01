import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { cleanPinHash } from "./member-pins.mjs";

// Emails come only to kiosks in Member search mode, for matching; PIN hashes and locks only to kiosks with Require PIN.
// Neither is ever shown: visibleMember() is all a screen or maintenance page receives.
function cleanMembers(value, { email = true, pins = true } = {}) {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Roster cache is invalid");
  return value.map((member) => {
    const memberId = typeof member?.memberId === "string" ? member.memberId.trim() : "";
    if (!memberId || memberId.length > 100 || /[\u0000-\u001f\u007f]/.test(memberId)) throw new Error("Roster cache is invalid");
    const clean = { memberId, firstName: String(member.firstName ?? "").slice(0, 100), lastName: String(member.lastName ?? "").slice(0, 100) };
    if (email && typeof member.email === "string" && member.email.trim() && member.email.length <= 320) clean.email = member.email.trim();
    const pin = pins ? cleanPinHash(member.pin) : null;
    if (pin) clean.pin = pin;
    if (pins && typeof member.pinLockedUntil === "string" && Number.isFinite(Date.parse(member.pinLockedUntil))) clean.pinLockedUntil = member.pinLockedUntil;
    return clean;
  });
}

/** What a screen may show of a member: name and member ID, never email or PIN data. */
export const visibleMember = ({ memberId, firstName, lastName }) => ({ memberId, firstName, lastName });

export function createRosterCache(path) {
  let members; let numericIds = false;
  const remember = (next) => { members = next; numericIds = next.length > 0 && next.every((member) => /^\d+$/.test(member.memberId)); };
  async function load() {
    if (members) return members;
    try { remember(cleanMembers(JSON.parse(await readFile(path, "utf8"))?.members)); }
    catch (error) { if (error?.code !== "ENOENT") throw error; remember([]); }
    return members;
  }
  async function read() { return (await load()).map((member) => structuredClone(member)); }
  async function write(next) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(`${JSON.stringify({ version: 1, members: next })}\n`); await file.sync(); } finally { await file.close(); } await chmod(temporary, 0o600); await rename(temporary, path); remember(next); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  return {
    read,
    async has(memberId) { const normalized = typeof memberId === "string" ? memberId.trim() : ""; return (await load()).some((member) => member.memberId === normalized); },
    /** The member with exactly this member ID, including cached PIN data, or undefined. */
    async find(memberId) { const normalized = typeof memberId === "string" ? memberId.trim() : ""; const member = (await load()).find((item) => item.memberId === normalized); return member && structuredClone(member); },
    /** True when every cached member ID is digits only, so member ID entry can use a keypad. */
    async numericIds() { await load(); return numericIds; },
    async replace(value, options) { await write(cleanMembers(value, options)); return read(); },
    /** Drops emails or PIN data already cached when the kiosk stops searching or stops requiring a PIN. */
    async retain({ email = true, pins = true } = {}) {
      const current = await load();
      if (current.some((member) => (!email && "email" in member) || (!pins && ("pin" in member || "pinLockedUntil" in member)))) await write(cleanMembers(current, { email, pins }));
    },
  };
}
