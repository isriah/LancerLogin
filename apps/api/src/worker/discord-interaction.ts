import { issueDiscordKioskCode } from "../discord-kiosk-codes.ts";
import { submitContest } from "../contest-review.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { dispatchModuleDiscordCommand } from "../module-discord.ts";
import { type Env, requireDatabase, response, sha256, writeAudit } from "./core.ts";
import { attendanceDiscordDatabase, discordAttendanceReport, discordEphemeral, verifyDiscordInteraction } from "./discord-contests.ts";
import { discordInteractionConfiguration } from "./discord-core.ts";
import { discordLabelAdmin, discordManageableRole, discordSnowflake } from "./discord-label-roles.ts";
import { linkedAbsentMembers } from "./discord-notifications.ts";
import { markIntegrationVerified } from "./integration-support.ts";

export async function discordInteraction(request: Request, env: Env): Promise<Response> {
  const { config, record } = await discordInteractionConfiguration(env); const raw = await request.text();
  if (!await verifyDiscordInteraction(request, config, raw)) throw new HttpError(401, "Discord interaction signature is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return discordEphemeral("This Discord request is malformed. Try the command again, or ask an Operator for help."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return discordEphemeral("This Discord request is malformed. Try the command again, or ask an Operator for help.");
  const interaction = parsed as { id?: string; type?: number; guild_id?: string; channel_id?: string; data?: { custom_id?: string; name?: string; options?: { name?: string; value?: string }[] }; member?: { user?: { id?: string } }; user?: { id?: string }; message?: { id?: string } };
  if (interaction.type === 1) return response({ type: 1 });
  const customId = interaction.data?.custom_id ?? ""; const rawDiscordUserId = interaction.member?.user?.id ?? interaction.user?.id; const discordUserId = typeof rawDiscordUserId === "string" && /^\d{10,24}$/.test(rawDiscordUserId) ? rawDiscordUserId : undefined; const messageId = interaction.message?.id; const db = requireDatabase(env);
  if (record.enabled === 0) return discordEphemeral("LancerLogin's Discord integration is disabled. Ask an Admin to enable and verify it before trying again.");
  if (interaction.type === 3 && customId.startsWith("lancerlogin-verify:") && discordUserId && messageId) {
    const token = customId.slice("lancerlogin-verify:".length);
    const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, external_id AS externalId, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord'").first<{ challengeHash: string; target: string; externalId: string; expiresAt: string }>();
    if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(token) || challenge.externalId !== messageId || challenge.target !== interaction.guild_id) return discordEphemeral("This LancerLogin verification request is invalid or expired. Start verification again from the dashboard.");
    await markIntegrationVerified(db, "discord", null, { discordUserId, guildId: interaction.guild_id, messageId });
    return discordEphemeral("LancerLogin is verified. You can return to the dashboard.");
  }
  if (!record?.verifiedAt) return discordEphemeral("This LancerLogin Discord integration has not been verified by an Admin.");
  if (interaction.type === 2 && interaction.data?.name && bundledModuleRegistry.discordCommandOwner(interaction.data.name)) {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this command in the Discord server configured for this LancerLogin installation.");
    try {
      const content = await dispatchModuleDiscordCommand(db, interaction);
      if (content) return discordEphemeral(content);
    } catch (error) {
      return discordEphemeral(error instanceof HttpError ? error.message : "This module command could not be completed. Try again or ask an Operator for help.");
    }
  }
  if (interaction.type === 2 && interaction.data?.name === "label") {
    if (interaction.guild_id !== config.guildId || !discordUserId) return discordEphemeral("Use /label in the configured Discord server with a paired Admin account.");
    try {
      const admin = await discordLabelAdmin(db, discordUserId);
      const roleId = interaction.data.options?.find((option) => option.name === "role")?.value;
      if (!discordSnowflake(roleId)) return discordEphemeral("Choose a Discord role with /label @ROLE.");
      const role = await discordManageableRole(config, roleId);
      const label = await db.prepare("SELECT id, name FROM member_labels WHERE installation_id = 'primary' AND active = 1 AND name = ? COLLATE NOCASE").bind(role.name).first<{ id: string; name: string }>();
      if (!label) return discordEphemeral(`No active LancerLogin label exactly matches the role ${role.name}. No association was made.`);
      const conflict = await db.prepare("SELECT label_id AS labelId, role_id AS roleId FROM discord_label_role_mappings WHERE installation_id = 'primary' AND (label_id = ? OR (guild_id = ? AND role_id = ?))").bind(label.id, config.guildId, roleId).first<{ labelId: string; roleId: string }>();
      if (conflict) return discordEphemeral(conflict.labelId === label.id && conflict.roleId === roleId ? "That label and Discord role are already associated." : "That label or Discord role is already associated with a different counterpart. Unlink it in Settings first.");
      const token = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      await db.prepare("INSERT INTO discord_label_role_challenges (id_hash, installation_id, label_id, guild_id, role_id, discord_user_id, expires_at, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(await sha256(token), label.id, config.guildId, roleId, discordUserId, expiresAt, now.toISOString()).run();
      await writeAudit(db, admin, "discord.label_role_association_offered", "member_label", label.id, { roleId, guildId: config.guildId });
      return response({ type: 4, data: { content: `Associate Discord role **${role.name}** with LancerLogin label **${label.name}**? This saves the mapping. Role assignments change only when an Admin runs Sync to Discord in the dashboard.`, flags: 64, allowed_mentions: { parse: [] }, components: [{ type: 1, components: [{ type: 2, style: 1, label: "Confirm association", custom_id: `lancerlogin-label:${token}` }] }] } });
    } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "The label association could not be prepared. Try again or ask an Admin to check the integration."); }
  }
  if (interaction.type === 3 && customId.startsWith("lancerlogin-label:")) {
    if (interaction.guild_id !== config.guildId || !discordUserId) return discordEphemeral("This label confirmation is invalid for this server.");
    try {
      const admin = await discordLabelAdmin(db, discordUserId);
      const token = customId.slice("lancerlogin-label:".length);
      if (!/^[0-9a-f-]{36}$/.test(token)) return discordEphemeral("This label confirmation is invalid or expired. Run /label again.");
      const hash = await sha256(token); const challenge = await db.prepare("SELECT label_id AS labelId, guild_id AS guildId, role_id AS roleId, discord_user_id AS discordUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_role_challenges WHERE installation_id = 'primary' AND id_hash = ?").bind(hash).first<{ labelId: string; guildId: string; roleId: string; discordUserId: string; expiresAt: string; usedAt?: string }>();
      if (!challenge || challenge.discordUserId !== discordUserId || challenge.guildId !== config.guildId || challenge.usedAt || challenge.expiresAt <= new Date().toISOString()) return discordEphemeral("This label confirmation is invalid or expired. Run /label again.");
      const role = await discordManageableRole(config, challenge.roleId);
      const label = await db.prepare("SELECT id, name FROM member_labels WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(challenge.labelId).first<{ id: string; name: string }>();
      if (!label || label.name.toLocaleLowerCase() !== role.name.toLocaleLowerCase()) return discordEphemeral("The label or Discord role changed. Run /label again.");
      const conflict = await db.prepare("SELECT label_id FROM discord_label_role_mappings WHERE installation_id = 'primary' AND (label_id = ? OR (guild_id = ? AND role_id = ?))").bind(label.id, config.guildId, role.id).first();
      if (conflict) return discordEphemeral("That label or role is already associated. Review it in Settings.");
      const now = new Date().toISOString(); const claimed = await db.prepare("UPDATE discord_label_role_challenges SET used_at = ? WHERE installation_id = 'primary' AND id_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, hash, now).run();
      if ((claimed.meta?.changes ?? 0) !== 1) return discordEphemeral("This confirmation was already used. Run /label again.");
      try { await db.prepare("INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_by, created_at) VALUES ('primary', ?, ?, ?, ?, ?, ?)").bind(label.id, config.guildId, role.id, role.name, admin.userId, now).run(); }
      catch (error) { if (/unique|constraint/i.test(String(error))) return discordEphemeral("That label or role was associated by another Admin. Review it in Settings."); throw error; }
      await writeAudit(db, admin, "discord.label_role_associated", "member_label", label.id, { guildId: config.guildId, roleId: role.id });
      return discordEphemeral(`Associated **${label.name}** with **${role.name}**. Review and run Sync to Discord in Settings when ready.`);
    } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "The label association could not be saved. Try again or ask an Admin to check the integration."); }
  }
  if (interaction.type === 2 && interaction.data?.name === "attendance-report") {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this command in the Discord server configured for this LancerLogin installation.");
    if (!discordUserId || interaction.data.options !== undefined && (!Array.isArray(interaction.data.options) || interaction.data.options.length > 0)) return discordEphemeral("This attendance-report request is malformed. Try /attendance-report again, or ask an Operator for help.");
    try { return discordEphemeral(await discordAttendanceReport(await attendanceDiscordDatabase(db), discordUserId)); }
    catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "Attendance is unavailable. Ask an Admin to review the module."); }
  }
  if (interaction.type === 2 && interaction.data?.name === "code") {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this command in the Discord server configured for this LancerLogin installation.");
    if (!discordUserId || interaction.data.options !== undefined && (!Array.isArray(interaction.data.options) || interaction.data.options.length > 0)) return discordEphemeral("This code request is malformed. Try /code again, or ask an Operator for help.");
    try { return discordEphemeral(await issueDiscordKioskCode(await attendanceDiscordDatabase(db), discordUserId)); }
    catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "Attendance is unavailable. Ask an Admin to review the module."); }
  }
  if (interaction.type === 3 && customId === "lancerlogin-attendance-report") {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this button in the Discord server configured for this LancerLogin installation.");
    if (!discordUserId || !messageId || interaction.channel_id !== config.channelId) return discordEphemeral("This attendance-report button is invalid or expired. Ask an Operator for help.");
    try {
      const attendanceDb = await attendanceDiscordDatabase(db);
      const manager = await attendanceDb.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
      const tracked = await attendanceDb.prepare("SELECT external_id AS externalId FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'channel-manager-howto'").first<{ externalId?: string }>();
      if (!manager?.enabled || !tracked?.externalId || tracked.externalId !== messageId) return discordEphemeral("This attendance-report button is invalid or expired. Ask an Operator for help.");
      return discordEphemeral(await discordAttendanceReport(attendanceDb, discordUserId));
    } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "Attendance is unavailable. Ask an Admin to review the module."); }
  }
  if (interaction.type === 2 && interaction.data?.name === "pair" && discordUserId && interaction.guild_id === config.guildId) {
    const memberId = interaction.data.options?.find((option) => option.name === "member-id")?.value?.trim();
    if (!memberId || memberId.length > 80) return discordEphemeral("Provide your LancerLogin member ID with /pair. Ask an Operator for help if you need it.");
    const member = await db.prepare("SELECT id, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' AND external_id = ?").bind(memberId).first<{ id: string; discordUserId?: string; active: number }>();
    if (!member || !member.active || member.discordUserId) return discordEphemeral("That member ID cannot be paired. Ask an Operator for help.");
    const existing = await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND discord_user_id = ?").bind(discordUserId).first<{ id: string }>();
    if (existing) return discordEphemeral("This Discord account is already paired. Ask an Operator for help.");
    await db.batch([
      db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ? AND active = 1 AND discord_user_id IS NULL").bind(discordUserId, member.id),
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', NULL, 'discord.member_self_paired', 'member', ?, ?, ?)").bind(crypto.randomUUID(), member.id, JSON.stringify({ discordUserId }), new Date().toISOString()),
    ]);
    return discordEphemeral("Your Discord account is now paired with your LancerLogin roster entry.");
  }
  const meetingId = customId.startsWith("lancerlogin-attendance:") ? customId.slice("lancerlogin-attendance:".length) : "";
  if (interaction.type !== 3 || !meetingId || !discordUserId || !messageId) return discordEphemeral("This attendance contest button is invalid or expired. Ask an Operator for help.");
  try {
    const attendanceDb = await attendanceDiscordDatabase(db);
    const recipient = await attendanceDb.prepare("SELECT r.member_id AS memberId, r.delivered_at AS deliveredAt FROM discord_attendance_recipients r JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE r.installation_id = 'primary' AND r.meeting_id = ? AND r.message_id = ? AND r.discord_user_id = ? AND m.discord_user_id = ? AND m.active = 1").bind(meetingId, messageId, discordUserId, discordUserId).first<{ memberId: string; deliveredAt: string }>();
    if (!recipient) return discordEphemeral("This notice does not match your current linked roster account. Use a notice sent after your Discord link was saved, or ask an Operator for help.");
    const contestWindow = await attendanceDb.prepare("SELECT discord_contest_window_hours AS discordContestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ discordContestWindowHours?: number }>();
    if (!Number.isFinite(Date.parse(recipient.deliveredAt)) || Date.now() > Date.parse(recipient.deliveredAt) + (contestWindow?.discordContestWindowHours ?? 24) * 3_600_000) return discordEphemeral("This absence notice has expired. Ask an Operator to review your attendance.");
    if (!(await linkedAbsentMembers(attendanceDb, meetingId)).some((member) => member.id === recipient.memberId)) return discordEphemeral("Attendance no longer shows you as absent, so no contest was created.");
    await submitContest(attendanceDb, { meetingId, memberId: recipient.memberId, messageId, discordUserId, now: new Date().toISOString() });
    const contest = await attendanceDb.prepare("SELECT status FROM discord_attendance_contests WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ?").bind(meetingId, recipient.memberId).first<{ status: string }>();
    return contest?.status === "open" ? discordEphemeral("Your attendance contest was recorded for review. Your attendance has not been changed.") : discordEphemeral(`Your attendance contest was already reviewed with status ${contest?.status ?? "unknown"}.`);
  } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "Attendance is unavailable. Ask an Admin to review the module."); }
}
