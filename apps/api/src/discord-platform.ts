import { providerFetch, bindProviderScope } from './maintenance.ts';
import type { Env } from "./index.ts";
import { decryptIntegration } from "./integration-crypto.ts";
import { SchedulerBudget, schedulerBudgetKey } from "./scheduler-budget.ts";
import { HttpError } from "./http-error.ts";
type IntegrationRecord = { id: string; ciphertext: string; iv: string; updatedAt: string; verifiedAt?: string | null; enabled?: number };
async function discordRecord(env: Env): Promise<IntegrationRecord | null> {
  if (!env.DB) throw new HttpError(503, "Database is not configured");
  return env.DB.prepare("SELECT i.id, i.ciphertext, i.iv, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, x.discord_enabled AS enabled FROM encrypted_integrations i JOIN installations x ON x.id = i.installation_id WHERE i.installation_id = 'primary' AND i.provider = ?").bind("discord").first<IntegrationRecord>();
}
export async function readDiscordBody(message: Request | Response, limit = 65_536, deadlineMs = message instanceof Request ? 1500 : 10000): Promise<string> {
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw new HttpError(400,"Invalid Discord read deadline");
  const reader = message.body?.getReader(); if (!reader) return "";
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(message instanceof Request?408:502,"Discord payload read timed out")),deadlineMs);});
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await Promise.race([reader.read(),deadline]); if (done) break; bytes += value.byteLength; if (bytes > limit) throw new HttpError(message instanceof Request ? 413 : 502, "Discord payload exceeds the supported limit"); chunks.push(value); } }
  catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally{clearTimeout(timer);reader.releaseLock();}
  const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(result); } catch { throw new HttpError(400, "Discord payload is malformed"); }
}
export class DiscordPermissionError extends HttpError {
  constructor(kind: "calendar" | "pin" | "commands" | "channel" = "channel") { super(502, kind === "calendar" ? "Discord denied this request because the bot is missing a required permission. Confirm it is in the selected server and has Manage Events permission before syncing the calendar." : kind === "pin" ? "Discord denied this request because the bot is missing Pin Messages permission in the configured attendance channel." : kind === "commands" ? "Discord denied command management. Confirm the saved application ID belongs to this bot and install the bot in the selected server before trying command setup again." : "Discord denied this request because the bot is missing a required permission. Confirm the bot can access the selected server and channel."); }
}
export class DiscordRateLimitError extends HttpError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, operation = "calendar sync") { super(503, `Discord is rate limiting ${operation}. Wait ${Math.ceil(retryAfterMs / 1000)} seconds before trying again.`); this.retryAfterMs = retryAfterMs; }
}
export class DiscordResponseError extends HttpError {
  readonly discordStatus: number;
  readonly discordCode?: number;
  constructor(status: number, message: string, code?: number) { super(502, `Discord rejected the request (${status})${message ? `: ${message}` : ""}`); this.discordStatus = status; this.discordCode = code; }
}
export async function discordConfiguration(env: Env, allowUnverified = false): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await discordRecord(env); if (!record || record.enabled === 0) throw new HttpError(503, "Discord is not enabled");
  if (!allowUnverified && !record.verifiedAt) throw new HttpError(503, "Discord verification is required before using attendance workflows");
  const config = await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
  if (env[schedulerBudgetKey]) Object.defineProperty(config, schedulerBudgetKey, { value: env[schedulerBudgetKey] });
  return bindProviderScope(config,env);
}
export async function discordInteractionConfiguration(env: Env): Promise<{ config: Record<string, string>; record: IntegrationRecord }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await discordRecord(env);
  if (!record) throw new HttpError(503, "Discord credentials are not configured");
  return { config: bindProviderScope(await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY),env), record };
}
const discordRetryDelay = (response: Response, body: Record<string, unknown>) => {
  const bodyValue = body.retry_after;
  const headerValue = response.headers.get("retry-after");
  const retryAfter = typeof bodyValue === "number" ? bodyValue : headerValue === null ? NaN : Number(headerValue);
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter * 1_000) : 1_000;
};
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export async function discordRequest<T = Record<string, unknown>>(config: Record<string, string>, path: string, init: RequestInit, retry = true, env?: Env): Promise<{ response: globalThis.Response; body: T }> {
  if (!/^\/(oauth2|users|guilds|channels|applications)\//.test(path) || /[\\#]/.test(path) || /(?:\.\.|%2e)/i.test(path)) throw new HttpError(400, "Invalid Discord operation path");
  const managesCommands = path.includes("/commands");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    (config as unknown as { [schedulerBudgetKey]?: SchedulerBudget })[schedulerBudgetKey]?.request();
    const result = await providerFetch(env??config)(`https://discord.com/api/v10${path}`, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), redirect: "manual", headers: { ...init.headers, authorization: `Bot ${config.botToken}`, "content-type": "application/json" } });
    if (result.status >= 300 && result.status < 400) throw new DiscordResponseError(result.status, "Discord returned an unexpected redirect");
    const raw = await readDiscordBody(result, 1_048_576);
    let body: T; try { body = (raw ? JSON.parse(raw) : {}) as T; } catch { throw new HttpError(502, "Discord returned a malformed response"); }
    if (result.ok) return { response: result, body };
    const errorBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (result.status === 401) throw new HttpError(502, "Discord rejected the saved bot token. Reset the token in Discord, replace the saved credentials, and try verification again.");
    if (result.status === 403) throw new DiscordPermissionError(path.includes("/scheduled-events") ? "calendar" : path.includes("/messages/pins/") ? "pin" : managesCommands ? "commands" : "channel");
    if (result.status === 429) {
      const retryAfterMs = discordRetryDelay(result, errorBody);
      if (!retry || attempt === 2 || retryAfterMs > 5_000) throw new DiscordRateLimitError(retryAfterMs, managesCommands ? "command setup" : path.includes("/scheduled-events") ? "calendar sync" : "this request");
      await wait(retryAfterMs);
      continue;
    }
    if (managesCommands && result.status === 404) throw new HttpError(502, "Discord could not find that application in the selected server. Confirm the Application ID and Server ID, reinstall the bot if needed, and try verification again.");
    if (managesCommands && result.status === 400) throw new HttpError(502, "Discord rejected the managed command configuration. Confirm the Application ID and Server ID, then try verification again.");
    const message = "Provider operation failed";
    const code = Number(errorBody.code);
    throw new DiscordResponseError(result.status, message, Number.isFinite(code) ? code : undefined);
  }
  throw new HttpError(502, "Discord request did not complete");
}
export type DiscordApplicationCommand = { id?: string; application_id?: string; guild_id?: string; name?: string; type?: number; description?: string; options?: { name?: string; description?: string; type?: number; required?: boolean }[] };
const attendanceCommands: DiscordApplicationCommand[] = [
  { name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] },
  { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" },
];
export const attachmentProofCommands: DiscordApplicationCommand[]=[{name:"attachment-proof",type:1,description:"Transfer the provided synthetic fixture to private development Drive"}];
export const documentationCommands: DiscordApplicationCommand[] = [{name:"activity-note",type:1,description:"Privately submit an activity Documentation note"},{name:"activity-file",type:1,description:"Privately submit an activity Documentation file"}];
export const hoursCommands: DiscordApplicationCommand[] = [
  {name:"hours",type:1,description:"Privately record completed LancerLogin service hours"},
  {name:"hours-correction",type:1,description:"Privately request a correction to your LancerLogin hours"},
];
export function composeDiscordCommands(contributions: { owner: string; commands: DiscordApplicationCommand[] }[] = [{ owner: "attendance", commands: attendanceCommands }]): DiscordApplicationCommand[] {
  const names = new Set<string>(); const result: DiscordApplicationCommand[] = [];
  if (!Array.isArray(contributions) || contributions.length > 8) throw new HttpError(400, "Invalid Discord command contributions");
  for (const contribution of contributions) {
    if (!["attendance","hours","attachment-proof","documentation"].includes(contribution?.owner) || !Array.isArray(contribution.commands) || contribution.commands.length > 8) throw new HttpError(400, "Discord contribution owner is not implemented");
    for (const command of contribution.commands) {
      const implemented = (contribution.owner==='attendance'?attendanceCommands:contribution.owner==='hours'?hoursCommands:contribution.owner==='documentation'?documentationCommands:attachmentProofCommands).find(item => item.name === command?.name);
      if (!implemented || command.type !== 1 || JSON.stringify(command) !== JSON.stringify(implemented) || names.has(command.name!)) throw new HttpError(400, "Invalid or duplicate Discord command contribution");
      names.add(command.name!); result.push(structuredClone(command));
    }
  }
  if (attendanceCommands.some(core=>!result.some(item=>item.name===core.name))) throw new HttpError(400, "Core Discord commands are required");
  return result;
}
function commandInventory(value: unknown, config: Record<string, string>): DiscordApplicationCommand[] {
  if (!Array.isArray(value) || value.length > 110 || value.some(command => !command || typeof command !== "object" || !/^\d{10,24}$/.test(command.id ?? "") || command.application_id !== config.applicationId || command.guild_id !== config.guildId || typeof command.name !== "string" || command.name.length > 32 || ![1, 2, 3].includes(command.type)
    || (command.options !== undefined && (!Array.isArray(command.options) || command.options.length > 25 || command.options.some((option: unknown) => !option || typeof option !== "object" || Array.isArray(option)))))) throw new HttpError(502, "Discord returned a malformed command inventory");
  if (new Set(value.map(command => command.id)).size !== value.length || new Set(value.map(command => `${command.type}:${command.name}`)).size !== value.length) throw new HttpError(502, "Discord returned duplicate command identities");
  return value;
}
function discordCommandMatches(actual: DiscordApplicationCommand, expected: DiscordApplicationCommand, config: Record<string, string>): boolean {
  const optionShape = (option: NonNullable<DiscordApplicationCommand["options"]>[number]) => ({ name: option.name, description: option.description, type: option.type, required: Boolean(option.required), unsupported: Object.entries(option).some(([key, value]) => !["name", "description", "type", "required", "name_localizations", "description_localizations"].includes(key) && value !== false && value !== null) });
  return actual.application_id === config.applicationId && actual.guild_id === config.guildId && actual.name === expected.name && actual.type === expected.type && actual.description === expected.description && JSON.stringify((actual.options ?? []).map(optionShape)) === JSON.stringify((expected.options ?? []).map(optionShape));
}
export async function reconcileDiscordApplicationCommands(config: Record<string, string>, hoursEnabled=false, attachmentProofEnabled=false, documentationEnabled=false, env?: Env): Promise<{ applicationId: string; commands: string[] }> {
  const discordManagedCommands = composeDiscordCommands([{owner:'attendance',commands:attendanceCommands},...(hoursEnabled?[{owner:'hours',commands:hoursCommands}]:[]),...(attachmentProofEnabled?[{owner:'attachment-proof',commands:attachmentProofCommands}]:[]),...(documentationEnabled?[{owner:'documentation',commands:documentationCommands}]:[])]);
  const application = await discordRequest<{ id?: string }>(config, "/oauth2/applications/@me", { method: "GET" }, undefined, env);
  const applicationId = String(application.body.id ?? "");
  if (!/^\d{10,24}$/.test(applicationId)) throw new HttpError(502, "Discord did not return the bot application's identity. Confirm the saved bot token and try command reconciliation again.");
  if (config.applicationId && applicationId !== config.applicationId) throw new HttpError(400, "The saved Application ID does not belong to this bot token. Copy the Application ID from the same Discord application and replace the saved credentials.");
  const resolvedConfig = { ...config, applicationId };
  const guild = await discordRequest<{ id?: string }>(config, `/guilds/${encodeURIComponent(config.guildId)}`, { method: "GET" }, undefined, env);
  if (String(guild.body.id ?? "") !== config.guildId) throw new HttpError(400, "Discord returned a different server than the saved Server ID. Copy the intended server ID and replace the saved credentials.");
  const channel = await discordRequest<{ guild_id?: string; type?: number }>(config, `/channels/${encodeURIComponent(config.channelId)}`, { method: "GET" }, undefined, env);
  if (String(channel.body.guild_id ?? "") !== config.guildId || Number(channel.body.type) !== 0) throw new HttpError(400, "The attendance channel must be a text channel in the saved Discord server. Copy the intended channel and server IDs, then replace the saved credentials.");
  const path = `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(config.guildId)}/commands`;
  const before = commandInventory((await discordRequest(config, path, { method: "GET" }, undefined, env)).body, resolvedConfig);
  const unrelated = before.filter(actual => !discordManagedCommands.some(expected => actual.type === expected.type && actual.name === expected.name));
  for (const expected of discordManagedCommands) {
    const actual = before.find(item => item.type === expected.type && item.name === expected.name);
    if (actual && discordCommandMatches(actual, expected, resolvedConfig)) continue;
    // POST is Discord's name/type upsert; PATCH targets only a validated managed ID.
    // No collection PUT or DELETE: unrelated commands remain provider-owned.
    await discordRequest(config, actual ? `${path}/${actual.id}` : path, { method: actual ? "PATCH" : "POST", body: JSON.stringify({ ...expected, options: expected.options ?? [] }) }, undefined, env);
  }
  const after = commandInventory((await discordRequest(config, path, { method: "GET" }, undefined, env)).body, resolvedConfig);
  if (discordManagedCommands.some(expected => !after.some(actual => discordCommandMatches(actual, expected, resolvedConfig)))
    || unrelated.some(previous => !after.some(actual => actual.id === previous.id && JSON.stringify(actual) === JSON.stringify(previous)))) {
    throw new HttpError(502, "Discord did not confirm both managed commands and preserved unrelated commands. Wait briefly and try command setup again.");
  }
  return { applicationId, commands: discordManagedCommands.map((command) => String(command.name)) };
}
function hexBytes(value: string): Uint8Array { if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value"); return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)); }
const byteBuffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
export async function verifyDiscordInteraction(request: Request, config: Record<string, string>, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519"); const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !/^[a-f0-9]{128}$/i.test(signature) || !/^[a-f0-9]{64}$/i.test(config.publicKey ?? "") || new TextEncoder().encode(body).length > 65_536 || !timestamp || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", byteBuffer(hexBytes(config.publicKey)), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, byteBuffer(hexBytes(signature)), byteBuffer(new TextEncoder().encode(timestamp + body)));
  } catch { return false; }
}

/** Only wrap read-only admission: timed-out work must never mutate afterwards. */
export async function discordReadDeadline<T>(read:Promise<T>,deadline:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(408,"Discord admission timed out")),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}
}
