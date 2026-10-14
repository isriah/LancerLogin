import { identityUnknownState, normalizeIdentityMethod } from "./identity-methods.mjs";

const mappedCredentialMethods = new Set(["rfid", "nfc", "qr"]);

export async function resolveIdentityObservation({ method: methodValue, input, credentials, rosterCache }) {
  const method = normalizeIdentityMethod(methodValue);
  if (method === "member_id") {
    const memberId = typeof input?.memberId === "string" ? input.memberId.trim() : "";
    if (!memberId || memberId.length > 100 || /[\u0000-\u001f\u007f]/.test(memberId)) throw new Error("Enter a valid member ID");
    return await rosterCache.has(memberId) ? { status: "identified", memberId, identityKey: `member:${memberId}` } : { status: "unknown", ...identityUnknownState(method) };
  }
  if (!mappedCredentialMethods.has(method)) throw new Error("Use the authentication method selected by the Administrator");
  const mapping = await credentials.resolve(method, input?.credential);
  return mapping && await rosterCache.has(mapping.memberId)
    ? { status: "identified", memberId: mapping.memberId, identityKey: `${method}:${mapping.id}` }
    : { status: "unknown", ...identityUnknownState(method) };
}
