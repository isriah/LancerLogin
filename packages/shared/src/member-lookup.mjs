// How a kiosk finds a member without a fingerprint: typing a member ID, or searching the roster by name, member ID or
// email. Shared by the web kiosk page and the Pi kiosk; browser-safe. Members are { memberId, firstName, lastName, email? }.
// Search results never include email, so it is never shown on a shared screen.

const fold = (value) => String(value ?? "").trim().toLowerCase();

/** True when the roster has members and every member ID is digits only, so a numeric keypad is enough. */
export function membersUseNumericIds(members) {
  return members.length > 0 && members.every((member) => /^\d+$/.test(String(member.memberId ?? "").trim()));
}

/** The member whose ID matches what was typed, ignoring case and surrounding spaces. */
export function findMemberById(members, typed) {
  const wanted = fold(typed);
  return wanted ? members.find((member) => fold(member.memberId) === wanted) : undefined;
}

const nameWords = (member) => `${member.firstName ?? ""} ${member.lastName ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function matches(member, words) {
  const names = nameWords(member); const id = fold(member.memberId); const email = fold(member.email);
  return words.every((word) => names.some((name) => name.startsWith(word)) || id.includes(word) || (email && email.startsWith(word)));
}

/** Members matching every word of the query, best first; at most limit results, without email. */
export function searchMembers(members, query, { limit = 6 } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const whole = fold(query);
  const rank = (member) => {
    if (fold(member.memberId) === whole) return 0;
    const full = `${fold(member.firstName)} ${fold(member.lastName)}`;
    if (full.startsWith(whole) || fold(member.lastName).startsWith(whole)) return 1;
    return 2;
  };
  const byName = (left, right) => fold(left.lastName).localeCompare(fold(right.lastName)) || fold(left.firstName).localeCompare(fold(right.firstName));
  return members.filter((member) => matches(member, words))
    .sort((left, right) => rank(left) - rank(right) || byName(left, right))
    .slice(0, limit)
    .map(({ memberId, firstName, lastName }) => ({ memberId, firstName, lastName }));
}
