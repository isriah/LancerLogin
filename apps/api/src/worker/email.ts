import { moduleEmailIdempotencyKey, moduleEmailMessage, resendModuleEmailPayload } from "../module-email.ts";
import { STALE_EMAIL_DELIVERY_MINUTES } from "../stale-row-pruning.ts";
import { memberDateText } from "../member-date-text.ts";
import { evaluateAttendance } from "../attendance-policy.ts";
import { HttpError } from "../http-error.ts";
import { EmailProviderError, type Env, parseJson, readIntegrationSecret, requireDatabase, requireProviderAuthority, requireRole, resendErrorMessage, response } from "./core.ts";
import { integrationRecord } from "./integration-support.ts";
import { policyData, policyReport, policySummaryText } from "./policy-data.ts";

function html(value: unknown): string { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function resendConfiguration(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "resend"); if (!record || record.enabled === 0) throw new HttpError(503, "Resend is not enabled");
  if (!record.verifiedAt) throw new HttpError(503, "Resend verification is required before sending email");
  return readIntegrationSecret(env, "resend", record.ciphertext, record.iv);
}
export async function sendAttendanceEmail(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ kind?: "missed-meeting" | "individual-report"; memberId?: string; meetingId?: string }>(request);
  if (!input.kind || !input.memberId || (input.kind === "missed-meeting" && !input.meetingId)) throw new HttpError(400, "Email kind, member, and meeting are required");
  const member = await db.prepare("SELECT id, first_name AS firstName, last_name AS lastName, email, inactive_periods_json AS inactivePeriodsJson FROM members WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(input.memberId).first<{ id: string; firstName: string; lastName: string; email?: string; inactivePeriodsJson?: string }>();
  if (!member?.email) throw new HttpError(400, "This member does not have an email address");
  let subject: string; let content: string; let deliveryKey: string;
  if (input.kind === "missed-meeting") {
    const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string }>();
    if (!meeting) throw new HttpError(404, "Meeting not found");
    const data = await policyData(db); const target = data.meetings.find((item) => item.id === meeting.id);
    const result = target ? evaluateAttendance({ ...data, members: data.members.filter((item) => item.id === member.id), meetings: [target], now: new Date(Math.max(Date.now(), Date.parse(target.attendanceClosesAt) + 1)).toISOString() })[0] : undefined;
    if (!result?.rows.some((row) => row.meetingId === meeting.id && row.eligibility === "required" && row.disposition === "absent")) throw new HttpError(409, "This member is not currently marked absent from a required meeting in their audience");
    subject = `Missed meeting: ${meeting.title}`; content = `<p>Hello ${html(member.firstName)},</p><p>Our records show you missed <strong>${html(meeting.title)}</strong> on ${html(memberDateText(meeting.startsAt, data.timeZone))}.</p><p>Please contact your organization if this should be corrected or excused.</p>`; deliveryKey = `missed:${meeting.id}:${member.id}`;
  } else {
    const report = await policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: member.id, useBaseline: true }); const summary = report.members[0]; const meetings = new Map(report.meetings.map((item) => [item.id, item]));
    subject = "Your attendance report"; content = `<p>Hello ${html(member.firstName)},</p><p>Here is your current attendance report.</p><p>${html(policySummaryText(summary))}</p><table><thead><tr><th>Meeting</th><th>Date</th><th>Audience</th><th>Status</th><th>Eligibility</th></tr></thead><tbody>${(summary?.rows ?? []).slice(-100).map((row) => { const meeting = meetings.get(row.meetingId); return `<tr><td>${html(meeting?.title)}</td><td>${html(meeting ? memberDateText(meeting.startsAt, report.timeZone) : "")}</td><td>${html(row.audience)}</td><td>${html(row.disposition)}</td><td>${html(row.eligibility)}</td></tr>`; }).join("")}</tbody></table>`; deliveryKey = `report:${member.id}:${new Date().toISOString().slice(0, 10)}`;
  }
  const config = await resendConfiguration(env); const id = crypto.randomUUID(); const now = new Date().toISOString();
  // One statement claims the delivery key, so two sends of the same email never run at once. A new key is inserted; a key
  // whose last send failed, or stayed pending past STALE_EMAIL_DELIVERY_MINUTES (the Worker stopped mid-send), is reset to
  // pending under this attempt's id. A delivered key, or one another request is sending, changes nothing and is refused.
  const staleBefore = new Date(Date.parse(now) - STALE_EMAIL_DELIVERY_MINUTES * 60_000).toISOString();
  const claim = await db.prepare(`INSERT INTO integration_deliveries (id, installation_id, provider, delivery_key, status, created_at, updated_at) VALUES (?, 'primary', 'resend', ?, 'pending', ?, ?)
    ON CONFLICT(installation_id, provider, delivery_key) DO UPDATE SET id = excluded.id, status = 'pending', external_id = NULL, updated_at = excluded.updated_at
    WHERE integration_deliveries.status = 'failed' OR (integration_deliveries.status = 'pending' AND integration_deliveries.updated_at < ?)`).bind(id, deliveryKey, now, now, staleBefore).run();
  if (!claim.meta?.changes) throw new HttpError(409, "This email was already sent or is currently sending");
  // Records this attempt's outcome, with the reason in the audit entry; the id match leaves a newer attempt's row alone.
  const finish = (ok: boolean, details: { externalId?: string | null; status?: number; reason?: string }) => db.batch([
    db.prepare("UPDATE integration_deliveries SET status = ?, external_id = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ?").bind(ok ? "delivered" : "failed", details.externalId ?? null, new Date().toISOString(), id),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'resend.email_sent', 'member', ?, ?, ?)")
      .bind(crypto.randomUUID(), principal.userId, member.id, JSON.stringify({ kind: input.kind, ok, meetingId: input.meetingId, ...(details.status === undefined ? {} : { status: details.status }), ...(details.reason ? { reason: details.reason } : {}) }), new Date().toISOString()),
  ]);
  // Anything that stops the send after the claim marks it failed, so it never stays pending; a failure to record that is
  // left to housekeeping, which marks the row failed once it is stale.
  try { await requireProviderAuthority(env); }
  catch (error) { await finish(false, { reason: "Attendance module authority was revoked before sending" }).catch(() => undefined); throw error; }
  let delivery: Response;
  try { delivery = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", "idempotency-key": deliveryKey }, body: JSON.stringify({ from: config.fromEmail, to: [member.email], subject, html: content }) }); }
  catch (error) {
    await finish(false, { reason: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 180) || "Request to Resend failed" }).catch(() => undefined);
    throw new HttpError(502, "LancerLogin could not reach Resend. Try sending the email again.");
  }
  if (!delivery.ok) {
    const error = new EmailProviderError(delivery.status, await resendErrorMessage(delivery));
    await finish(false, { status: delivery.status, reason: error.message });
    throw error;
  }
  const deliveryBody = await delivery.json().catch(() => ({})) as { id?: string };
  await finish(true, { externalId: typeof deliveryBody.id === "string" ? deliveryBody.id : null });
  return response({ sent: true, kind: input.kind, memberId: member.id }, 202);
}

export async function resendIsReady(env: Env): Promise<boolean> {
  if (!env.INTEGRATION_KEY) return false;
  const record = await integrationRecord(env, "resend"); return Boolean(record && record.enabled !== 0 && record.verifiedAt);
}
/** One module message through the verified Resend connection; the key and From address never leave Core. */
export async function sendModuleEmail(env: Env, moduleId: string, value: unknown): Promise<{ id: string | null }> {
  const message = moduleEmailMessage(value);
  const config = await resendConfiguration(env);
  await requireProviderAuthority(env);
  const result = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", "idempotency-key": moduleEmailIdempotencyKey(moduleId, message.idempotencyKey) }, body: JSON.stringify(resendModuleEmailPayload(config.fromEmail, message)) });
  const body = await result.json().catch(() => ({})) as { id?: unknown; message?: unknown };
  if (!result.ok) throw new EmailProviderError(result.status, typeof body.message === "string" ? body.message.replace(/\s+/g, " ").slice(0, 180) : "");
  return { id: typeof body.id === "string" ? body.id : null };
}
