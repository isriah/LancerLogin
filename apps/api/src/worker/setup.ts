import { attendanceDisableCalendar, attendanceDisableCalendarStatement, type AttendanceDisableCalendar, type AttendanceDisableCalendarRow } from "../calendar-queue.ts";
import { createSessionCodec, passwordHashFromCredential } from "../runtime-security.ts";
import { bootstrapClaimKey, clearFailedLogins, lockActive, recordFailedLogin, setupResetCookie, setupResetGrantKey } from "../auth-protection.ts";
import { encryptIntegration } from "../integration-crypto.ts";
import { WebUpdateError, prepareWebUpdate, startWebUpdate, webUpdateStatus, webUpdateMaintenance, updateRepositoryFiles, recheckUpdateSetup } from "../web-updates.ts";
import { commitPluginChange, currentSelectionSha, freshUntil, lookupPluginRelease, pluginManagementState, requireNoModuleMigration, reviewPluginChange, selectionCredentialState } from "../plugin-selection.ts";
import { discoveryForChannel } from "../release-discovery.ts";
import { readUpdateChannel, changeUpdateChannel } from "../update-channel.ts";
import { pinRequestCounts, type PinRequestCounts } from "../member-pins.ts";
import { resolveDefaultTheme } from "../../../../packages/shared/src/product.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { ModuleRegistrationIncomplete, configureModulePlatform, readModuleAssignments, readModulePlatformSnapshot, readModuleSetup, setModuleAssignments, updateModuleSetup } from "../module-platform.ts";
import { grantModuleInterface, readModuleInterfaceGrants, revokeModuleInterfaceGrant } from "../module-interfaces.ts";
import { reconcileInstalledModules } from "../module-catalog.ts";
import type { ModulePlatformSnapshot } from "../../../../packages/shared/src/module-platform.ts";
import { checkPasswordProof, passwordProofKey, reauthenticationParams, reloadRequired, storeUpgradedPassword, validPasswordCredential } from "./auth.ts";
import { type AuthMode, type BootstrapInput, type Env, type Principal, type Role, allInOrder, authorizedRead, constantTimeEqual, cookie, localSessionCookie, parseJson, requireDatabase, requireRole, response, sessionCookie, sha256, validEmail, validTimeZone, writeAudit } from "./core.ts";
import { calendarRemovalTargets } from "./google-calendar.ts";
import { apiModules } from "./module-runtime.ts";


export async function setupStatus(env: Env): Promise<Response> {
  const db = requireDatabase(env);
  // One round trip: organization_settings is keyed by installation_id, so the LEFT JOIN adds at most its one row, and a
  // missing row leaves settingsInstallationId null, which reports settings: null as the separate read did.
  const row = await db.prepare("SELECT i.id, i.auth_mode AS authMode, s.installation_id AS settingsInstallationId, s.organization_name AS organizationName, s.subtitle, s.logo_data AS logoData, s.primary_color AS primaryColor, s.secondary_color AS secondaryColor, s.appearance, s.time_zone AS timeZone, s.logo_backdrop AS logoBackdrop, s.late_scan_minutes AS lateScanMinutes, s.early_scan_minutes AS earlyScanMinutes, s.discord_contest_window_hours AS discordContestWindowHours, s.attendance_reporting_starts_on AS attendanceReportingStartsOn, s.anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, s.anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes FROM installations i LEFT JOIN organization_settings s ON s.installation_id = i.id WHERE i.id = ?").bind("primary").first<{ id: string; authMode: AuthMode; settingsInstallationId?: string | null } & Record<string, unknown>>();
  // Development Workers set DEFAULT_THEME=development so their dashboards keep a distinct starting palette.
  const defaultTheme = resolveDefaultTheme(env.DEFAULT_THEME);
  if (!row) return response({ configured: false, defaultTheme });
  const { id, authMode, settingsInstallationId, ...settings } = row;
  return response({ configured: true, installation: { id, authMode, telemetryAccepted: false }, settings: settingsInstallationId == null ? null : settings, defaultTheme });
}
function validateBootstrap(input: BootstrapInput): string[] {
  const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (!input.timeZone || !validTimeZone(input.timeZone)) errors.push("A valid IANA time zone is required");
  if (!input.authMode || !["google", "local", "both"].includes(input.authMode)) errors.push("Authentication mode must be google, local, or both");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.adminEmail || !validEmail(input.adminEmail))) errors.push("A valid first-Admin email is required for Google sign-in");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.googleClientId?.trim() || !input.googleClientSecret?.trim() || input.googleClientId.length > 500 || input.googleClientSecret.length > 500)) errors.push("Google sign-in requires an OAuth client ID and client secret");
  // The browser sends a salt and K, never the password, so the 12-character minimum is enforced by the setup form.
  if ((input.authMode === "local" || input.authMode === "both") && (!input.localUsername?.trim() || !validPasswordCredential(input.localPasswordKey))) errors.push("Local sign-in requires a username and a password of at least 12 characters");
  return errors;
}
export async function bootstrap(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env);
  if (await db.prepare("SELECT id FROM installations WHERE id = ?").bind("primary").first()) throw new HttpError(409, "Installation is already configured");
  const input = await parseJson<BootstrapInput>(request);
  if (!env.BOOTSTRAP_CODE_HASH) throw new HttpError(503, "First-Admin setup protection is not configured");
  const suppliedCodeHash = await sha256(input.setupCode ?? "");
  if (!constantTimeEqual(suppliedCodeHash, env.BOOTSTRAP_CODE_HASH)) throw new HttpError(403, "The one-time setup code is invalid");
  // A setup code that already created an installation stays used after DELETE INSTALLATION. Only the browser that
  // deleted the installation holds a one-time reset grant; anyone else needs a rotated setup code.
  const claimKey = await bootstrapClaimKey(env.BOOTSTRAP_CODE_HASH); const resetGrant = cookie(request, setupResetCookie);
  const resetGrantKey = resetGrant ? await setupResetGrantKey(resetGrant) : undefined;
  if (await db.prepare("SELECT 1 AS claimed FROM bootstrap_code_claims WHERE claim_key = ?").bind(claimKey).first()
    && !(resetGrantKey && await db.prepare("SELECT 1 AS granted FROM bootstrap_reset_grants WHERE grant_key = ? AND expires_at > ?").bind(resetGrantKey, new Date().toISOString()).first()))
    throw new HttpError(409, "This setup code was already used. Rotate the BOOTSTRAP_CODE_HASH Worker secret to a new setup code before creating the installation again.");
  if (input.localPasswordKey === undefined && input.localPassword !== undefined) throw reloadRequired();
  const errors = validateBootstrap(input);
  if (errors.length) throw new HttpError(400, "Invalid setup", errors);
  if ((input.authMode === "google" || input.authMode === "both") && !env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const now = new Date().toISOString(); const adminId = crypto.randomUUID(); const mode = input.authMode!;
  const passwordHash = mode === "local" || mode === "both" ? await passwordHashFromCredential(input.localPasswordKey) ?? null : null;
  const telemetryAcceptedAt = null; // Historical columns remain inert for backup compatibility.
  // Column defaults keep the original development palette; new installations store the resolved theme explicitly.
  const theme = resolveDefaultTheme(env.DEFAULT_THEME);
  const statements = [
    db.prepare("INSERT INTO installations (id, created_at, auth_mode, telemetry_accepted_at, telemetry_install_id, google_enabled) VALUES (?, ?, ?, ?, ?, ?)").bind("primary", now, mode, telemetryAcceptedAt, null, mode === "google" || mode === "both" ? 1 : 0),
    db.prepare("INSERT INTO organization_settings (installation_id, organization_name, time_zone, primary_color, secondary_color) VALUES (?, ?, ?, ?, ?)").bind("primary", input.organizationName!.trim(), input.timeZone, theme.primary, theme.secondary),
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)").bind(adminId, "primary", input.adminEmail?.toLowerCase() ?? null, input.localUsername?.trim().toLowerCase() ?? null, passwordHash, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), "primary", adminId, "installation.created", "installation", "primary", now),
    // Authority epochs outlive DELETE INSTALLATION by design, so setup after a deletion continues them instead of reusing old values.
    db.prepare("INSERT INTO platform_module_administration_epochs (installation_id, revision) VALUES ('primary', 0) ON CONFLICT(installation_id) DO UPDATE SET revision = platform_module_administration_epochs.revision + 1"),
    db.prepare("INSERT INTO platform_module_administration (installation_id, revision, selection_completed) SELECT 'primary', revision, 0 FROM platform_module_administration_epochs WHERE installation_id = 'primary'"),
    ...bundledModuleRegistry.modules.flatMap((module) => [
      db.prepare("INSERT INTO platform_module_epochs (installation_id, module_id, generation) VALUES ('primary', ?, 1) ON CONFLICT(installation_id, module_id) DO UPDATE SET generation = platform_module_epochs.generation + 1").bind(module.id),
      db.prepare("INSERT INTO platform_modules (installation_id, module_id, contract_version, generation, phase, setup_version, setup_complete) SELECT 'primary', ?1, ?2, generation, 'disabled', ?3, 0 FROM platform_module_epochs WHERE installation_id = 'primary' AND module_id = ?1").bind(module.id, module.contractVersion, module.setup.version),
    ]),
    ...apiModules.all.flatMap((module) => module.installationSeed?.(db, { installationId: "primary", now }) ?? []),
    db.prepare("INSERT INTO platform_module_assignment_epochs (installation_id, user_id, revision) VALUES ('primary', ?, 0)").bind(adminId),
    db.prepare("INSERT INTO platform_module_assignment_revisions (installation_id, user_id, revision) VALUES ('primary', ?, 0)").bind(adminId),
    db.prepare("INSERT OR IGNORE INTO bootstrap_code_claims (claim_key, claimed_at) VALUES (?, ?)").bind(claimKey, now),
    ...(resetGrantKey ? [db.prepare("DELETE FROM bootstrap_reset_grants WHERE grant_key = ?").bind(resetGrantKey)] : []),
  ];
  if (mode === "google" || mode === "both") {
    const encrypted = await encryptIntegration({ clientId: input.googleClientId!.trim(), clientSecret: input.googleClientSecret!.trim() }, env.INTEGRATION_KEY!);
    statements.push(
      db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, updated_at) VALUES (?, 'primary', 'google', ?, ?, ?)").bind(crypto.randomUUID(), encrypted.ciphertext, encrypted.iv, now),
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, 'primary', ?, 'integration.saved', 'integration', 'google', ?)").bind(crypto.randomUUID(), adminId, now),
    );
  }
  await db.batch(statements);
  // Apply plugin migrations and record installed modules now, so plugins are registered as soon as the installation exists.
  // A failure retries on the next request's reconciliation or the scheduled pass.
  try { await reconcileInstalledModules(db); } catch { /* Retried by later requests and the scheduled pass. */ }
  // A first Admin with a local password is signed in straight away with the same session cookie /auth/local issues, so
  // setup does not end on a sign-in form. Google-only setup still signs in through Google, and a Worker without a session
  // key reports signedIn: false so the dashboard shows the sign-in form instead.
  const signedIn = Boolean(passwordHash && env.SESSION_KEY);
  const cookies = [
    ...(resetGrant ? [`${setupResetCookie}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`] : []),
    ...(signedIn ? [await localSessionCookie(env.SESSION_KEY!, { id: adminId, role: "admin", sessionEpoch: 0 })] : []),
  ];
  const result = response({ configured: true, admin: { id: adminId, email: input.adminEmail?.toLowerCase(), localUsername: input.localUsername?.trim().toLowerCase(), role: "admin" }, signedIn, ...(signedIn ? { user: { id: adminId, role: "admin" } } : {}), telemetryAccepted: false }, 201);
  // Appended after response() because it sets headers one name at a time and would keep only one of two cookies.
  for (const value of cookies) result.headers.append("set-cookie", value);
  return result;
}

/** The counts for GET /platform/modules. A failure leaves them out: the count never makes module access unavailable. */
async function waitingPinRequests(env: Env): Promise<PinRequestCounts | undefined> {
  try { return await pinRequestCounts(requireDatabase(env)); } catch { return undefined; }
}
/** Adds the counts for a caller who has the Attendance workspace, the same access the kiosk routes under /admin/kiosks need. */
function withPinRequests(snapshot: ModulePlatformSnapshot, pinRequests: PinRequestCounts | undefined) {
  return pinRequests && snapshot.modules.some((module) => module.id === "attendance" && module.workspaceReady) ? { ...snapshot, pinRequests } : snapshot;
}
/**
 * What disabling Attendance would leave on the calendars, for GET /platform/modules?disable=attendance: Settings > Modules
 * asks once, when an Admin reviews disabling Attendance, so the module refresh every dashboard repeats never pays for it.
 * A failure leaves it out, and the confirmation then reads as it does with nothing left behind.
 */
async function attendanceDisableCalendarCounts(env: Env): Promise<AttendanceDisableCalendar | undefined> {
  try { const db = requireDatabase(env); return attendanceDisableCalendar(await attendanceDisableCalendarStatement(db, new Date().toISOString()).first<AttendanceDisableCalendarRow>()); } catch { return undefined; }
}
/** Adds those counts for an Admin while Attendance is enabled, the only time there is something to disable. */
function withAttendanceDisableCalendar<T extends ModulePlatformSnapshot>(principal: Principal, snapshot: T, calendar: AttendanceDisableCalendar | undefined) {
  return calendar && principal.role === "admin" && snapshot.modules.some((module) => module.id === "attendance" && module.enabled) ? { ...snapshot, attendanceDisableCalendar: calendar } : snapshot;
}
export async function modulePlatform(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // authorizedRead rethrows its 401 or 403 first, so a registration gap is only acted on for an authorized caller.
    // The waiting PIN request counts ride on this read, which every open dashboard already repeats, so the top bar's count
    // costs one more D1 read here and no request of its own. Both reads start together, so the answer is no slower; the
    // snapshot's failure wins, and the counts are sent only to a caller with the Attendance workspace.
    const reviewingAttendanceDisable = new URL(request.url).searchParams.get("disable") === "attendance";
    try {
      const [principal, [snapshot, pinRequests, calendar]] = await authorizedRead(request, env, ["admin", "operator"], (userId) => allInOrder(() => readModulePlatformSnapshot(requireDatabase(env), userId), () => waitingPinRequests(env), () => reviewingAttendanceDisable ? attendanceDisableCalendarCounts(env) : undefined));
      return response(withAttendanceDisableCalendar(principal, withPinRequests(snapshot, pinRequests), calendar));
    }
    catch (error) { if (!(error instanceof ModuleRegistrationIncomplete) || await webUpdateMaintenance(env)) throw error; }
    const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
    await reconcileInstalledModules(db);
    return response(withPinRequests(await readModulePlatformSnapshot(db, principal.userId, { unregistered: "show" }), await waitingPinRequests(env)));
  }
  const principal = await requireRole(request, env, ["admin"]);
  const db = requireDatabase(env);
  const input = await parseJson(request);
  // Record installed definitions before any module can be enabled, so retained data stays deletable without its code.
  await reconcileInstalledModules(db);
  // Disabling Attendance records the events of its pending deletes for removal; they are bound to the calendar and server in use now.
  const disablesAttendance = Array.isArray((input as { enabled?: unknown } | null)?.enabled) && !((input as { enabled: unknown[] }).enabled).includes("attendance");
  return response(await configureModulePlatform(db, principal.userId, input, disablesAttendance ? await calendarRemovalTargets(env) : {}));
}

export async function moduleAssignments(request: Request, env: Env, userId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]);
  const db = requireDatabase(env);
  if (request.method === "GET") return response(await readModuleAssignments(db, principal.userId, userId));
  return response(await setModuleAssignments(db, principal.userId, userId, await parseJson(request)));
}
export async function moduleSetup(request: Request, env: Env, moduleId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") return response(await readModuleSetup(db, principal.userId, moduleId));
  if (request.method === "PUT") return response(await updateModuleSetup(db, principal.userId, moduleId, await parseJson(request)));
  throw new HttpError(405, "Use GET or PUT for module setup");
}
export async function updateInfo(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const repository = env.UPDATE_REPOSITORY && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY) && env.UPDATE_REPOSITORY.toLowerCase() !== "isriah/lancerlogin" ? env.UPDATE_REPOSITORY : undefined;
  const workflowUrl = repository ? `https://github.com/${repository}/actions/workflows/upgrade-web.yml` : env.UPDATE_WORKFLOW_URL;
  // No workflow address is an ordinary answer: the dashboard reads this on every page to know the running release, and
  // Settings > Updates explains that dashboard updates are not set up.
  return response({ releaseVersion: env.RELEASE_VERSION ?? "development", ...(workflowUrl ? { workflowUrl } : {}) });
}
export async function discoverRelease(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const { channel } = await readUpdateChannel(env);
  // Settings > Updates > Check for updates asks for a GitHub read now; the discovery decides whether it may (see check).
  const force = new URL(request.url).searchParams.get("refresh") === "now";
  const discovery = discoveryForChannel(channel);
  const result = await discovery.check(env, { force });
  const refreshAt = discovery.forcedRefreshAt(env);
  // A duration, like Retry-After, telling the dashboard when its button can reach GitHub again despite automatic backoff.
  const refreshAfterMs = refreshAt === undefined ? undefined : Math.max(0, refreshAt - Date.now());
  return response({ ...result, channel, ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }) }, result.fresh ? 200 : result.code === "rate_limited" ? 429 : 503,
    result.retryAt ? { "retry-after": String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))) } : undefined);
}
export async function updateChannel(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") return response((await authorizedRead(request, env, ["admin"], () => readUpdateChannel(env)))[1]);
  const principal = await requireRole(request, env, ["admin"]);
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Update settings require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 2_048);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Invalid update setting");
  return response(await changeUpdateChannel(env, input, principal.userId));
}
export async function webUpdates(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]);
  if (request.method === "GET") return response(await webUpdateStatus(env));
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Web updates require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 2_048);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Invalid web update request");
  if (new URL(request.url).pathname.endsWith("/prepare")) {
    // The only accepted parameter chooses redeploying the installed release with the committed plugin selection.
    const keys = Object.keys(input);
    if (keys.length && (keys.length !== 1 || input.mode !== "modules")) throw new HttpError(400, "Prepare accepts no release or deployment parameters");
    const mode = input.mode === "modules" ? "modules" : "release";
    // Pin the plugin selection when the selection credential is available; plugin changes always require it.
    const selectionSha = mode === "modules" || selectionCredentialState(env).state === "ready" ? () => currentSelectionSha(env) : undefined;
    return response(await prepareWebUpdate(env, principal.userId, { mode, selectionSha, guard: () => requireNoModuleMigration(env) }));
  }
  return response(await startWebUpdate(env, input, principal.userId), 202);
}
/**
 * Settings > Updates > Setup status: proposes the installed release's workflow files in a pull request in the deployment
 * repository. Like preparing a web update it needs an Admin and the dashboard origin. It needs no fresh re-authentication:
 * nothing changes until the installer reviews and merges the pull request on GitHub, which GitHub authenticates itself.
 */
export async function repositoryFiles(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]);
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Repository file updates require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 1_024);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new HttpError(400, "Repository file updates accept no parameters");
  const result = await updateRepositoryFiles(env);
  if (result.created) await writeAudit(requireDatabase(env), principal, "web_update.repository_files_proposed", "repository", env.UPDATE_REPOSITORY ?? null, { release: result.release, files: result.files, pullRequest: result.pullRequest.number });
  return response(result, result.created ? 201 : 200);
}
/** Settings > Updates > Setup status > Check again: an Admin on the dashboard origin rereads the GitHub setup checks, rate limited in web-updates.ts. */
export async function recheckSetup(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Setup checks require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 1_024);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new HttpError(400, "Setup checks accept no parameters");
  return response({ setup: await recheckUpdateSetup(env) });
}
export async function pluginManagement(request: Request, env: Env, action: "state" | "review" | "change" | "reauthenticate" | "reauthenticate/params" | "release"): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (action === "state") {
    const [user, installation] = await Promise.all([
      db.prepare("SELECT password_hash IS NOT NULL AS password, email FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first<{ password: number; email?: string | null }>(),
      db.prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>(),
    ]);
    return response(await pluginManagementState(env, { principal, passwordAvailable: Boolean(user?.password), googleAvailable: Boolean(user?.email) && ["google", "both"].includes(installation?.authMode ?? "") }));
  }
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Plugin changes require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 4_096);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Invalid plugin request");
  if (action === "review") return response(await reviewPluginChange(env, input, undefined, principal));
  if (action === "release") return response(await lookupPluginRelease(input, env));
  if (action === "reauthenticate/params") return response(await reauthenticationParams(env, principal.userId, input));
  if (action === "change") return response(await commitPluginChange(env, principal, input), 201);
  // Fresh re-authentication with the Admin's own local password replaces the session with a newly authenticated one.
  // The same confirmation covers plugin changes and module access grants in Settings > Modules; `purpose` only labels the audit entry.
  // The browser proves the password with K from /admin/plugins/reauthenticate/params, plus the password once for a legacy row.
  if (Object.keys(input).some((key) => !["key", "salt", "password", "purpose"].includes(key)) || input.purpose !== undefined && input.purpose !== "module_access") throw new HttpError(400, "Enter your password");
  const key = passwordProofKey(input, "Enter your password");
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const user = await db.prepare("SELECT id, role, password_hash AS passwordHash, locked_until AS lockedUntil, session_epoch AS sessionEpoch FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first<{ id: string; role: Role; passwordHash: string | null; lockedUntil?: string; sessionEpoch?: number }>();
  if (!user?.passwordHash) throw new WebUpdateError(409, "password_unavailable", "This account has no LancerLogin password. Sign in with Google again instead.");
  // Check the lock before the expensive hash, and count failures atomically so parallel guesses cannot share one count.
  if (lockActive(user.lockedUntil)) throw new WebUpdateError(401, "reauthentication_failed", "Too many attempts. Try again later.");
  const checked = await checkPasswordProof(user.passwordHash, input, key);
  if (!checked.valid) { await recordFailedLogin(db, user.id); throw new WebUpdateError(401, "reauthentication_failed", "The password is incorrect."); }
  if (!await clearFailedLogins(db, user.id)) throw new WebUpdateError(401, "reauthentication_failed", "Too many attempts. Try again later.");
  if (checked.upgradedHash) await storeUpgradedPassword(db, user.id, user.passwordHash, checked.upgradedHash);
  await writeAudit(db, principal, "auth.reauthenticated", "user", user.id, { method: "password", purpose: input.purpose ?? "plugin_management" });
  const token = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role, epoch: Number(user.sessionEpoch ?? 0) });
  const fresh = await createSessionCodec(env.SESSION_KEY).verify(token);
  return response({ ok: true, freshUntil: fresh?.authenticatedAt ? fresh.authenticatedAt + 10 * 60_000 : null }, 200, { "set-cookie": sessionCookie(token) });
}
/**
 * Settings > Modules: the interface uses each module declares, and the standing grants an active Admin gives them. Like a
 * plugin change, a grant or revocation needs the dashboard origin and fresh authentication.
 */
export async function moduleInterfaceGrants(request: Request, env: Env, action: "list" | "grant" | "revoke"): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (action !== "list") {
    if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Module access changes require the dashboard origin");
    const input = await parseJson<unknown>(request, 4_096);
    if (!freshUntil(principal)) throw new HttpError(401, "Confirm your identity again before changing module access.", undefined, "reauthentication_required");
    if (action === "grant") await grantModuleInterface(db, principal.userId, input); else await revokeModuleInterfaceGrant(db, principal.userId, input);
  }
  const [state, user, installation] = await Promise.all([
    readModuleInterfaceGrants(db),
    db.prepare("SELECT password_hash IS NOT NULL AS password, email FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first<{ password: number; email?: string | null }>(),
    db.prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>(),
  ]);
  return response({ ...state, reauthentication: { freshUntil: freshUntil(principal), password: Boolean(user?.password), google: Boolean(user?.email) && ["google", "both"].includes(installation?.authMode ?? "") } }, action === "grant" ? 201 : 200);
}
