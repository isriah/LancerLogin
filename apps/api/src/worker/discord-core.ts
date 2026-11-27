import { HttpError } from "../http-error.ts";
import { DiscordRateLimitError, discordRateLimitFailsFast, discordRateLimitOperation } from "../discord-rate-limit.ts";
import { DiscordPermissionError, DiscordResponseError, DiscordTokenError, type Env, type ProviderConfiguration, moduleProviderAuthority, providerConfiguration, readIntegrationSecret } from "./core.ts";
import { type IntegrationRecord, integrationRecord } from "./integration-support.ts";

export async function discordConfiguration(env: Env, allowUnverified = false): Promise<ProviderConfiguration> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "discord"); if (!record || record.enabled === 0) throw new HttpError(503, "Discord is not enabled");
  if (!allowUnverified && !record.verifiedAt) throw new HttpError(503, "Discord verification is required before using attendance workflows");
  return providerConfiguration(await readIntegrationSecret(env, "discord", record.ciphertext, record.iv), env);
}
export async function discordInteractionConfiguration(env: Env): Promise<{ config: ProviderConfiguration; record: IntegrationRecord }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "discord");
  if (!record) throw new HttpError(503, "Discord credentials are not configured");
  return { config: providerConfiguration(await readIntegrationSecret(env, "discord", record.ciphertext, record.iv), env), record };
}
const discordRetryDelay = (response: Response, body: Record<string, unknown>) => {
  const bodyValue = body.retry_after;
  const retryAfter = typeof bodyValue === "number" ? bodyValue : Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter * 1_000) : 1_000;
};
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
/** `operation` names the feature in a rate-limit message; by default it follows the path, and module calls pass a neutral one. */
export async function discordRequest<T = Record<string, unknown>>(config: ProviderConfiguration, path: string, init: RequestInit, operation = discordRateLimitOperation(path)): Promise<{ response: globalThis.Response; body: T }> {
  const managesCommands = path.includes("/commands");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await config[moduleProviderAuthority]?.();
    const result = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers: { authorization: `Bot ${config.botToken}`, "content-type": "application/json", ...init.headers } });
    const body = await result.json().catch(() => ({})) as T;
    if (result.ok) return { response: result, body };
    const errorBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (result.status === 401) throw new DiscordTokenError();
    if (result.status === 403) throw new DiscordPermissionError(path.includes("/scheduled-events") ? "calendar" : path.includes("/messages/pins/") ? "pin" : managesCommands ? "commands" : path.includes("/members/") && /\/roles\//.test(path) ? "roles" : /\/members(?:\?|$)/.test(path) ? "members" : "channel");
    if (result.status === 429) {
      const retryAfterMs = discordRetryDelay(result, errorBody);
      if (discordRateLimitFailsFast(path, retryAfterMs) || attempt === 2) throw new DiscordRateLimitError(retryAfterMs, operation);
      await wait(retryAfterMs);
      continue;
    }
    if (managesCommands && result.status === 404) throw new HttpError(502, "Discord could not find that application in the selected server. Confirm the Application ID and Server ID, reinstall the bot if needed, and try verification again.");
    if (managesCommands && result.status === 400) throw new HttpError(502, "Discord rejected the managed command configuration. Confirm the Application ID and Server ID, then try verification again.");
    const message = typeof errorBody.message === "string" ? errorBody.message.replace(/\s+/g, " ").slice(0, 180) : "";
    const code = Number(errorBody.code);
    throw new DiscordResponseError(result.status, message, Number.isFinite(code) ? code : undefined);
  }
  throw new HttpError(502, "Discord request did not complete");
}
