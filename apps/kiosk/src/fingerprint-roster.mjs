import { normalizeApiUrl } from "./cloud-client.mjs";

// Conditional responses still require a current authorized cloud request. Never
// reuse a roster after a failed revalidation, or extend a shared snapshot's age.
export function createFingerprintRosterReader(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const endpoint = `${normalizeApiUrl(config.apiUrl)}/kiosk/roster`;
  const authorization = `Bearer ${config.kioskToken}`;
  let etag, members, pending;
  async function fetchCurrent() {
    try {
      const response = await fetchImpl(endpoint, { redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { authorization, ...(etag ? { "if-none-match": etag } : {}) } });
      if (response.status === 304) {
        if (!members || !etag || response.headers.get("etag") !== etag) throw new Error("Roster revalidation was not confirmed");
      } else {
        if (!response.ok) throw new Error("Current roster is unavailable");
        const result = await response.json();
        if (!Array.isArray(result?.members) || result.members.length > 10000 || result.members.some(member => typeof member?.memberId !== "string" || !member.memberId || member.memberId.length > 100 || member.memberId !== member.memberId.trim() || /[\u0000-\u001f\u007f]/.test(member.memberId) || typeof member.rosterId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(member.rosterId)) || new Set(result.members.map(member => member.memberId)).size !== result.members.length || new Set(result.members.map(member => member.rosterId)).size !== result.members.length) throw new Error("Current roster is invalid");
        members = structuredClone(result.members);
        const next = response.headers.get("etag");
        etag = /^"kiosk-roster-v1-\d+"$/.test(next ?? "") ? next : undefined;
      }
      return { members: structuredClone(members), freshUntil: now() + 60000 };
    } catch {
      members = undefined; etag = undefined;
      throw new Error("Current roster could not be verified");
    }
  }
  return {
    async read() { pending ??= fetchCurrent(); return structuredClone(await pending); },
    endRound() { pending = undefined; },
  };
}
