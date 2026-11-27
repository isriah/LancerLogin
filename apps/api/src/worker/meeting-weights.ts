import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { type Env, type MeetingWeightCategory, type MeetingWeightCategoryInput, auditStatement, parseJson, requireDatabase, requireRole, response } from "./core.ts";

function validateMeetingWeightCategory(input: MeetingWeightCategoryInput, partial = false): string[] {
  const errors: string[] = [];
  if ((!partial || input.name !== undefined) && (!input.name?.trim() || input.name.trim().length > 80)) errors.push("Category name is required and must be at most 80 characters");
  if ((!partial || input.weight !== undefined) && (typeof input.weight !== "number" || !Number.isFinite(input.weight) || input.weight < 0.1 || input.weight > 100)) errors.push("Weight must be from 0.1 to 100");
  if (input.minimumDurationMinutes !== undefined && input.minimumDurationMinutes !== null && (!Number.isInteger(input.minimumDurationMinutes) || input.minimumDurationMinutes < 1 || input.minimumDurationMinutes > 10_080)) errors.push("Minimum duration must be from 1 to 10080 minutes");
  if (input.active !== undefined && typeof input.active !== "boolean") errors.push("Active must be true or false");
  return errors;
}
export async function listMeetingWeightCategories(request: Request, env: Env, includeRetired: boolean): Promise<Response> {
  await requireRole(request, env, includeRetired ? ["admin"] : ["admin", "operator"]);
  const result = await requireDatabase(env).prepare(`SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes, position, active FROM meeting_weight_categories WHERE installation_id = 'primary'${includeRetired ? "" : " AND active = 1"} ORDER BY active DESC, position, name COLLATE NOCASE`).all<MeetingWeightCategory>();
  return response({ categories: (result.results ?? []).map((category) => ({ ...category, active: Boolean(category.active) })) });
}
export async function createMeetingWeightCategory(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<MeetingWeightCategoryInput>(request); const errors = validateMeetingWeightCategory(input);
  if (errors.length) throw new HttpError(400, "Invalid meeting weight category", errors);
  const duplicate = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE").bind(input.name!.trim()).first();
  if (duplicate) throw new HttpError(409, "A meeting weight category with that name already exists");
  const last = await db.prepare("SELECT COALESCE(MAX(position), -1) AS position, COUNT(*) AS count FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1").first<{ position?: number; count?: number }>();
  if (Number(last?.count ?? 0) >= 100) throw new HttpError(409, "Retire an active meeting weight category before adding another");
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const position = Number(last?.position ?? -1) + 1;
  await db.batch([
    db.prepare("INSERT INTO meeting_weight_categories (id, installation_id, name, weight, minimum_duration_minutes, position, active, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, 1, ?, ?, ?)").bind(id, input.name!.trim(), input.weight, input.minimumDurationMinutes ?? null, position, principal.userId, now, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting_weight_category.created', 'meeting_weight_category', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ name: input.name!.trim(), weight: input.weight, minimumDurationMinutes: input.minimumDurationMinutes ?? null, position }), now),
  ]);
  return response({ category: { id, name: input.name!.trim(), weight: input.weight!, minimumDurationMinutes: input.minimumDurationMinutes ?? null, position, active: true } }, 201);
}
export async function updateMeetingWeightCategory(request: Request, env: Env, categoryId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<MeetingWeightCategoryInput>(request); const errors = validateMeetingWeightCategory(input, true);
  if (errors.length || !Object.keys(input).some((key) => ["name", "weight", "minimumDurationMinutes", "active"].includes(key))) throw new HttpError(400, "Invalid meeting weight category", errors.length ? errors : ["Provide at least one category change"]);
  const current = await db.prepare("SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes, position, active FROM meeting_weight_categories WHERE installation_id = 'primary' AND id = ?").bind(categoryId).first<MeetingWeightCategory>();
  if (!current) throw new HttpError(404, "Meeting weight category not found");
  const name = input.name?.trim() ?? current.name; const weight = input.weight ?? current.weight; const minimumDurationMinutes = input.minimumDurationMinutes === undefined ? current.minimumDurationMinutes ?? null : input.minimumDurationMinutes; const active = input.active ?? Boolean(current.active);
  const duplicate = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE AND id <> ?").bind(name, categoryId).first();
  if (duplicate) throw new HttpError(409, "A meeting weight category with that name already exists");
  const now = new Date().toISOString(); let position = current.position;
  if (active && !current.active) { const last = await db.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1").first<{ position?: number }>(); position = Number(last?.position ?? -1) + 1; }
  await db.batch([
    db.prepare("UPDATE meeting_weight_categories SET name = ?, weight = ?, minimum_duration_minutes = ?, position = ?, active = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ?").bind(name, weight, minimumDurationMinutes, position, active ? 1 : 0, now, categoryId),
    auditStatement(db, principal, active ? "meeting_weight_category.updated" : "meeting_weight_category.retired", "meeting_weight_category", categoryId, { name, weight, minimumDurationMinutes, active }),
  ]);
  return response({ category: { id: categoryId, name, weight, minimumDurationMinutes, position, active } });
}
export async function reorderMeetingWeightCategories(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ orderedIds?: string[] }>(request); const orderedIds = input.orderedIds;
  if (!Array.isArray(orderedIds) || orderedIds.length > 100 || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => typeof id !== "string" || !id)) throw new HttpError(400, "Provide each active category exactly once in the desired order");
  const current = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1 ORDER BY position, name COLLATE NOCASE").all<{ id: string }>(); const currentIds = (current.results ?? []).map((item) => item.id);
  if (currentIds.length !== orderedIds.length || currentIds.some((id) => !orderedIds.includes(id))) throw new HttpError(409, "The category list changed; refresh and try again");
  const now = new Date().toISOString(); const statements = orderedIds.map((id, position) => db.prepare("UPDATE meeting_weight_categories SET position = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(position, now, id));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting_weight_category.reordered', 'meeting_weight_category', NULL, ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ orderedIds }), now));
  await db.batch(statements); return response({ orderedIds });
}
export type MeetingWeightAssignment = { id: string; name: string; weight: number };
export type MeetingWeightCatalogEntry = MeetingWeightAssignment & { active: number; minimumDurationMinutes: number | null; position: number };
// `categories`, when given, is every category already read (CSV import reads them once for all rows) instead of a read per call.
export async function resolveMeetingWeightAssignment(db: D1Database, categoryId: string | null | undefined, startsAt: string, endsAt: string, categories?: MeetingWeightCatalogEntry[]): Promise<MeetingWeightAssignment | null> {
  if (categoryId === null) return null;
  const assignment = (category?: MeetingWeightCatalogEntry) => category ? { id: category.id, name: category.name, weight: category.weight } : null;
  if (categoryId !== undefined) {
    const category = categories ? assignment(categories.find((item) => item.id === categoryId && item.active)) : await db.prepare("SELECT id, name, weight FROM meeting_weight_categories WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(categoryId).first<MeetingWeightAssignment>();
    if (!category) throw new HttpError(400, "Choose an active meeting weight category or the default weight");
    return category;
  }
  const durationMinutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  if (categories) return assignment(categories.filter((item) => item.active && item.minimumDurationMinutes !== null && item.minimumDurationMinutes <= durationMinutes).sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, undefined, { sensitivity: "accent" }))[0]);
  return await db.prepare("SELECT id, name, weight FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1 AND minimum_duration_minutes IS NOT NULL AND minimum_duration_minutes <= ? ORDER BY position, name COLLATE NOCASE LIMIT 1").bind(durationMinutes).first<MeetingWeightAssignment>();
}
