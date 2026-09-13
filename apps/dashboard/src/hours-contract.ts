import { addCalendarDays, instantToCivil } from '@lancerlogin/shared/civil-time';
export type Kind = 'categories' | 'teams' | 'activities';
export type Mode = 'event' | 'team' | 'task';
export type RecordItem = { id: string; revision: number; archived: boolean; name?: string; mode?: Mode; impactDefault?: boolean; number?: string; organization?: string; program?: string; historicalDescriptors?: string; categoryId?: string; teamId?: string | null; serviceDate?: string; title?: string; description?: string; location?: string; planningTimeZone?: string; startsAt?: string | null; endsAt?: string | null; impactRelevant?: boolean; responsibleStaffIds?: string[]; partnerTeamIds?: string[]; sourceMeetingId?: string | null; sourceState?: 'current' | 'changed' | 'unavailable'; sourceSnapshot?: { title: string; serviceDate: string; startsAt: string; endsAt: string | null } | null };
export type PageResult<T> = { items: T[]; nextCursor: string | null };
export const boundedText = (value: unknown, limit = 4000): value is string => typeof value === 'string' && value.length <= limit;
export const identity = (value: unknown): value is string => boundedText(value, 128) && value.length > 0;
export function pageResult<T>(value: PageResult<T>, check: (item: T) => boolean): PageResult<T> {
  if (!value || !Array.isArray(value.items) || value.items.length > 100 || !value.items.every(check) || (value.nextCursor !== null && !identity(value.nextCursor))) throw Error('Invalid page');
  return value;
}
export function recordItem(value: RecordItem, kind: Kind, detail = false): RecordItem {
  if (!value || !identity(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.archived !== 'boolean') throw Error('Invalid record');
  if (kind === 'categories' && (!boundedText(value.name, 100) || !['event', 'team', 'task'].includes(value.mode ?? '') || typeof value.impactDefault !== 'boolean')) throw Error('Invalid category');
  if (kind === 'teams' && (!boundedText(value.name, 150) || !boundedText(value.number, 32) || !boundedText(value.organization, 200) || !boundedText(value.program, 100) || !boundedText(value.historicalDescriptors))) throw Error('Invalid team');
  if (kind === 'activities') {
    if (!identity(value.categoryId) || !boundedText(value.title, 150) || !boundedText(value.serviceDate, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate) || !['event', 'team', 'task'].includes(value.mode ?? '') || !boundedText(value.description) || !boundedText(value.location, 300) || !boundedText(value.planningTimeZone, 100) || typeof value.impactRelevant !== 'boolean' || ![value.startsAt, value.endsAt].every(time => time === null || (boundedText(time, 40) && Number.isFinite(Date.parse(time))))) throw Error('Invalid activity');
    if ((value.mode === 'team' && !identity(value.teamId)) || (value.mode !== 'team' && value.teamId !== null) || (value.startsAt === null) !== (value.endsAt === null)) throw Error('Invalid activity planning identity');
    if (detail && value.sourceMeetingId && (!identity(value.sourceMeetingId) || !['current','changed','unavailable'].includes(value.sourceState ?? '') || !value.sourceSnapshot || !boundedText(value.sourceSnapshot.title,150) || !boundedText(value.sourceSnapshot.serviceDate,10))) throw Error('Invalid source snapshot');
    addCalendarDays(value.serviceDate!, 0); instantToCivil(Date.now(), value.planningTimeZone!); for (const time of [value.startsAt, value.endsAt]) if (time) instantToCivil(Date.parse(time), value.planningTimeZone!);
    if (detail && (![value.responsibleStaffIds, value.partnerTeamIds].every(ids => Array.isArray(ids) && ids.every(identity) && new Set(ids).size === ids.length) || value.responsibleStaffIds!.length > 10 || value.partnerTeamIds!.length > 20)) throw Error('Invalid activity links');
  }
  return value;
}
