export class EnrollmentError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function requireRosterIdentity(rosterId) {
  if (typeof rosterId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(rosterId)) throw new EnrollmentError("roster_identity_unavailable", "This member has no verified roster identity. Refresh the roster and try again.");
  return rosterId;
}
export async function verifyEnrollmentMember(memberId, fetchRoster) {
  let roster;
  try { roster = await fetchRoster(); }
  catch { throw new EnrollmentError("roster_unavailable", "Cannot verify the roster. Check the connection and retry enrollment.", 503); }
  if (!Array.isArray(roster?.members)) throw new EnrollmentError("roster_unavailable", "Cannot verify the roster. Refresh and retry enrollment.", 503);
  const matches = roster.members.filter(member => member?.memberId === memberId);
  if (matches.length !== 1 || matches[0].active === false) throw new EnrollmentError("member_unavailable", "This member is not available in the current roster. Refresh and select the member again.");
  return requireRosterIdentity(matches[0].rosterId);
}
