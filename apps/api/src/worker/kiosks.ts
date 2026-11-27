import { readUpdateChannel } from "../update-channel.ts";
import { readPinLockout, rosterPins } from "../member-pins.ts";
import { discordCodeBackups, normalizeDiscordCodeBackup, type DiscordCodeBackup } from "../discord-kiosk-codes.ts";
import { kioskHonoursRequirePin, kioskReleaseTransition, requirePinFirstKioskRelease } from "../../../../packages/shared/src/release-policy.mjs";
import { formatPairingCode, generateWebPairingCode, normalizePairingCode, validWebPairingCode } from "../../../../packages/shared/src/pairing-code.mjs";
import { databaseIdentity, type D1Database } from "../d1-usage.ts";
import { ReportDataCache } from "../report-data-cache.ts";
import { HttpError } from "../http-error.ts";
import { storageDiagnosticsColumn, storedStorageDiagnostics } from "../kiosk-storage-diagnostics.ts";
import { fingerprintMinimumScore } from "../fingerprint-match.ts";
import { recordFingerprintReenrolled, reenrollThreshold } from "../scan-integrity.ts";
import { readKioskEnrollment, startKioskEnrollment, selectEnrollmentMember, cancelKioskEnrollment, progressKioskEnrollment } from "../kiosk-enrollment.ts";
import { type Env, KIOSK_REPLACEABLE_AFTER_MS, type KioskAuthenticationMethod, type KioskCommandType, type KioskKind, type KioskMemberLookup, type Principal, type WorkerContext, isObject, kioskAuthenticationMethods, kioskKinds, kioskMemberLookups, latestCompatibleKioskRelease, parseJson, randomToken, requireDatabase, requireRole, response, sha256, validTimestamp, writeAudit } from "./core.ts";
import { pokeScheduler, schedulerJobsFor } from "./delivery.ts";
import { kioskStatusLineChanged } from "./discord-kiosk-status.ts";

export async function pairingCodes(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const active = await db.prepare("SELECT id, expires_at AS expiresAt FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(new Date().toISOString()).first(); return response({ active }); }
  const input = await parseJson<{ kioskName?: string; purpose?: "hardware"; kind?: KioskKind; replaceKioskId?: string }>(request); const kioskName = input.kioskName?.trim(); const purpose = input.purpose ?? "hardware"; const kind = input.kind ?? "pi";
  if (!kioskName || kioskName.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
  // The browser simulator is gone (migration 0092), so every code pairs a real kiosk.
  if (purpose !== "hardware") throw new HttpError(400, "Pairing purpose must be hardware");
  if (!kioskKinds.has(kind)) throw new HttpError(400, "Kiosk kind must be pi or web");
  if (input.replaceKioskId !== undefined && (typeof input.replaceKioskId !== "string" || !input.replaceKioskId)) throw new HttpError(400, "Choose the kiosk to retire and replace");
  const now = new Date(); const silentBefore = new Date(now.getTime() - KIOSK_REPLACEABLE_AFTER_MS).toISOString(); let replaced: { id: string; name: string } | undefined;
  if (purpose === "hardware") {
    const duplicate = await db.prepare("SELECT id, name, last_seen_at AS lastSeenAt FROM kiosks WHERE installation_id = 'primary' AND active = 1 AND lower(name) = lower(?) LIMIT 1").bind(kioskName).first<{ id: string; name: string; lastSeenAt?: string | null }>();
    // Only a kiosk that stopped checking in can be retired and replaced under its name.
    const replaceable = Boolean(duplicate) && !(duplicate?.lastSeenAt && duplicate.lastSeenAt >= silentBefore);
    if (input.replaceKioskId !== undefined) {
      if (!duplicate || duplicate.id !== input.replaceKioskId || !replaceable) throw new HttpError(409, "Only an active kiosk with this name that has not checked in for 10 minutes can be retired and replaced.", undefined, "kiosk_not_replaceable");
      replaced = { id: duplicate.id, name: duplicate.name };
    } else if (duplicate) throw new HttpError(409, "An active kiosk already uses that name. Choose a distinct device name.", undefined, "kiosk_name_in_use", replaceable ? { replaceableKioskId: duplicate.id } : undefined);
  }
  const code = kind === "web" ? generateWebPairingCode((count) => crypto.getRandomValues(new Uint8Array(count))) : randomToken(9).slice(0, 12).toUpperCase(); const id = crypto.randomUUID(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  // A replacement retires the old kiosk in the same batch; if it checked in meanwhile, nothing is written.
  const unlessStillActive = "(? IS NULL OR NOT EXISTS (SELECT 1 FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1))"; const replacedId = replaced?.id ?? null;
  const results = await db.batch([
    ...(replaced ? retireKioskStatements(db, principal, replaced, "kiosk.replaced", { silentBefore, metadata: { pairingCodeId: id } }) : []),
    db.prepare(`DELETE FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND purpose = ? AND kiosk_kind = ? AND ${unlessStillActive}`).bind(purpose, kind, replacedId, replacedId),
    db.prepare(`INSERT INTO pairing_codes (id, installation_id, code_hash, expires_at, created_by, created_at, purpose, kiosk_kind, kiosk_name) SELECT ?, 'primary', ?, ?, ?, ?, ?, ?, ? WHERE ${unlessStillActive}`).bind(id, await sha256(code), expiresAt, principal.userId, now.toISOString(), purpose, kind, kind === "web" ? kioskName : null, replacedId, replacedId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'pairing_code.created', 'pairing_code', ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ kioskName, purpose, kind, ...(replaced ? { replacedKioskId: replaced.id } : {}) }), now.toISOString(), id),
  ]);
  if ((results[replaced ? 3 : 1]?.meta?.changes ?? 1) < 1) throw new HttpError(409, "That kiosk checked in again, so it was not replaced.", undefined, "kiosk_not_replaceable");
  return response({ code, expiresAt, kioskName, kind, ...(kind === "web" ? { displayCode: formatPairingCode(code) } : { workerApiUrl: new URL(request.url).origin }) }, 201);
}
// A Pi sends { code, kioskName }; a web kiosk sends only { code } and takes the name the Admin gave its code.
// A Pi from 2.1.0-beta.10 on also states its releaseVersion, stored as a heartbeat would store it, so the kiosk's release
// is known from the moment it pairs (Require PIN is refused for a Pi kiosk whose release is unknown). A Pi that sends
// none, or one a heartbeat would refuse, pairs as before and reports its release with its first heartbeat.
export async function redeemPairingCode(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); const input = await parseJson<{ code?: string; kioskName?: string; releaseVersion?: unknown }>(request); const kind: KioskKind = input.kioskName === undefined || input.kioskName === null ? "web" : "pi";
  const code = kind === "web" ? normalizePairingCode(input.code) : typeof input.code === "string" ? input.code.trim().toUpperCase() : ""; const piName = kind === "pi" && typeof input.kioskName === "string" ? input.kioskName.trim() : "";
  if (!code || kind === "pi" && (!piName || piName.length > 80)) throw new HttpError(400, "Pairing code and kiosk name are required");
  if (kind === "web" && !validWebPairingCode(code)) throw new HttpError(401, "Pairing code is invalid or expired");
  const now = new Date().toISOString(); const pairing = await db.prepare("SELECT id, kiosk_name AS kioskName FROM pairing_codes WHERE installation_id = 'primary' AND purpose = 'hardware' AND kiosk_kind = ? AND code_hash = ? AND redeemed_at IS NULL AND expires_at > ?").bind(kind, await sha256(code), now).first<{ id: string; kioskName?: string | null }>();
  const kioskName = kind === "web" ? pairing?.kioskName?.trim() : piName;
  if (!pairing || !kioskName) throw new HttpError(401, "Pairing code is invalid or expired");
  const kioskId = crypto.randomUUID(); const kioskToken = randomToken();
  const statedRelease = typeof input.releaseVersion === "string" && input.releaseVersion.trim() && input.releaseVersion.length <= 40 ? input.releaseVersion.trim() : null;
  // A web kiosk starts on member ID entry; an Admin can switch it to member search on Manage kiosk.
  const results = await db.batch([
    db.prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND expires_at > ? AND NOT EXISTS (SELECT 1 FROM kiosks WHERE installation_id = 'primary' AND active = 1 AND lower(name) = lower(?))").bind(now, pairing.id, now, kioskName),
    kind === "web"
      ? db.prepare("INSERT INTO kiosks (id, installation_id, pairing_code_id, name, token_hash, created_at, pairing_bound, kind, configured_authentication_method, authentication_method, member_lookup) SELECT ?, 'primary', ?, ?, ?, ?, 1, 'web', 'member_id', 'member_id', 'entry' WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?) AND NOT EXISTS (SELECT 1 FROM kiosks WHERE installation_id = 'primary' AND pairing_code_id = ?)").bind(kioskId, pairing.id, kioskName, await sha256(kioskToken), now, pairing.id, now, pairing.id)
      : db.prepare("INSERT INTO kiosks (id, installation_id, pairing_code_id, name, token_hash, created_at, release_version, pairing_bound) SELECT ?, 'primary', ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?) AND NOT EXISTS (SELECT 1 FROM kiosks WHERE installation_id = 'primary' AND pairing_code_id = ?)").bind(kioskId, pairing.id, kioskName, await sha256(kioskToken), now, statedRelease, pairing.id, now, pairing.id),
    db.prepare("INSERT INTO audit_log (id, installation_id, action, target_type, target_id, created_at) SELECT ?, 'primary', 'kiosk.paired', 'kiosk', ?, ? WHERE EXISTS (SELECT 1 FROM kiosks WHERE id = ?)").bind(crypto.randomUUID(), kioskId, now, kioskId),
  ]);
  if ((results[1]?.meta?.changes ?? 1) < 1) throw new HttpError(409, "Pairing code was already used or that kiosk name is already active");
  return response({ kioskId, kioskToken, pairingId: pairing.id, name: kioskName, kind }, 201);
}
// Retiring revokes the kiosk's credential at once (kioskFor reads only active kiosks) and keeps its attendance history.
// With silentBefore, only a kiosk that has not checked in since then is retired, and the audit row follows the retirement.
function retireKioskStatements(db: D1Database, principal: Principal, kiosk: { id: string; name: string }, action: "kiosk.retired" | "kiosk.replaced", options: { silentBefore?: string; metadata?: Record<string, unknown> } = {}) {
  return [
    options.silentBefore
      ? db.prepare("UPDATE kiosks SET active = 0 WHERE installation_id = 'primary' AND id = ? AND active = 1 AND (last_seen_at IS NULL OR last_seen_at < ?)").bind(kiosk.id, options.silentBefore)
      : db.prepare("UPDATE kiosks SET active = 0 WHERE installation_id = 'primary' AND id = ?").bind(kiosk.id),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, ?, 'kiosk', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1)").bind(crypto.randomUUID(), principal.userId, action, kiosk.id, JSON.stringify({ name: kiosk.name, ...options.metadata }), new Date().toISOString(), kiosk.id),
  ];
}
export type PairedKiosk = { id: string; name: string; pairingId: string; pairingBound: boolean; configuredAuthenticationMethod: KioskAuthenticationMethod; kioskKind: KioskKind; memberLookup: KioskMemberLookup; requirePin: boolean; discordCode: boolean; discordCodeBackup: DiscordCodeBackup; discordCodeFailures: number; discordCodeThrottleUntil: string | null; rosterRevision?: number;
  /** What the kiosk's row said before this request: the inputs of its line in the Discord kiosk status message. */
  lastSeenAt?: string | null; readerOnline?: number | null; releaseVersion?: string | null };
export async function kioskFor(request: Request, env: Env, includeRosterRevision = false): Promise<PairedKiosk> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Kiosk authentication required");
  const kiosk = await requireDatabase(env).prepare(`SELECT id, name, pairing_code_id AS pairingId, pairing_bound AS pairingBound, configured_authentication_method AS configuredAuthenticationMethod, kind AS kioskKind, member_lookup AS memberLookup, require_pin AS requirePin, discord_code AS discordCode, discord_code_backup AS discordCodeBackup, discord_code_failures AS discordCodeFailures, discord_code_throttle_until AS discordCodeThrottleUntil, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion${includeRosterRevision ? ", (SELECT revision FROM kiosk_roster_revision WHERE installation_id = 'primary') AS rosterRevision" : ""} FROM kiosks WHERE installation_id = 'primary' AND token_hash = ? AND active = 1`).bind(await sha256(authorization.slice(7))).first<Omit<PairedKiosk, "pairingBound" | "kioskKind" | "memberLookup" | "requirePin" | "discordCode" | "discordCodeBackup" | "discordCodeFailures" | "discordCodeThrottleUntil"> & { pairingBound: number; kioskKind?: KioskKind; memberLookup?: KioskMemberLookup; requirePin?: number; discordCode?: number; discordCodeBackup?: string; discordCodeFailures?: number; discordCodeThrottleUntil?: string | null }>();
  if (!kiosk) throw new HttpError(401, "Kiosk credential is invalid");
  // Require PIN and Discord codes apply only with the member ID method; the method PATCH keeps them together, and this
  // guards older rows.
  const memberIdMethod = kiosk.configuredAuthenticationMethod === "member_id";
  return { ...kiosk, pairingBound: Boolean(kiosk.pairingBound), kioskKind: kiosk.kioskKind === "web" ? "web" : "pi", memberLookup: kiosk.memberLookup === "search" ? "search" : "entry", requirePin: Number(kiosk.requirePin) === 1 && memberIdMethod, discordCode: Number(kiosk.discordCode) === 1 && memberIdMethod, discordCodeBackup: normalizeDiscordCodeBackup(kiosk.discordCodeBackup), discordCodeFailures: Number(kiosk.discordCodeFailures ?? 0), discordCodeThrottleUntil: typeof kiosk.discordCodeThrottleUntil === "string" ? kiosk.discordCodeThrottleUntil : null };
}
type KioskAttention = { scansNeedReview: number; clockConfirmed: boolean; clockPendingScans: number; reviewSyncFailing: boolean; weakMatches?: number; readerTemplates?: number; linkedTemplates?: number };
// The causes behind a kiosk's error category, plus fingerprint matches below the minimum score that it asked to
// rescan since it started. Optional: kiosks before 2.0.0-beta.14 do not send it.
function kioskAttention(value: unknown): KioskAttention | undefined {
  if (value === undefined || value === null) return undefined;
  const input = value as Record<string, unknown>; const count = (item: unknown) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 100_000;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(input).some(key => !["scansNeedReview", "clockConfirmed", "clockPendingScans", "reviewSyncFailing", "weakMatches", "readerTemplates", "linkedTemplates"].includes(key))
    || !count(input.scansNeedReview) || typeof input.clockConfirmed !== "boolean" || !count(input.clockPendingScans) || typeof input.reviewSyncFailing !== "boolean"
    || input.weakMatches !== undefined && !count(input.weakMatches)
    || (input.readerTemplates === undefined) !== (input.linkedTemplates === undefined) || input.readerTemplates !== undefined && (!count(input.readerTemplates) || Number(input.readerTemplates) > 1024 || !count(input.linkedTemplates) || Number(input.linkedTemplates) > 1024)) throw new HttpError(400, "Invalid kiosk attention details");
  return { scansNeedReview: Number(input.scansNeedReview), clockConfirmed: input.clockConfirmed, clockPendingScans: Number(input.clockPendingScans), reviewSyncFailing: input.reviewSyncFailing,
    ...(input.weakMatches === undefined ? {} : { weakMatches: Number(input.weakMatches) }),
    ...(input.readerTemplates === undefined ? {} : { readerTemplates: Number(input.readerTemplates), linkedTemplates: Number(input.linkedTemplates) }) };
}
// Rejected scans never make a kiosk degraded: they upload and are reviewed in the background from Debug tools. Kiosks
// from 2.0.0-beta.14 still raise a category for unreviewed rejected scans or a failed review upload, so the category is
// derived from the reported causes instead. Attendance scans that cannot upload (an unconfirmed clock, or scans still
// waiting) keep it, as does a reader fault. Older kiosks report no causes and keep the category they send.
function kioskErrorCategory(reported: "cloud_sync" | "reader" | "offline_queue" | null | undefined, attention: KioskAttention | undefined, pendingEvents: number) {
  if (!reported || !attention || reported === "reader") return reported || null;
  return !attention.clockConfirmed || attention.clockPendingScans ? "offline_queue" : pendingEvents ? "cloud_sync" : null;
}
export async function kioskHeartbeat(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ readerOnline?: boolean; authenticationMethod?: KioskAuthenticationMethod; releaseVersion?: string; updatePolicyVersion?: number; uptimeSeconds?: number; networkType?: "wifi" | "ethernet" | "offline"; networkSignal?: number | null; lastWifiScanAt?: string | null; pendingEvents?: number; lastSyncAt?: string | null; errorCategory?: "cloud_sync" | "reader" | "offline_queue" | null; attention?: unknown; storage?: unknown }>(request);
  const attention = kioskAttention(input.attention);
  if (input.updatePolicyVersion !== undefined && ![1, 2].includes(input.updatePolicyVersion)) throw new HttpError(400, "Unsupported kiosk update policy");
  const pendingEvents = input.pendingEvents ?? 0;
  if (typeof input.readerOnline !== "boolean" || input.authenticationMethod !== undefined && !kioskAuthenticationMethods.has(input.authenticationMethod) || !input.releaseVersion?.trim() || input.releaseVersion.length > 40 || input.uptimeSeconds !== undefined && (!Number.isInteger(input.uptimeSeconds) || input.uptimeSeconds < 0 || input.uptimeSeconds > 2_147_483_647) || input.networkType !== undefined && !["wifi", "ethernet", "offline"].includes(input.networkType) || input.networkSignal !== undefined && input.networkSignal !== null && (!Number.isInteger(input.networkSignal) || input.networkSignal < 0 || input.networkSignal > 100) || input.lastWifiScanAt && !validTimestamp(input.lastWifiScanAt) || !Number.isInteger(pendingEvents) || pendingEvents < 0 || pendingEvents > 100_000 || input.lastSyncAt && !validTimestamp(input.lastSyncAt) || input.errorCategory && !["cloud_sync", "reader", "offline_queue"].includes(input.errorCategory)) throw new HttpError(400, "Authentication input status and approved operational diagnostics are required");
  const now = new Date().toISOString();
  const db = requireDatabase(env); const reportedRelease = input.releaseVersion.trim();
  const errorCategory = kioskErrorCategory(input.errorCategory, attention, pendingEvents);
  await db.prepare("UPDATE kiosks SET update_policy_version = ? WHERE installation_id = 'primary' AND id = ?").bind(input.updatePolicyVersion ?? 1, kiosk.id).run();
  await db.prepare("UPDATE kiosks SET last_seen_at = ?, reader_online = ?, authentication_method = COALESCE(?, authentication_method), release_version = ?, uptime_seconds = ?, network_type = ?, network_signal = ?, last_wifi_scan_at = COALESCE(?, last_wifi_scan_at), pending_events = ?, last_sync_at = ?, error_category = ?, scans_need_review = ?, clock_confirmed = ?, clock_pending_scans = ?, review_sync_failing = ?, weak_matches = ?, reader_templates = ?, linked_templates = ?, storage_diagnostics = ? WHERE installation_id = 'primary' AND id = ?").bind(now, input.readerOnline ? 1 : 0, input.authenticationMethod ?? null, reportedRelease, input.uptimeSeconds ?? null, input.networkType ?? null, input.networkSignal ?? null, input.lastWifiScanAt || null, pendingEvents, input.lastSyncAt || null, errorCategory, attention?.scansNeedReview ?? null, attention ? Number(attention.clockConfirmed) : null, attention?.clockPendingScans ?? null, attention ? Number(attention.reviewSyncFailing) : null, attention?.weakMatches ?? null, attention?.readerTemplates ?? null, attention?.linkedTemplates ?? null, storageDiagnosticsColumn(input.storage), kiosk.id).run();
  // A kiosk holding unreviewed rejected scans learns how many are still open in the cloud, so a dashboard review
  // reaches it on its next heartbeat instead of its hourly refresh. Kiosks with nothing to review cost no read.
  const openScanReviews = attention?.scansNeedReview ? (await db.prepare("SELECT COUNT(*) AS count FROM kiosk_scan_reviews WHERE installation_id = 'primary' AND review_status = 'open' AND kiosk_id = ?").bind(kiosk.id).first<{ count: number }>())?.count ?? 0 : undefined;
  const update = await db.prepare("SELECT id, completed_at AS completedAt, requested_release_version AS requestedReleaseVersion, release_version_before AS releaseVersionBefore FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? AND command_type = 'install_latest' AND completed_at IS NOT NULL AND success = 1 AND resolution_status IS NULL ORDER BY created_at DESC LIMIT 1").bind(kiosk.id).first<{ id: string; completedAt: string; requestedReleaseVersion?: string; releaseVersionBefore?: string }>();
  if (update?.requestedReleaseVersion) {
    const normalizedReported = reportedRelease.replace(/^v/, ""); const normalizedRequested = update.requestedReleaseVersion.replace(/^v/, ""); const normalizedBefore = update.releaseVersionBefore?.replace(/^v/, "");
    const elapsed = Date.now() - Date.parse(update.completedAt); let resolution: "succeeded" | "unchanged" | "mismatch" | undefined;
    if (normalizedReported === normalizedRequested) resolution = "succeeded";
    else if (normalizedBefore && normalizedReported !== normalizedBefore) resolution = "mismatch";
    else if (elapsed >= 5 * 60_000) resolution = normalizedBefore === normalizedReported ? "unchanged" : "mismatch";
    if (resolution) await db.prepare("UPDATE kiosk_commands SET resolution_status = ?, resolved_release_version = ?, resolved_at = ? WHERE installation_id = 'primary' AND kiosk_id = ? AND id = ? AND resolution_status IS NULL").bind(resolution, reportedRelease, now, kiosk.id, update.id).run();
  }
  // The Discord kiosk status message is the channel job's work, not the heartbeat's: a heartbeat reads and writes nothing
  // for it. When this heartbeat changes what the message shows for this kiosk (it came back online, or its reader or
  // release changed), the job is poked so the message follows within seconds; otherwise the job's own five-minute run
  // keeps it current, which is also what notices a kiosk going silent.
  if (kioskStatusLineChanged(kiosk, { readerOnline: input.readerOnline, releaseVersion: reportedRelease }, Date.parse(now))) pokeScheduler(env, context, schedulerJobsFor.channel);
  return response({ ok: true, kioskId: kiosk.id, receivedAt: now, ...(openScanReviews === undefined ? {} : { openScanReviews }) });
}
export async function kioskStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]);
  const db = requireDatabase(env);
  const result = await db.prepare("SELECT id, name, active, last_seen_at AS lastSeenAt, reader_online AS readerOnline, authentication_method AS authenticationMethod, configured_authentication_method AS configuredAuthenticationMethod, release_version AS releaseVersion, update_policy_version AS updatePolicyVersion, uptime_seconds AS uptimeSeconds, network_type AS networkType, network_signal AS networkSignal, last_wifi_scan_at AS lastWifiScanAt, pending_events AS pendingEvents, last_sync_at AS lastSyncAt, error_category AS errorCategory, scans_need_review AS scansNeedReview, clock_confirmed AS clockConfirmed, clock_pending_scans AS clockPendingScans, review_sync_failing AS reviewSyncFailing, weak_matches AS weakMatches, reader_templates AS readerTemplates, linked_templates AS linkedTemplates, storage_diagnostics AS storageDiagnostics, kind, member_lookup AS memberLookup, require_pin AS requirePin, discord_code AS discordCode, discord_code_backup AS discordCodeBackup, created_at AS pairedAt FROM kiosks WHERE installation_id = 'primary' ORDER BY created_at DESC").all<Record<string, unknown>>();
  return response({ kiosks: (result.results ?? []).map((kiosk) => ({ ...kiosk, storageDiagnostics: storedStorageDiagnostics(kiosk.storageDiagnostics), requirePin: Number(kiosk.requirePin) === 1, discordCode: Number(kiosk.discordCode) === 1 && kiosk.configuredAuthenticationMethod === "member_id", discordCodeBackup: normalizeDiscordCodeBackup(kiosk.discordCodeBackup) })) });
}
export async function kioskConfiguration(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const db = requireDatabase(env); const [settings, pinLockout] = await Promise.all([db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, logo_backdrop AS logoBackdrop FROM organization_settings WHERE installation_id = 'primary'").first(), readPinLockout(db)]);
  return response({ kiosk: { id: kiosk.id, name: kiosk.name }, settings: settings ? { ...settings, authenticationMethod: kiosk.configuredAuthenticationMethod, kind: kiosk.kioskKind, memberLookup: kiosk.memberLookup, requirePin: kiosk.requirePin, discordCode: kiosk.discordCode, discordCodeBackup: kiosk.discordCodeBackup, pinLockout, ...await fingerprintMinimumScore(requireDatabase(env)).catch(() => 0).then(minimumScore => ({ fingerprintMinimumScore: minimumScore, fingerprintReenrollScore: reenrollThreshold(minimumScore) })) } : null });
}
type KioskRosterMember = { rosterId: string; memberId: string; firstName: string; lastName: string; email?: string | null };
const kioskRosterCache = new ReportDataCache<KioskRosterMember[]>();
export async function kioskRoster(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env, true);
  const db = requireDatabase(env);
  // Member search matches on email (never shown), so only a kiosk set to search receives it. Its ETag differs, so
  // switching the lookup always refetches.
  const search = kiosk.configuredAuthenticationMethod === "member_id" && kiosk.memberLookup === "search";
  // PIN hashes go only to a kiosk that requires a PIN, under their own ETag. A PIN set, reset, lock or unlock changes the
  // roster revision (migration 0091's triggers), so a cached roster never keeps a stale hash or lock.
  const pins = kiosk.requirePin;
  const etag = typeof kiosk.rosterRevision === "number" && Number.isSafeInteger(kiosk.rosterRevision) && kiosk.rosterRevision >= 0 ? `"kiosk-roster-v1-${search ? "search-" : ""}${pins ? "pin-" : ""}${kiosk.rosterRevision}"` : undefined;
  if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  let initial = true;
  const members = await kioskRosterCache.read(databaseIdentity(db), "active-roster", async () => {
    if (initial) { initial = false; return kiosk.rosterRevision; }
    const current = await db.prepare("SELECT revision FROM kiosk_roster_revision WHERE installation_id = 'primary'").first<{ revision: number }>();
    return current && Number.isSafeInteger(current.revision) ? current.revision : undefined;
  }, async () => (await db.prepare("SELECT id AS rosterId, external_id AS memberId, first_name AS firstName, last_name AS lastName, email FROM members WHERE installation_id = 'primary' AND active = 1 ORDER BY last_name, first_name").all<KioskRosterMember>()).results ?? []);
  const pinData = pins ? await rosterPins(db) : undefined;
  const reply = response({ members: members.map(({ email, ...member }) => {
    const listed = search && email ? { ...member, email } : member;
    if (!pinData) return listed;
    const pin = pinData.get(member.rosterId);
    return { ...listed, pin: pin?.pin ?? null, pinLockedUntil: pin?.lockedUntil ?? null };
  }) });
  if (etag) reply.headers.set("etag", etag);
  return reply;
}
export async function manageKiosk(request: Request, env: Env, kioskId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const kiosk = await db.prepare("SELECT id, name, active FROM kiosks WHERE installation_id = 'primary' AND id = ?").bind(kioskId).first<{ id: string; name: string; active: number }>();
  if (!kiosk) throw new HttpError(404, "Kiosk not found");
  if (request.method === "PATCH") {
    const input = await parseJson<{ name?: string }>(request); const name = input.name?.trim();
    if (!name || name.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
    if (kiosk.active) {
      const duplicate = await db.prepare("SELECT id FROM kiosks WHERE installation_id = 'primary' AND active = 1 AND id <> ? AND lower(name) = lower(?) LIMIT 1").bind(kioskId, name).first<{ id: string }>();
      if (duplicate) throw new HttpError(409, "An active kiosk already uses that name. Choose a distinct device name.");
    }
    await db.prepare("UPDATE kiosks SET name = ? WHERE installation_id = 'primary' AND id = ?").bind(name, kioskId).run();
    await writeAudit(db, principal, "kiosk.renamed", "kiosk", kioskId, { previousName: kiosk.name, name });
    return response({ kiosk: { ...kiosk, name } });
  }
  const input = await parseJson<{ confirmation?: string }>(request);
  if (input.confirmation !== "RETIRE KIOSK") throw new HttpError(400, "Type RETIRE KIOSK exactly to continue");
  await db.batch(retireKioskStatements(db, principal, kiosk, "kiosk.retired"));
  return response({ retired: true, kioskId });
}
export async function kioskAuthenticationConfiguration(request: Request, env: Env, kioskId?: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (!kioskId) throw new HttpError(400, "Select a kiosk and save its authentication method individually");
  const input = await parseJson<{ authenticationMethod?: KioskAuthenticationMethod; memberLookup?: KioskMemberLookup; requirePin?: boolean; discordCode?: boolean; discordCodeBackup?: DiscordCodeBackup }>(request);
  if (!input.authenticationMethod || !kioskAuthenticationMethods.has(input.authenticationMethod)) throw new HttpError(400, "Choose fingerprint, RFID badge, NFC badge, member ID entry, or QR code");
  if (input.memberLookup !== undefined && (input.authenticationMethod !== "member_id" || !kioskMemberLookups.has(input.memberLookup))) throw new HttpError(400, "Member search or member ID entry can be chosen only with the member ID method");
  if (input.requirePin !== undefined && (typeof input.requirePin !== "boolean" || input.requirePin && input.authenticationMethod !== "member_id")) throw new HttpError(400, "Require PIN can be turned on only with the member ID method");
  if (input.discordCode !== undefined && (typeof input.discordCode !== "boolean" || input.discordCode && input.authenticationMethod !== "member_id")) throw new HttpError(400, "Discord codes can be turned on only with the member ID method");
  if (input.discordCodeBackup !== undefined && (typeof input.discordCodeBackup !== "string" || !discordCodeBackups.has(input.discordCodeBackup))) throw new HttpError(400, "The backup for Discord codes is offline or always");
  const kiosk = await db.prepare("SELECT id, kind, configured_authentication_method AS authenticationMethod, member_lookup AS memberLookup, require_pin AS requirePin, discord_code AS discordCode, discord_code_backup AS discordCodeBackup, release_version AS releaseVersion FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(kioskId).first<{ id: string; kind?: KioskKind; releaseVersion?: string | null; authenticationMethod: KioskAuthenticationMethod; memberLookup?: KioskMemberLookup; requirePin?: number; discordCode?: number; discordCodeBackup?: string }>();
  if (!kiosk) throw new HttpError(404, "Active kiosk not found");
  if (kiosk.kind === "web" && input.authenticationMethod !== "member_id") throw new HttpError(400, "Web kiosks identify members by Discord code, member ID or member search.");
  // The lookup stays as it was when omitted with the member ID method, so a save that does not mention it keeps member
  // search. Any other method resets it, so a later switch back to member ID starts on entry.
  const previousMemberLookup: KioskMemberLookup = kiosk.authenticationMethod === "member_id" && kiosk.memberLookup === "search" ? "search" : "entry";
  const memberLookup: KioskMemberLookup = input.authenticationMethod === "member_id" ? input.memberLookup ?? previousMemberLookup : "entry";
  // Require PIN stays as it was when omitted with the member ID method, so a save that does not mention it never turns
  // PINs off; any other method clears it.
  const previousRequirePin = Number(kiosk.requirePin) === 1 && kiosk.authenticationMethod === "member_id";
  const requirePin = input.authenticationMethod === "member_id" ? input.requirePin ?? previousRequirePin : false;
  // Only turning Require PIN on is refused, and only for a Pi kiosk whose last reported release is from before member
  // PINs (or unknown): it would keep sending plain scans, which are refused, and record nothing. The same flag is
  // "Require PIN for the backup method" on a Discord code kiosk. Turning it off and every other save go through.
  if (requirePin && !previousRequirePin && !kioskHonoursRequirePin(kiosk.kind, kiosk.releaseVersion)) throw new HttpError(409, `Update this kiosk before turning on Require PIN. Kiosks older than ${requirePinFirstKioskRelease} do not ask for a PIN, so every scan would be refused.`, undefined, "kiosk_update_required_for_pin");
  // Discord codes follow the same rule. The backup choice is kept whatever the method, so turning codes back on finds it.
  const previousDiscordCode = Number(kiosk.discordCode) === 1 && kiosk.authenticationMethod === "member_id";
  const discordCode = input.authenticationMethod === "member_id" ? input.discordCode ?? previousDiscordCode : false;
  const previousDiscordCodeBackup = normalizeDiscordCodeBackup(kiosk.discordCodeBackup);
  const discordCodeBackup = input.discordCodeBackup ?? previousDiscordCodeBackup;
  // Turning codes off, or on again, starts the kiosk's wrong-code count over.
  const result = await db.prepare("UPDATE kiosks SET configured_authentication_method = ?, member_lookup = ?, require_pin = ?, discord_code = ?, discord_code_backup = ?, discord_code_failures = CASE WHEN discord_code = ? THEN discord_code_failures ELSE 0 END, discord_code_throttle_until = CASE WHEN discord_code = ? THEN discord_code_throttle_until ELSE NULL END WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(input.authenticationMethod, memberLookup, requirePin ? 1 : 0, discordCode ? 1 : 0, discordCodeBackup, discordCode ? 1 : 0, discordCode ? 1 : 0, kioskId).run();
  if (result.meta?.changes === 0) throw new HttpError(409, "Kiosk was retired before its method could be saved");
  await writeAudit(db, principal, "kiosk.authentication_method_updated", "kiosk", kioskId, { previousMethod: kiosk.authenticationMethod, authenticationMethod: input.authenticationMethod, previousMemberLookup: kiosk.memberLookup ?? "entry", memberLookup, previousRequirePin, requirePin, previousDiscordCode, discordCode, previousDiscordCodeBackup, discordCodeBackup });
  return response({ kioskId, authenticationMethod: input.authenticationMethod, memberLookup, requirePin, discordCode, discordCodeBackup });
}
export async function dashboardKioskEnrollment(request: Request, env: Env, kioskId: string, sessionId?: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]), db = requireDatabase(env);
  if (request.method === "GET" && !sessionId) return response({ session: await readKioskEnrollment(db, kioskId, true) });
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Enrollment requires the dashboard origin");
  if (request.method === "POST" && !sessionId) {
    const session = await startKioskEnrollment(db, kioskId, principal.userId);
    await writeAudit(db, principal, "kiosk.enrollment_started", "kiosk", kioskId, { sessionId: session.id });
    return response({ session }, 201);
  }
  if (request.method === "PATCH" && sessionId) {
    const input = await parseJson<{ memberId?: string }>(request);
    if (!isObject(input) || Object.keys(input).some(key => key !== "memberId")) throw new HttpError(400, "Select one roster member");
    const session = await selectEnrollmentMember(db, kioskId, sessionId, input.memberId);
    await writeAudit(db, principal, "kiosk.enrollment_member_selected", "kiosk", kioskId, { sessionId, rosterId: input.memberId });
    return response({ session });
  }
  if (request.method === "DELETE" && sessionId) {
    await cancelKioskEnrollment(db, kioskId, sessionId);
    await writeAudit(db, principal, "kiosk.enrollment_cancelled", "kiosk", kioskId, { sessionId });
    return response({ cancelled: true });
  }
  throw new HttpError(405, "Unsupported enrollment operation");
}
export async function kioskEnrollmentProgress(request: Request, env: Env, sessionId: string): Promise<Response> {
  const kiosk = await kioskFor(request, env), input = await parseJson<{ status?: string; message?: string }>(request);
  if (!isObject(input) || Object.keys(input).some(key => !["status", "message"].includes(key))) throw new HttpError(400, "Unsupported enrollment progress");
  // Device-supplied prose is deliberately not persisted or reflected.
  const db = requireDatabase(env), session = await progressKioskEnrollment(db, kiosk.id, sessionId, input.status);
  // A new enrollment starts the member's match-score history over, clearing any re-enrollment suggestion.
  if (input.status === "enroll_success" && session.progress === "enroll_success" && session.member) await recordFingerprintReenrolled(db, session.member.rosterId).catch(() => undefined);
  return response({ session });
}
export async function queueKioskCommand(request: Request, env: Env, kioskId: string): Promise<Response> {
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Kiosk commands require the dashboard origin");
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ command?: KioskCommandType; replaceDevelopmentBuild?: boolean }>(request);
  const supported: KioskCommandType[] = ["reload_display", "restart_service", "reboot", "reset_network_pin", "install_latest", "erase_unlinked_fingerprints"];
  if (!isObject(input) || Object.keys(input).some((key) => key !== "command" && key !== "replaceDevelopmentBuild") || input.replaceDevelopmentBuild !== undefined && (input.command !== "install_latest" || input.replaceDevelopmentBuild !== true) || !input.command || !supported.includes(input.command)) throw new HttpError(400, "Choose a supported kiosk command without additional arguments");
  const kiosk = await db.prepare("SELECT id, name, kind, release_version AS releaseVersion, update_policy_version AS updatePolicyVersion, reader_templates AS readerTemplates FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(kioskId).first<{ id: string; name: string; kind?: KioskKind; releaseVersion?: string; updatePolicyVersion?: number; readerTemplates?: number | null }>();
  if (!kiosk) throw new HttpError(404, "Active kiosk not found");
  if (kiosk.kind === "web" && input.command !== "reload_display" && input.command !== "reset_network_pin") throw new HttpError(409, "Web kiosks can only reload their display or reset their settings PIN.");
  // Kiosks before 2.0.0-beta.14 reject unknown command types; only kiosks reporting reader counts understand this one.
  if (input.command === "erase_unlinked_fingerprints" && typeof kiosk.readerTemplates !== "number") throw new HttpError(409, "Update this kiosk to 2.0.0-beta.14 or later, and connect its fingerprint reader, before erasing unlinked fingerprints.");
  let requestedReleaseVersion: string | null = null;
  const setting = await readUpdateChannel(env);
  const target = input.command === "install_latest" ? await latestCompatibleKioskRelease(env, setting.channel) : undefined;
  if (target) {
    if (target.prerelease && kiosk.updatePolicyVersion !== 2) throw new HttpError(409, "Install the stable update-channel bridge on this kiosk before updating it to Beta.");
    const transition = kioskReleaseTransition(target.tag, kiosk.releaseVersion ?? "");
    if (transition === "replace-development" && input.replaceDevelopmentBuild !== true) throw new HttpError(409, "Confirm replacing this development build with the verified official release.");
    if (!["upgrade", "replace-development"].includes(transition)) throw new HttpError(409, "This kiosk has no eligible release on the selected track. Unknown versions and downgrades are not supported.");
    requestedReleaseVersion = target.tag;
  }
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO kiosk_commands (id, installation_id, kiosk_id, command_type, created_by, created_at, requested_release_version, release_version_before, update_channel, requested_release_sha) SELECT ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM installation_update_settings WHERE installation_id = 'primary' AND update_channel_revision = ?) AND (? <> 'install_latest' OR NOT EXISTS (SELECT 1 FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? AND command_type = 'install_latest' AND (completed_at IS NULL OR success = 1 AND resolution_status IS NULL) AND created_at >= ?))").bind(id, kioskId, input.command, principal.userId, now, requestedReleaseVersion, input.command === "install_latest" ? kiosk.releaseVersion ?? null : null, setting.channel, target?.sha ?? null, setting.revision, input.command, kioskId, new Date(Date.now() - 15 * 60_000).toISOString()),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'kiosk.command_queued', 'kiosk', ?, ?, ? WHERE EXISTS (SELECT 1 FROM kiosk_commands WHERE installation_id = 'primary' AND id = ?)").bind(crypto.randomUUID(), principal.userId, kioskId, JSON.stringify({ commandId: id, command: input.command, requestedReleaseVersion, channel: setting.channel, targetCommit: target?.sha }), now, id),
  ]);
  if (!await db.prepare("SELECT id FROM kiosk_commands WHERE installation_id = 'primary' AND id = ?").bind(id).first()) throw new HttpError(409, "The update track changed or a kiosk update is already pending. Refresh its status before trying again.");
  return response({ command: { id, type: input.command, kioskId, queuedAt: now, ...(requestedReleaseVersion ? { requestedReleaseVersion } : {}) } }, 202);
}
export async function kioskCommandStatus(request: Request, env: Env, kioskId: string): Promise<Response> {
  await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const kiosk = await db.prepare("SELECT id FROM kiosks WHERE installation_id = 'primary' AND id = ?").bind(kioskId).first<{ id: string }>();
  if (!kiosk) throw new HttpError(404, "Kiosk not found");
  const commands = await db.prepare("SELECT id, command_type AS type, created_at AS createdAt, completed_at AS completedAt, success, result_message AS resultMessage, requested_release_version AS requestedReleaseVersion, release_version_before AS releaseVersionBefore, resolution_status AS resolutionStatus, resolved_release_version AS resolvedReleaseVersion, resolved_at AS resolvedAt FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? ORDER BY created_at DESC LIMIT 12").bind(kioskId).all();
  return response({ commands: commands.results ?? [] });
}
export async function pendingKioskCommand(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const notBefore = new Date(Date.now() - 15 * 60_000).toISOString(); const command = await requireDatabase(env).prepare("SELECT id, command_type AS type, created_at AS createdAt, requested_release_version AS targetTag, requested_release_sha AS targetCommit, update_channel AS channel FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? AND completed_at IS NULL AND created_at >= ? ORDER BY created_at LIMIT 1").bind(kiosk.id, notBefore).first();
  return response({ command: command ?? null });
}
export async function completeKioskCommand(request: Request, env: Env, commandId: string): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ success?: boolean; message?: string }>(request); if (typeof input.success !== "boolean" || (input.message?.length ?? 0) > 200) throw new HttpError(400, "Command result needs a success flag and optional short message");
  const result = await requireDatabase(env).prepare("UPDATE kiosk_commands SET completed_at = ?, success = ?, result_message = ? WHERE installation_id = 'primary' AND kiosk_id = ? AND id = ? AND (completed_at IS NULL OR (command_type = 'install_latest' AND success = 1 AND resolution_status IS NULL AND ? = 0))").bind(new Date().toISOString(), input.success ? 1 : 0, input.message?.trim() || null, kiosk.id, commandId, input.success ? 1 : 0).run();
  if ((result.meta?.changes ?? 1) < 1) throw new HttpError(404, "Pending kiosk command not found");
  return response({ completed: true, commandId });
}
