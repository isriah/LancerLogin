import { instantToCivil } from '@lancerlogin/shared/civil-time';
import { HttpError } from './http-error.ts';
import type { ModuleDatabase } from './platform-modules.ts';

// Called only after hoursCatalogRoute checks current hours.manage capability.
export async function hoursSelector(db: ModuleDatabase, installation: string, url: URL, method: string): Promise<unknown | undefined> {
  const staff = url.pathname === '/admin/hours/responsible-staff';
  if (!staff && url.pathname !== '/admin/hours/attendance-sources') return undefined;
  if (method !== 'GET') throw new HttpError(405, 'Planning selectors support GET only');
  const allowed = staff ? ['limit', 'after', 'activityId'] : ['limit', 'after', 'from', 'to'];
  url.searchParams.forEach((_, key) => { if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, 'Invalid planning selector filter'); });
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const after = url.searchParams.get('after') ?? '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || after.length > 128) throw new HttpError(400, 'Invalid planning selector page');
  if (staff) {
    const activity = url.searchParams.get('activityId');
    if (activity !== null && (!activity || activity.length > 128)) throw new HttpError(400, 'Invalid activity context');
    if (activity && !await db.prepare('SELECT id FROM hours_activities WHERE installation_id=? AND id=?').bind(installation, activity).first()) throw new HttpError(404, 'Activity context is unavailable');
    const rows = (await db.prepare(`SELECT u.id,u.active,u.local_username,m.first_name,m.last_name,
      EXISTS(SELECT 1 FROM hours_activity_staff s WHERE s.installation_id=u.installation_id AND s.user_id=u.id AND s.activity_id=?) AS linked
      FROM users u LEFT JOIN members m ON m.installation_id=u.installation_id AND m.id=u.member_id
      WHERE u.installation_id=? AND u.id>? AND (u.active=1 OR EXISTS(SELECT 1 FROM hours_activity_staff s WHERE s.installation_id=u.installation_id AND s.user_id=u.id AND s.activity_id=?))
      ORDER BY u.id LIMIT ?`).bind(activity, installation, after, activity, limit + 1).all<{id:string;active:number;local_username:string|null;first_name:string|null;last_name:string|null;linked:number}>()).results ?? [];
    return { items: rows.slice(0, limit).map(row => {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      const username = row.local_username && /^[a-z0-9._-]{3,64}$/i.test(row.local_username) ? row.local_username : '';
      const label = (name || username).slice(0, 256);
      return { id: row.id, label: label || (row.linked ? 'Previously linked account — display identity unavailable' : 'Account needs a roster link or local username'), active: Boolean(row.active), selectable: Boolean(row.active && label), linked: Boolean(row.linked) };
    }), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  const instant = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  if ((from !== null && !instant(from)) || (to !== null && !instant(to)) || (from && to && Date.parse(from) >= Date.parse(to))) throw new HttpError(400, 'Provide a valid UTC planning range');
  const settings = await db.prepare('SELECT time_zone FROM organization_settings WHERE installation_id=?').bind(installation).first<{time_zone:string}>();
  const timeZone = settings?.time_zone ?? 'UTC';
  const clauses = ['installation_id=?', 'id>?', 'deleted_at IS NULL', 'is_test=0']; const values: unknown[] = [installation, after];
  if (from) { clauses.push('julianday(starts_at)>=julianday(?)'); values.push(from); }
  if (to) { clauses.push('julianday(starts_at)<julianday(?)'); values.push(to); }
  const rows = (await db.prepare(`SELECT id,title,starts_at AS startsAt,ends_at AS endsAt FROM meetings WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).bind(...values, limit + 1).all<{id:string;title:string;startsAt:string;endsAt:string|null}>()).results ?? [];
  const items = rows.slice(0, limit).map(row => {
    try { return { id: row.id, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, serviceDate: instantToCivil(Date.parse(row.startsAt), timeZone).date }; }
    catch { throw new HttpError(409, 'Attendance planning date or organization time zone needs repair'); }
  });
  return { items, nextCursor: rows.length > limit ? rows[limit - 1].id : null, timeZone };
}
