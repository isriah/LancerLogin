export type LookupMember = { memberId: string; firstName: string; lastName: string; email?: string };
export type MemberSearchResult = { memberId: string; firstName: string; lastName: string };
export function membersUseNumericIds(members: readonly LookupMember[]): boolean;
export function findMemberById<T extends LookupMember>(members: readonly T[], typed: string): T | undefined;
export function searchMembers(members: readonly LookupMember[], query: string, options?: { limit?: number }): MemberSearchResult[];
