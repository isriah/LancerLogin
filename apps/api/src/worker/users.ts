import { passwordHashFromCredential } from "../runtime-security.ts";
import { HttpError } from "../http-error.ts";
import { reloadRequired, validPasswordCredential } from "./auth.ts";
import { type Env, type Role, parseJson, requireDatabase, requireRole, response, validEmail } from "./core.ts";

export async function users(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT u.id, u.email, u.local_username AS localUsername, u.member_id AS memberId, u.role, u.active, u.created_at AS createdAt, m.external_id AS memberExternalId, m.first_name AS memberFirstName, m.last_name AS memberLastName FROM users u LEFT JOIN members m ON m.installation_id = u.installation_id AND m.id = u.member_id WHERE u.installation_id = 'primary' ORDER BY u.created_at").all(); return response({ users: result.results ?? [] }); }
  const input = await parseJson<{ email?: string | null; localUsername?: string | null; localPasswordKey?: unknown; localPassword?: unknown; role?: Role; memberId?: string | null }>(request);
  if (input.localPasswordKey === undefined && input.localPassword !== undefined) throw reloadRequired();
  const email = input.email?.trim().toLowerCase() || null; const username = input.localUsername?.trim().toLowerCase() || null;
  if (!email && !username) throw new HttpError(400, "An email or local username is required");
  if (email && !validEmail(email)) throw new HttpError(400, "Email is invalid");
  if (username && !/^[a-z0-9._-]{3,64}$/.test(username)) throw new HttpError(400, "Local username must be 3–64 letters, numbers, dots, underscores, or hyphens");
  if (!input.role || !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  // The dashboard sends a salt and K, so it enforces the 12-character minimum; the Worker can only check the format.
  if (username && !validPasswordCredential(input.localPasswordKey)) throw new HttpError(400, "A local user needs a password of at least 12 characters");
  const memberId = input.memberId?.trim() || null;
  if (memberId && !await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(memberId).first()) throw new HttpError(400, "Linked roster member was not found");
  if (memberId && await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND member_id = ?").bind(memberId).first()) throw new HttpError(409, "That roster member already has dashboard access");
  const duplicate = await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND ((email IS NOT NULL AND email = ?) OR (local_username IS NOT NULL AND local_username = ?))").bind(email, username).first();
  if (duplicate) throw new HttpError(409, "That email or username is already in use");
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const passwordHash = username ? await passwordHashFromCredential(input.localPasswordKey) ?? null : null;
  await db.batch([
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, member_id, role, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, email, username, passwordHash, memberId, input.role, now),
    db.prepare("INSERT INTO platform_module_assignment_epochs (installation_id, user_id, revision) VALUES ('primary', ?, 0)").bind(id),
    db.prepare("INSERT INTO platform_module_assignment_revisions (installation_id, user_id, revision) VALUES ('primary', ?, 0)").bind(id),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.created', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ role: input.role, hasGoogle: Boolean(email), hasLocal: Boolean(username), memberId }), now),
  ]);
  return response({ user: { id, email, localUsername: username, memberId, role: input.role, active: true, createdAt: now } }, 201);
}
export async function updateUser(request: Request, env: Env, userId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ role?: Role; active?: boolean; localPasswordKey?: unknown; localPassword?: unknown; memberId?: string | null; email?: string | null }>(request);
  if (input.localPasswordKey === undefined && input.localPassword !== undefined) throw reloadRequired();
  const target = await db.prepare("SELECT id, role, active, email, local_username AS localUsername FROM users WHERE installation_id = 'primary' AND id = ?").bind(userId).first<{ id: string; role: Role; active: number; email?: string | null; localUsername?: string }>();
  if (!target) throw new HttpError(404, "User not found");
  if (input.email !== undefined && input.email !== null && typeof input.email !== "string") throw new HttpError(400, "Email must be text or null");
  const email = input.email === undefined ? undefined : input.email?.trim().toLowerCase() || null; const emailChanged = email !== undefined && email !== (target.email ?? null);
  if (email && !validEmail(email)) throw new HttpError(400, "Email is invalid");
  if (email === null && emailChanged && !target.localUsername) throw new HttpError(400, "A user needs a Google email or a local username");
  if (email && emailChanged && await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND email = ? AND id <> ?").bind(email, userId).first()) throw new HttpError(409, "That email is already in use");
  if (userId === principal.userId && ((input.role && input.role !== "admin") || input.active === false)) throw new HttpError(409, "You cannot demote or deactivate your current Admin account");
  if (input.role && !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  // As for a new account, the 12-character minimum is enforced where the password is typed; the Worker only sees K.
  if (input.localPasswordKey !== undefined && (!target.localUsername || !validPasswordCredential(input.localPasswordKey))) throw new HttpError(400, "Password reset requires a local username and at least 12 characters");
  if (input.memberId !== undefined && input.memberId !== null && (!input.memberId.trim() || !await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(input.memberId.trim()).first())) throw new HttpError(400, "Linked roster member was not found");
  if (input.memberId && await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND member_id = ? AND id <> ?").bind(input.memberId.trim(), userId).first()) throw new HttpError(409, "That roster member already has dashboard access");
  if (input.role === undefined && input.active === undefined && input.localPasswordKey === undefined && input.memberId === undefined && input.email === undefined) throw new HttpError(400, "Provide a role, active status, roster link, Google email, or new local password");
  const passwordHash = input.localPasswordKey !== undefined ? await passwordHashFromCredential(input.localPasswordKey) ?? null : null; const now = new Date().toISOString();
  // A password reset clears any failed-login lock. A reset or deactivation bumps the session epoch, revoking existing sessions.
  const revokeSessions = passwordHash !== null || input.active === false ? 1 : 0;
  await db.batch([
    db.prepare("UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash), failed_login_count = CASE WHEN ? IS NULL THEN failed_login_count ELSE 0 END, locked_until = CASE WHEN ? IS NULL THEN locked_until ELSE NULL END, session_epoch = session_epoch + ?, member_id = CASE WHEN ? = 1 THEN ? ELSE member_id END, email = CASE WHEN ? = 1 THEN ? ELSE email END WHERE installation_id = 'primary' AND id = ?").bind(input.role ?? null, input.active === undefined ? null : input.active ? 1 : 0, passwordHash, passwordHash, passwordHash, revokeSessions, input.memberId === undefined ? 0 : 1, input.memberId?.trim() || null, emailChanged ? 1 : 0, email ?? null, userId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.updated', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, userId, JSON.stringify({ role: input.role, active: input.active, passwordReset: passwordHash !== null, memberId: input.memberId, ...(emailChanged ? { emailChanged: true, hasGoogle: Boolean(email) } : {}) }), now),
  ]);
  const user = await db.prepare("SELECT id, email, local_username AS localUsername, member_id AS memberId, role, active, created_at AS createdAt FROM users WHERE installation_id = 'primary' AND id = ?").bind(userId).first<{ id: string; email?: string | null; localUsername?: string | null; memberId?: string | null; role: Role; active: number; createdAt: string }>();
  return response({ ok: true, user: user ? { ...user, email: user.email ?? null, localUsername: user.localUsername ?? null, memberId: user.memberId ?? null, active: Boolean(user.active) } : undefined });
}
