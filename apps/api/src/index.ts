import { authRateLimits, consumeAuthRateLimit } from "./auth-protection.ts";
import { WebUpdateError, webUpdateMaintenance } from "./web-updates.ts";
import { requiredModuleMigrations } from "./plugin-selection.ts";
import { dashboardKioskPinRequests, dashboardMemberPin, dashboardPinRequests, decidePinRequest, kioskPinRoute, pinLockoutSettings } from "./member-pins.ts";
import { measureD1, usageCategory } from "./d1-usage.ts";
import { passSlot, scheduledPassLimits } from "./scheduler-budget.ts";
import { acceptContestBatch, rejectContestBatch } from "./contest-review.ts";
import { HttpError } from "./http-error.ts";
import { fingerprintVaultRoute } from "./fingerprint-vault.ts";
import { kioskPoll } from "./kiosk-poll.ts";
import { syncKioskScanReviews, listKioskScanReviews, markKioskScanReviewed, markKioskScansReviewed } from "./kiosk-scan-reviews.ts";
import { readFingerprintMatch, saveFingerprintMinimumScoreStatement, validateMinimumScore } from "./fingerprint-match.ts";
import { dismissReenrollSuggestion, listPossibleWrongMatches, readReenrollSuggestions, recordLocalFingerprintEnrollment } from "./scan-integrity.ts";
import { readKioskEnrollment } from "./kiosk-enrollment.ts";
import { fingerprintResetRoute } from "./fingerprint-reset.ts";
import { bundledModuleRegistry } from "../../../packages/shared/src/module-platform.ts";
import { requireModuleEnabled, requireModuleService, requireModuleSetup, requireModuleWorkspace } from "./module-platform.ts";
import { captureModuleEnabledDatabase, captureModuleServiceDatabase, captureModuleSetupDatabase, captureModuleWorkspaceDatabase } from "./module-database-scope.ts";
import { attendanceSetupRoute } from "./attendance-module-setup.ts";
import { ensureModulesReconciled } from "./module-catalog.ts";
import { attendanceMemberSettings } from "./attendance-member-settings.ts";
import { schedulerRequest } from "./platform-scheduler.ts";
import { attendance, cleanupAttendance, correction, kioskAttendance } from "./worker/attendance.ts";
import { authSession, authWalkthrough, localLogin, localPasswordParams, logout } from "./worker/auth.ts";
import { backupData, backupSessions } from "./worker/backup.ts";
import { type Env, type ScheduledController, type WorkerContext, attendanceSetupPairingPaths, auditStatement, authorizedRead, moduleScopedEnvironment, parseJson, previewResponses, requireDatabase, requireRole, response, sessionLookups, sha256, withCors, writeAudit } from "./worker/core.ts";
import { durableScheduler, pokeScheduler, schedulerObject } from "./worker/delivery.ts";
import { discordCalendar, retryDiscordCalendarOperations, syncAllDiscordCalendarMeetings, syncMeetingCalendars } from "./worker/discord-calendar.ts";
import { checkDiscordCommands, reconcileDiscordCommands, startDiscordVerification } from "./worker/discord-commands.ts";
import { discordContests, discordMissing, resolveDiscordContest } from "./worker/discord-contests.ts";
import { discordInteraction } from "./worker/discord-interaction.ts";
import { discordKioskStatus } from "./worker/discord-kiosk-status.ts";
import { discordLabelAdvance, discordLabelDirection, discordLabelJobStatus, discordLabelRetry, discordTwoWayConfirm, discordTwoWayPreview, discordUnmatchedRoleMembers } from "./worker/discord-label-jobs.ts";
import { discordGuildRoles, discordLabelApply, discordLabelApplyAll, discordLabelLink, discordLabelMappings, discordLabelPreview, discordLabelPreviewAll, discordLabelUnlink, discordLabelsFromRoles } from "./worker/discord-labels.ts";
import { linkDiscordMember } from "./worker/discord-notifications.ts";
import { sendAttendanceEmail } from "./worker/email.ts";
import { googleCalendarCallback, googleCalendarConfiguration, googleCalendarStart, listGoogleCalendars, retryGoogleCalendarOperations, selectGoogleCalendar, syncAllGoogleCalendarMeetings } from "./worker/google-calendar.ts";
import { googleCallback, googleStart } from "./worker/google-sign-in.ts";
import { providerFrom, requireIntegrationConfigured } from "./worker/integration-support.ts";
import { completeResendVerification, discordAnomalyReportSettings, discordChannelManagerSettings, firstIntegration, integrationCapabilities, integrationConfiguration, integrationsStatus, notionCommentNameSetting, notionIntegration, startResendVerification } from "./worker/integrations.ts";
import { completeKioskCommand, dashboardKioskEnrollment, kioskAuthenticationConfiguration, kioskCommandStatus, kioskConfiguration, kioskEnrollmentProgress, kioskFor, kioskHeartbeat, kioskRoster, kioskStatus, manageKiosk, pairingCodes, pendingKioskCommand, queueKioskCommand, redeemPairingCode } from "./worker/kiosks.ts";
import { attendancePolicies, labelMembership, labelTarget, labels, updateLabel } from "./worker/labels.ts";
import { createMeetingWeightCategory, listMeetingWeightCategories, reorderMeetingWeightCategories, updateMeetingWeightCategory } from "./worker/meeting-weights.ts";
import { bulkDeleteMeetings, deleteMeetings, meetingDetail, meetingImpact, meetingImport, meetingTemplates, meetings, restoreMeetings, rosterHistory, updateMeeting, updateMeetingSeries } from "./worker/meetings.ts";
import { bulkMemberStatus, manageMember, memberHistory, members } from "./worker/members.ts";
import { apiModules, moduleRouteContext, privateModuleResponse } from "./worker/module-runtime.ts";
import { branding, privacySettings } from "./worker/organization.ts";
import { attendanceExport, attendanceReport, customReportQuery, leaderboardReport, manageSavedReport, moduleReportBaseline, reportCatalog, reportCsvExport, reportDetailCsvExport, savedReportTabs, savedReports } from "./worker/reports.ts";
import { deleteData, restoreData, restoreSessions } from "./worker/restore.ts";
import { platformScheduler, registeredPlatformSchedulerJobs, runSchedulerPass, schedulerPokesFor } from "./worker/scheduler.ts";
import { bootstrap, discoverRelease, moduleAssignments, moduleInterfaceGrants, modulePlatform, moduleSetup, pluginManagement, recheckSetup, repositoryFiles, setupStatus, updateChannel, updateInfo, webUpdates } from "./worker/setup.ts";
import { updateUser, users } from "./worker/users.ts";
export { type Env } from "./worker/core.ts";
export { type MeetingWeightCatalogEntry } from "./worker/meeting-weights.ts";
export { registeredModuleSchedulerJobs, registeredCoreSchedulerJobs, type SchedulerPassReport, runSchedulerSlice, PlatformScheduler } from "./worker/scheduler.ts";


const worker = { async fetch(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const url = new URL(request.url); let result: Response;
  sessionLookups.delete(request);
  const binding = env.DB;
  const usage = env.DB ? measureD1(env.DB) : undefined;
  if (usage) env = { ...env, DB: usage.database };
  try {
    if (binding && usage && request.method !== "OPTIONS") { const current = env; await ensureModulesReconciled(usage.database, binding, () => webUpdateMaintenance(current), undefined, undefined, context ? (promise) => context.waitUntil(promise) : undefined); }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !["/auth/local", "/auth/local/params", "/auth/logout", "/auth/google/callback"].includes(url.pathname) && await webUpdateMaintenance(env)) return withCors(response({ error: "An installation update requires temporary write suspension. Retry after recovery or completion.", code: "update_maintenance" }, 503, { "retry-after": "30" }), request, env);
    if (request.method === "POST" && Object.hasOwn(authRateLimits, url.pathname) && env.DB) {
      const retryAfter = await consumeAuthRateLimit(env.DB, request, url.pathname, env.SESSION_KEY ?? env.BOOTSTRAP_CODE_HASH ?? "");
      if (retryAfter) return withCors(response({ error: "Too many attempts. Wait a few minutes and try again.", code: "rate_limited" }, 429, { "retry-after": String(retryAfter) }), request, env);
    }
    const moduleRoute = bundledModuleRegistry.routeOwner(url.pathname);
    let moduleUserId: string | undefined;
    if (request.method !== "OPTIONS" && moduleRoute) {
      const db = requireDatabase(env);
      // The session lookup and the module access check run together; a 401 or 403 from the session still wins.
      if (moduleRoute.module.id === "attendance" && attendanceSetupPairingPaths.has(url.pathname)) {
        if (moduleRoute.route.access === "workspace") {
          const [principal, generation] = await authorizedRead(request, env, ["admin"], (userId) => requireModuleSetup(db, userId, moduleRoute.module.id)); moduleUserId = principal.userId;
          env = moduleScopedEnvironment(env, captureModuleSetupDatabase(db, moduleRoute.module.id, generation, principal.userId));
        } else env = moduleScopedEnvironment(env, captureModuleEnabledDatabase(db, moduleRoute.module.id, await requireModuleEnabled(db, moduleRoute.module.id)));
      } else if (moduleRoute.route.access === "workspace") {
        const [principal, generation] = await authorizedRead(request, env, ["admin", "operator"], (userId) => requireModuleWorkspace(db, userId, moduleRoute.module.id)); moduleUserId = principal.userId;
        const capability = moduleRoute.module.capabilities.find((item) => item.operator)?.id;
        if (!capability) throw new HttpError(500, "Module workspace capability is unavailable");
        env = moduleScopedEnvironment(env, captureModuleWorkspaceDatabase(db, moduleRoute.module.id, generation, principal.userId, capability));
      } else if (moduleRoute.route.access === "setup") {
        const [principal, generation] = await authorizedRead(request, env, ["admin"], (userId) => requireModuleSetup(db, userId, moduleRoute.module.id)); moduleUserId = principal.userId;
        env = moduleScopedEnvironment(env, captureModuleSetupDatabase(db, moduleRoute.module.id, generation, principal.userId));
      } else {
        const generation = await requireModuleService(db, moduleRoute.module.id);
        env = moduleScopedEnvironment(env, captureModuleServiceDatabase(db, moduleRoute.module.id, generation));
      }
    }
    const moduleRouteHandler = moduleRoute && request.method !== "OPTIONS" ? apiModules.get(moduleRoute.module.id)?.routes?.[moduleRoute.route.path] : undefined;
    let moduleResult: Response | undefined;
    if (request.method === "OPTIONS") result = new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-allow-credentials": "true" } });
    else if (url.pathname === "/health" && request.method === "GET") result = response({ ok: true, service: "lancerlogin-api", mode: env.DB ? "ready" : "unconfigured", releaseVersion: env.RELEASE_VERSION ?? "development", modules: bundledModuleRegistry.modules.map((module) => module.id), deployment: env.DEPLOYMENT_MARKER ?? null });
    else if (url.pathname === "/setup/status" && request.method === "GET") result = await setupStatus(env);
    else if (url.pathname === "/setup/bootstrap" && request.method === "POST") result = await bootstrap(request, env);
    else if (url.pathname === "/admin/update-info" && request.method === "GET") result = await updateInfo(request, env);
    else if (url.pathname === "/admin/releases/latest" && request.method === "GET") result = await discoverRelease(request, env);
    else if (url.pathname === "/admin/update-channel" && ["GET", "PUT"].includes(request.method)) result = await updateChannel(request, env);
    else if (url.pathname === "/admin/web-updates/status" && request.method === "GET" || ["/admin/web-updates/prepare", "/admin/web-updates/start"].includes(url.pathname) && request.method === "POST") result = await webUpdates(request, env);
    else if (url.pathname === "/admin/web-updates/repository-files" && request.method === "POST") result = await repositoryFiles(request, env);
    else if (url.pathname === "/admin/web-updates/setup/recheck" && request.method === "POST") result = await recheckSetup(request, env);
    else if (url.pathname === "/admin/plugins" && request.method === "GET") result = await pluginManagement(request, env, "state");
    else if (url.pathname === "/admin/plugins/migrations" && request.method === "GET") { await requireRole(request, env, ["admin"]); result = response({ required: await requiredModuleMigrations(env) }); }
    else if (["/admin/plugins/review", "/admin/plugins/change", "/admin/plugins/reauthenticate", "/admin/plugins/reauthenticate/params", "/admin/plugins/release"].includes(url.pathname) && request.method === "POST") result = await pluginManagement(request, env, url.pathname.slice("/admin/plugins/".length) as "review" | "change" | "reauthenticate" | "reauthenticate/params" | "release");
    else if (url.pathname === "/auth/local/params" && request.method === "POST") result = await localPasswordParams(request, env);
    else if (url.pathname === "/auth/local" && request.method === "POST") result = await localLogin(request, env);
    else if (url.pathname === "/auth/session" && request.method === "GET") result = await authSession(request, env);
    else if (/^\/auth\/walkthroughs\/[^/]+$/.test(url.pathname) && ["GET", "PATCH"].includes(request.method)) result = await authWalkthrough(request, env, url.pathname.slice("/auth/walkthroughs/".length));
    else if (url.pathname === "/auth/logout" && request.method === "POST") result = await logout(request, env);
    else if (url.pathname === "/auth/google/start" && request.method === "GET") result = await googleStart(request, env);
    else if (url.pathname === "/auth/google/callback" && request.method === "GET") result = await googleCallback(request, env);
    else if (url.pathname === "/platform/modules" && request.method === "GET") result = await modulePlatform(request, env);
    else if (url.pathname === "/admin/modules" && request.method === "PUT") result = await modulePlatform(request, env);
    else if (url.pathname === "/admin/modules/grants" && ["GET", "POST"].includes(request.method) || url.pathname === "/admin/modules/grants/revoke" && request.method === "POST") result = await moduleInterfaceGrants(request, env, request.method === "GET" ? "list" : url.pathname.endsWith("/revoke") ? "revoke" : "grant");
    else if (/^\/admin\/modules\/[^/]+\/report-baseline$/.test(url.pathname) && ["GET", "PUT"].includes(request.method)) result = await moduleReportBaseline(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/modules\/[^/]+\/notion-comment-name$/.test(url.pathname) && ["GET", "PUT"].includes(request.method)) result = await notionCommentNameSetting(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/modules\/[^/]+\/setup$/.test(url.pathname) && ["GET", "PUT"].includes(request.method)) result = await moduleSetup(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/modules\/assignments\/[^/]+$/.test(url.pathname) && ["GET", "PUT"].includes(request.method)) result = await moduleAssignments(request, env, decodeURIComponent(url.pathname.split("/")[4]));
    else if (url.pathname.startsWith("/module-setup/attendance/")) { const principal = await requireRole(request, env, ["admin"]); result = await attendanceSetupRoute(request, requireDatabase(env), principal.userId); }
    else if (moduleRouteHandler && (moduleResult = await moduleRouteHandler(moduleRouteContext(moduleRoute!.module.id, request, env, url, moduleUserId)))) result = moduleResult;
    else if (url.pathname === "/admin/branding" && ["GET", "PATCH"].includes(request.method)) result = await branding(request, env);
    else if (url.pathname === "/meeting-weight-categories" && request.method === "GET") result = await listMeetingWeightCategories(request, env, false);
    else if (url.pathname === "/admin/meeting-weight-categories" && request.method === "GET") result = await listMeetingWeightCategories(request, env, true);
    else if (url.pathname === "/admin/meeting-weight-categories" && request.method === "POST") result = await createMeetingWeightCategory(request, env);
    else if (url.pathname === "/admin/meeting-weight-categories/order" && request.method === "PATCH") result = await reorderMeetingWeightCategories(request, env);
    else if (/^\/admin\/meeting-weight-categories\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeetingWeightCategory(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/labels" && ["GET", "POST"].includes(request.method)) result = await labels(request, env);
    else if (url.pathname === "/attendance/policy" && request.method === "GET") result = await attendancePolicies(request, env);
    else if (url.pathname === "/attendance/policy/preview" && request.method === "POST") result = await attendancePolicies(request, env, false);
    else if (url.pathname === "/attendance/policy/apply" && request.method === "POST") result = await attendancePolicies(request, env, true);
    else if (url.pathname === "/labels/membership/preview" && request.method === "POST") result = await labelMembership(request, env, false);
    else if (url.pathname === "/labels/membership/apply" && request.method === "POST") result = await labelMembership(request, env, true);
    else if (url.pathname === "/labels/targets" && request.method === "POST") result = await labelTarget(request, env);
    else if (/^\/labels\/targets\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await labelTarget(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/labels\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateLabel(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/admin/members" && ["GET", "POST"].includes(request.method)) result = await members(request, env);
    else if (url.pathname === "/admin/attendance/members" && request.method === "GET" || /^\/admin\/attendance\/members\/[^/]+$/.test(url.pathname) && request.method === "PATCH") { const principal = await requireRole(request, env, ["admin", "operator"]); result = await attendanceMemberSettings(request, requireDatabase(env), principal.userId, principal.role); }
    else if (url.pathname === "/admin/members/bulk/preview" && request.method === "POST") result = await bulkMemberStatus(request, env, false);
    else if (url.pathname === "/admin/members/bulk/apply" && request.method === "POST") result = await bulkMemberStatus(request, env, true);
    else if (/^\/admin\/members\/[^/]+\/history$/.test(url.pathname) && request.method === "GET") result = await memberHistory(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/members\/[^/]+\/pin$/.test(url.pathname) && ["GET", "DELETE"].includes(request.method) || /^\/admin\/members\/[^/]+\/pin\/unlock$/.test(url.pathname) && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin", "operator"]);
      if (request.method !== "GET" && request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "PIN changes require the dashboard origin");
      result = await dashboardMemberPin(request, decodeURIComponent(url.pathname.split("/")[3]), url.pathname.endsWith("/unlock"), { db: requireDatabase(env), actor: principal, respond: response });
    }
    else if (/^\/admin\/members\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageMember(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/pairing-codes" && ["GET", "POST"].includes(request.method)) result = await pairingCodes(request, env);
    else if (url.pathname === "/admin/kiosks/fingerprint-review" || url.pathname.startsWith("/admin/kiosks/fingerprint-review/")) {
      throw new HttpError(410, "Fingerprint identity review has been retired. Re-enroll fingerprints instead.");
    }
    else if (url.pathname === "/admin/kiosks/fingerprint-reset" || url.pathname.startsWith("/admin/kiosks/fingerprint-reset/")) {
      const principal = await requireRole(request, env, ["admin"]);
      result = await fingerprintResetRoute(request, { db: requireDatabase(env), actor: { kind: "admin", userId: principal.userId }, readJson: parseJson, respond: response });
    }
    else if (url.pathname === "/admin/kiosks/fingerprint-vault" || url.pathname.startsWith("/admin/kiosks/fingerprint-vault/enrollments")) {
      const principal = await requireRole(request, env, ["admin"]);
      result = await fingerprintVaultRoute(request, { db: requireDatabase(env), actor: { kind: "admin", userId: principal.userId }, secret: env.FINGERPRINT_VAULT_KEY, readJson: parseJson, respond: response });
    }
    else if (url.pathname === "/admin/kiosks/fingerprint-match" && ["GET", "PUT"].includes(request.method)) {
      const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
      if (request.method === "PUT") { const minimumScore = validateMinimumScore(await parseJson(request)); await db.batch([saveFingerprintMinimumScoreStatement(db, minimumScore), auditStatement(db, principal, "kiosk.fingerprint_minimum_score_changed", "kiosk", null, { minimumScore })]); }
      result = response(await readFingerprintMatch(db));
    }
    else if (url.pathname === "/admin/kiosks/possible-wrong-matches" && request.method === "GET") { await requireRole(request, env, ["admin"]); result = response(await listPossibleWrongMatches(requireDatabase(env))); }
    else if (url.pathname === "/admin/kiosks/reenroll-suggestions" && request.method === "GET") { await requireRole(request, env, ["admin", "operator"]); result = response(await readReenrollSuggestions(requireDatabase(env))); }
    else if (/^\/admin\/kiosks\/reenroll-suggestions\/[^/]+\/dismissal$/.test(url.pathname) && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const memberId = decodeURIComponent(url.pathname.split("/")[4]);
      await dismissReenrollSuggestion(db, memberId, principal.userId); await writeAudit(db, principal, "kiosk.reenroll_suggestion_dismissed", "member", memberId);
      result = response(await readReenrollSuggestions(db));
    }
    else if (url.pathname === "/admin/kiosks/fingerprint-sync") {
      await requireRole(request, env, ["admin"]);
      throw new HttpError(410, "Peer fingerprint sharing has been retired. Use cloud fingerprint storage.");
    }
    else if (url.pathname === "/admin/kiosks" && request.method === "GET") result = await kioskStatus(request, env);
    else if (url.pathname === "/admin/kiosks/pin-requests" && request.method === "GET") { await requireRole(request, env, ["admin", "operator"]); result = await dashboardPinRequests({ db: requireDatabase(env), respond: response }); }
    else if (/^\/admin\/kiosks\/[^/]+\/pin-requests$/.test(url.pathname) && request.method === "GET") { await requireRole(request, env, ["admin", "operator"]); result = await dashboardKioskPinRequests(decodeURIComponent(url.pathname.split("/")[3]), { db: requireDatabase(env), respond: response }); }
    else if (/^\/admin\/pin-requests\/[^/]+\/(?:approve|decline)$/.test(url.pathname) && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin", "operator"]);
      if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "PIN approval requires the dashboard origin");
      const [, , , requestId, decision] = url.pathname.split("/");
      result = await decidePinRequest(decodeURIComponent(requestId), decision === "approve" ? "approve" : "decline", { db: requireDatabase(env), actor: principal, respond: response });
    }
    else if (url.pathname === "/admin/settings/pin-lockout" && ["GET", "PUT"].includes(request.method)) {
      const principal = await requireRole(request, env, ["admin"]);
      if (request.method === "PUT" && request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "PIN lockout settings require the dashboard origin");
      result = await pinLockoutSettings(request, { db: requireDatabase(env), actor: principal, readJson: parseJson, respond: response });
    }
    else if (/^\/admin\/kiosks\/[^/]+\/enrollment(?:\/[^/]+)?$/.test(url.pathname)) result = await dashboardKioskEnrollment(request, env, decodeURIComponent(url.pathname.split("/")[3]), url.pathname.split("/")[5] ? decodeURIComponent(url.pathname.split("/")[5]) : undefined);
    else if (url.pathname === "/admin/kiosks/authentication-method" && request.method === "PATCH") result = await kioskAuthenticationConfiguration(request, env);
    else if (/^\/admin\/kiosks\/[^/]+\/authentication-method$/.test(url.pathname) && request.method === "PATCH") result = await kioskAuthenticationConfiguration(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/kiosks\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageKiosk(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/kiosks\/[^/]+\/commands$/.test(url.pathname) && request.method === "POST") result = await queueKioskCommand(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/kiosks\/[^/]+\/commands$/.test(url.pathname) && request.method === "GET") result = await kioskCommandStatus(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/meetings" && ["GET", "POST"].includes(request.method)) result = await meetings(request, env);
    else if (url.pathname === "/meeting-templates" && request.method === "GET") result = await meetingTemplates(request, env);
    else if (url.pathname === "/meetings/bulk-delete" && request.method === "POST") result = await bulkDeleteMeetings(request, env);
    else if (url.pathname === "/meetings/import" && request.method === "POST") result = await meetingImport(request, env);
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "GET") result = await meetingDetail(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+\/impact$/.test(url.pathname) && request.method === "POST") result = await meetingImpact(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeeting(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await deleteMeetings(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+\/restore$/.test(url.pathname) && request.method === "POST") result = await restoreMeetings(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meeting-series\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeetingSeries(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/attendance" && ["GET", "POST"].includes(request.method)) result = await attendance(request, env);
    else if (url.pathname === "/attendance/corrections" && request.method === "POST") result = await correction(request, env);
    else if (url.pathname === "/attendance/cleanup" && request.method === "POST") result = await cleanupAttendance(request, env);
    else if (url.pathname === "/reports/catalog" && request.method === "GET") result = await reportCatalog(request, env);
    else if (url.pathname === "/reports/views" && ["GET", "POST"].includes(request.method)) result = await savedReports(request, env);
    else if (/^\/reports\/views\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageSavedReport(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/reports/tabs" && request.method === "PUT") result = await savedReportTabs(request, env);
    else if (url.pathname === "/reports/leaderboard" && request.method === "GET") result = await leaderboardReport(request, env);
    else if (url.pathname === "/reports/query" && request.method === "POST") result = await customReportQuery(request, env);
    else if (url.pathname === "/reports/attendance" && request.method === "GET") result = await attendanceReport(request, env);
    else if (url.pathname === "/exports/report.csv" && request.method === "POST") result = await reportCsvExport(request, env);
    else if (url.pathname === "/exports/report-detail.csv" && request.method === "POST") result = await reportDetailCsvExport(request, env);
    else if (url.pathname === "/exports/attendance.csv" && request.method === "GET") result = await attendanceExport(request, env);
    else if (url.pathname === "/admin/integrations" && request.method === "GET") result = await integrationsStatus(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar" && ["PUT", "PATCH", "DELETE"].includes(request.method)) result = await googleCalendarConfiguration(request, env);
    else if (url.pathname === "/admin/integrations/notion" && ["GET", "PUT", "DELETE"].includes(request.method) || url.pathname.startsWith("/admin/integrations/notion/bindings/") && ["PUT", "DELETE"].includes(request.method)) result = await notionIntegration(request, env, url);
    else if (url.pathname === "/admin/integrations/first" && ["GET", "PUT", "DELETE"].includes(request.method) || ["/admin/integrations/first/lookup", "/admin/integrations/first/clear-cache"].includes(url.pathname) && request.method === "POST") result = await firstIntegration(request, env, url);
    else if (url.pathname === "/admin/integrations/google-calendar/authorize" && request.method === "GET") result = await googleCalendarStart(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/callback" && request.method === "GET") result = await googleCalendarCallback(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/calendars" && request.method === "GET") result = await listGoogleCalendars(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/select" && ["PUT", "PATCH"].includes(request.method)) result = await selectGoogleCalendar(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/retry" && request.method === "POST") result = await retryGoogleCalendarOperations(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/sync-all" && request.method === "POST") result = await syncAllGoogleCalendarMeetings(request, env);
    else if (url.pathname === "/admin/integrations/discord/calendar/sync-all" && request.method === "POST") result = await syncAllDiscordCalendarMeetings(request, env);
    else if (url.pathname === "/admin/integrations/discord/calendar/retry" && request.method === "POST") result = await retryDiscordCalendarOperations(request, env);
    else if (url.pathname === "/admin/integrations/discord/channel-manager" && ["GET", "PATCH"].includes(request.method)) result = await discordChannelManagerSettings(request, env);
    else if (url.pathname === "/admin/integrations/discord/anomaly-reports" && ["GET", "PATCH"].includes(request.method)) result = await discordAnomalyReportSettings(request, env);
    else if (url.pathname === "/integrations/capabilities" && request.method === "GET") result = await integrationCapabilities(request, env);
    else if (/^\/admin\/integrations\/(google|resend|discord)$/.test(url.pathname) && ["PUT", "PATCH", "DELETE"].includes(request.method)) result = await integrationConfiguration(request, env, providerFrom(url.pathname));
    else if (url.pathname === "/admin/integrations/resend/verify/start" && request.method === "POST") result = await startResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/resend/verify/complete" && request.method === "POST") result = await completeResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/discord/verify/start" && request.method === "POST") result = await startDiscordVerification(request, env);
    else if (url.pathname === "/admin/integrations/discord/commands/reconcile" && request.method === "POST") result = await reconcileDiscordCommands(request, env);
    else if (url.pathname === "/admin/integrations/discord/commands/check" && request.method === "POST") result = await checkDiscordCommands(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles" && request.method === "GET") result = await discordLabelMappings(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles" && request.method === "POST") result = await discordLabelLink(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/from-roles" && request.method === "POST") result = await discordLabelsFromRoles(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/preview-all" && request.method === "POST") result = await discordLabelPreviewAll(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/apply-all" && request.method === "POST") result = await discordLabelApplyAll(request, env, context);
    else if (url.pathname === "/admin/integrations/discord/roles" && request.method === "GET") result = await discordGuildRoles(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/preview" && request.method === "POST") result = await discordLabelPreview(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/two-way/preview" && request.method === "POST") result = await discordTwoWayPreview(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/two-way/confirm" && request.method === "POST") result = await discordTwoWayConfirm(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/unmatched" && request.method === "GET") result = await discordUnmatchedRoleMembers(request, env);
    else if (/^\/admin\/integrations\/discord\/label-roles\/[^/]+\/direction$/.test(url.pathname) && request.method === "PUT") result = await discordLabelDirection(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (url.pathname === "/admin/integrations/discord/label-roles/apply" && request.method === "POST") result = await discordLabelApply(request, env, context);
    else if (/^\/admin\/integrations\/discord\/label-roles\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await discordLabelUnlink(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+$/.test(url.pathname) && request.method === "GET") result = await discordLabelJobStatus(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+\/advance$/.test(url.pathname) && request.method === "POST") result = await discordLabelAdvance(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+\/retry$/.test(url.pathname) && request.method === "POST") result = await discordLabelRetry(request, env, decodeURIComponent(url.pathname.split("/")[5]), context);
    else if (url.pathname === "/admin/users" && ["GET", "POST"].includes(request.method)) result = await users(request, env);
    else if (/^\/admin\/users\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateUser(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/scheduler" && request.method === "GET" || ["/admin/scheduler/start", "/admin/scheduler/stop"].includes(url.pathname) && request.method === "POST") result = await platformScheduler(request, env, context);
    else if (url.pathname === "/communications/email" && request.method === "POST") result = await sendAttendanceEmail(request, env);
    else if (url.pathname === "/discord/interactions" && request.method === "POST") result = await discordInteraction(request, env);
    else if (url.pathname === "/discord/link" && request.method === "POST") result = await linkDiscordMember(request, env);
    else if (url.pathname === "/discord/missing" && request.method === "POST") result = await discordMissing(request, env);
    else if (url.pathname === "/discord/contests" && request.method === "GET") result = await discordContests(request, env);
    else if (["/discord/contests/accept", "/discord/contests/reject"].includes(url.pathname) && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin", "operator"]);
      if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Contest review requires the dashboard origin");
      await requireIntegrationConfigured(env, "discord");
      result = response(await (url.pathname.endsWith("/reject") ? rejectContestBatch : acceptContestBatch)(requireDatabase(env), principal.userId, await parseJson(request)));
    }
    else if (url.pathname === "/discord/contests/resolve" && request.method === "POST") result = await resolveDiscordContest(request, env);
    else if (url.pathname === "/discord/calendar" && request.method === "POST") result = await discordCalendar(request, env);
    else if (url.pathname === "/calendars/sync" && request.method === "POST") result = await syncMeetingCalendars(request, env);
    else if (url.pathname === "/discord/kiosk-status" && request.method === "POST") result = await discordKioskStatus(request, env);
    else if (url.pathname === "/admin/privacy" && ["GET", "PATCH"].includes(request.method)) result = await privacySettings(request, env);
    else if (url.pathname === "/admin/roster/history" && request.method === "GET") result = await rosterHistory(request, env);
    else if (url.pathname === "/admin/data/backup" && request.method === "GET") result = await backupData(request, env);
    else if (url.pathname === "/admin/data/restore" && request.method === "POST") result = await restoreData(request, env);
    else if (url.pathname.startsWith("/admin/data/backup/sessions")) result = await backupSessions(request, env, url.pathname);
    else if (url.pathname.startsWith("/admin/data/restore/sessions")) result = await restoreSessions(request, env, url.pathname);
    else if (url.pathname === "/admin/data" && request.method === "DELETE") result = await deleteData(request, env);
    else if (url.pathname === "/kiosk/pair" && request.method === "POST") result = await redeemPairingCode(request, env);
    else if (url.pathname === "/kiosk/fingerprint-review" || url.pathname.startsWith("/kiosk/fingerprint-review/")) {
      throw new HttpError(410, "Fingerprint identity review has been retired. Re-enroll fingerprints instead.");
    }
    else if (url.pathname === "/kiosk/fingerprint-reset" || url.pathname.startsWith("/kiosk/fingerprint-reset/")) {
      if (await webUpdateMaintenance(env)) throw new HttpError(503, "Fingerprint reset is suspended during installation update recovery");
      const kiosk = await kioskFor(request, env);
      const credentialHash = await sha256(request.headers.get("authorization")!.slice(7));
      result = await fingerprintResetRoute(request, { db: requireDatabase(env), actor: { kind: "kiosk", ...kiosk, credentialHash }, readJson: parseJson, respond: response });
    }
    else if (url.pathname === "/kiosk/fingerprint-vault" || url.pathname.startsWith("/kiosk/fingerprint-vault/")) {
      if (await webUpdateMaintenance(env)) throw new HttpError(503, "Fingerprint cloud storage is suspended during installation update recovery");
      const kiosk = await kioskFor(request, env);
      const credentialHash = await sha256(request.headers.get("authorization")!.slice(7));
      result = await fingerprintVaultRoute(request, { db: requireDatabase(env), actor: { kind: "kiosk", ...kiosk, credentialHash }, secret: env.FINGERPRINT_VAULT_KEY, readJson: parseJson, respond: response });
    }
    else if (url.pathname === "/kiosk/fingerprint-sync" || url.pathname.startsWith("/kiosk/fingerprint-sync/")) {
      await kioskFor(request, env);
      if (url.pathname === "/kiosk/fingerprint-sync" && request.method === "GET") result = response({ enabled: false, syncId: null });
      else throw new HttpError(410, "Peer fingerprint sharing has been retired. Use cloud fingerprint storage.");
    }
    else if (url.pathname === "/kiosk/poll" && request.method === "GET") {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Kiosk authentication required");
      result = await kioskPoll(request, { db: requireDatabase(env), credentialHash: await sha256(authorization.slice(7)), secret: env.FINGERPRINT_VAULT_KEY, respond: response });
    }
    else if (url.pathname === "/kiosk/enrollment" && request.method === "GET") result = response({ enrollment: await readKioskEnrollment(requireDatabase(env), (await kioskFor(request, env)).id) });
    else if (/^\/kiosk\/enrollment\/[^/]+\/progress$/.test(url.pathname) && request.method === "POST") result = await kioskEnrollmentProgress(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    // A fingerprint enrolled on the kiosk's own maintenance screen, which never passes through a dashboard session.
    else if (url.pathname === "/kiosk/fingerprint-enrollments" && request.method === "POST") {
      const kiosk = await kioskFor(request, env);
      result = response(await recordLocalFingerprintEnrollment(requireDatabase(env), kiosk, await parseJson(request, 4096)));
    }
    else if (url.pathname === "/kiosk/scan-reviews" && request.method === "POST") {
      const kiosk = await kioskFor(request, env);
      result = response(await syncKioskScanReviews(requireDatabase(env), { ...kiosk, tokenHash: await sha256(request.headers.get("authorization")!.slice(7)) }, await parseJson(request, 100_000)));
    }
    else if (url.pathname === "/admin/kiosks/scan-reviews" && request.method === "GET") {
      await requireRole(request, env, ["admin"]);
      result = response(await listKioskScanReviews(requireDatabase(env), url.searchParams.get("status") ?? "open", Number(url.searchParams.get("offset") ?? 0), url.searchParams.get("kioskId") ?? "", url.searchParams.get("reasonCode") ?? ""));
    }
    else if (url.pathname === "/admin/kiosks/scan-reviews/review" && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin"]);
      if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Scan review requires the dashboard origin");
      result = response(await markKioskScansReviewed(requireDatabase(env), principal.userId, await parseJson(request, 150_000)));
    }
    else if (/^\/admin\/kiosks\/[^/]+\/scan-reviews\/[^/]+\/review$/.test(url.pathname) && request.method === "POST") {
      const principal = await requireRole(request, env, ["admin"]);
      if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Scan review requires the dashboard origin");
      result = response(await markKioskScanReviewed(requireDatabase(env), principal.userId, decodeURIComponent(url.pathname.split("/")[3]), decodeURIComponent(url.pathname.split("/")[5]), await parseJson(request)));
    }
    else if (url.pathname === "/kiosk/heartbeat" && request.method === "POST") result = await kioskHeartbeat(request, env, context);
    else if (url.pathname === "/kiosk/config" && request.method === "GET") result = await kioskConfiguration(request, env);
    else if (url.pathname === "/kiosk/roster" && request.method === "GET") result = await kioskRoster(request, env);
    else if (url.pathname === "/kiosk/commands" && request.method === "GET") result = await pendingKioskCommand(request, env);
    else if (/^\/kiosk\/commands\/[^/]+\/result$/.test(url.pathname) && request.method === "POST") result = await completeKioskCommand(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/kiosk/attendance" && request.method === "POST") result = await kioskAttendance(request, env);
    else if (/^\/kiosk\/(?:pin-failures|pin-requests(?:\/[^/]+(?:\/pin)?)?|pins(?:\/[^/]+\/reset)?)$/.test(url.pathname)) {
      const kiosk = await kioskFor(request, env);
      result = await kioskPinRoute(request, url.pathname, { db: requireDatabase(env), kiosk, readJson: parseJson, respond: response }) ?? response({ error: "Not found" }, 404);
    }
    else result = response({ error: "Not found" }, 404);
  } catch (error) {
    const handled = error instanceof HttpError || error instanceof WebUpdateError;
    const status = handled ? error.status : 500;
    // Unexpected error text (D1, SQL or provider internals) stays in Worker logs; callers get only a correlation ID.
    const errorId = handled ? undefined : crypto.randomUUID();
    if (errorId) console.error(JSON.stringify({ event: "api_error", errorId, path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
    result = response({ error: handled ? error.message : "Request failed", details: error instanceof HttpError ? error.details : undefined, ...(error instanceof HttpError ? error.extra : undefined), ...(error instanceof WebUpdateError ? { code: error.code } : error instanceof HttpError && error.code ? { code: error.code } : {}), ...(errorId ? { errorId } : {}) }, status);
  }
  const queuedWork = result.status < 400 && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !previewResponses.has(result);
  if (privateModuleResponse(url.pathname)) {
    const headers = new Headers(result.headers); headers.set("cache-control", "no-store, private, max-age=0"); headers.set("pragma", "no-cache"); headers.set("expires", "0"); headers.set("x-robots-tag", "noindex, nofollow");
    result = new Response(result.body, { status: result.status, headers });
  }
  if (queuedWork) pokeScheduler(env, context, schedulerPokesFor(url.pathname));
  const measured = usage?.snapshot();
  if (measured && (measured.measuredRowsRead >= 100 || usageCategory(url.pathname) === "/reports")) console.log(JSON.stringify({ event: "d1_usage", category: usageCategory(url.pathname), status: result.status, ...measured }));
  return withCors(result, request, env);
}, async scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron !== undefined && controller.cron !== "*/5 * * * *") return;
  if (durableScheduler(env)) {
    // With the Durable Object the cron is only a watchdog: it re-arms a missing alarm and does no job work itself.
    try { await schedulerObject(env)!.fetch(schedulerRequest("watchdog")); } catch { /* The next tick tries again. */ }
    return;
  }
  // The cron fallback is the runner. A bound object (the fallback was forced) is told to stand down first: that drops an
  // alarm armed before the switch and waits for a slice still in flight, so the two never run jobs at once. An object
  // that cannot be reached is not running slices either, and one that can stands down by itself when its alarm fires.
  // This request is the invocation's one subrequest outside the pass budget.
  try { await schedulerObject(env)?.fetch(schedulerRequest("standdown")); } catch { /* The pass's claim and the object's own check still apply. */ }
  // One slice for each due job, within one pass budget, starting one job later each tick so a job the budget defers
  // leads a later tick. A job due within a minute of the tick runs now rather than a tick later.
  const scheduledTime = controller.scheduledTime;
  await runSchedulerPass(env, { now: Date.now(), maxJobs: registeredPlatformSchedulerJobs.length, limits: scheduledPassLimits, slack: 60_000, order: scheduledTime === undefined ? 0 : passSlot(scheduledTime) });
} };
export default worker;
