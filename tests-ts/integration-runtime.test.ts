import test from "node:test";
import assert from "node:assert/strict";
import { decryptIntegration, encryptIntegration } from "../apps/api/src/integration-crypto.ts";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("integration configuration uses authenticated encryption and round-trips", async () => {
  const encrypted = await encryptIntegration({ apiKey: "secret-value", fromEmail: "hello@example.test" }, key);
  assert.equal(encrypted.ciphertext.includes("secret-value"), false);
  assert.equal(encrypted.iv.length, 16);
  assert.deepEqual(await decryptIntegration(encrypted.ciphertext, encrypted.iv, key), { apiKey: "secret-value", fromEmail: "hello@example.test" });
});

test("integration ciphertext rejects tampering", async () => {
  const encrypted = await encryptIntegration({ botToken: "secret" }, key);
  const index = Math.floor(encrypted.ciphertext.length / 2);
  const changed = `${encrypted.ciphertext.slice(0, index)}${encrypted.ciphertext[index] === "A" ? "B" : "A"}${encrypted.ciphertext.slice(index + 1)}`;
  await assert.rejects(() => decryptIntegration(changed, encrypted.iv, key));
});
import { composeDiscordCommands, discordRequest, reconcileDiscordApplicationCommands, verifyDiscordInteraction, readDiscordBody, discordConfiguration } from "../apps/api/src/discord-platform.ts";
import { SchedulerBudget, schedulerBudgetKey } from "../apps/api/src/scheduler-budget.ts";
import { generateKeyPairSync, sign } from "node:crypto";

const discordConfig = { botToken: "synthetic-token", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678" };
test("Discord command contributions require implemented owners, exact schemas and both core names", () => {
  const commands = composeDiscordCommands();
  assert.deepEqual(commands.map(item => item.name), ["pair", "attendance-report"]);
  for (const contributions of [[], [{ owner: "hours", commands }], [{ owner: "attendance", commands: commands.slice(0, 1) }], [{ owner: "attendance", commands: [...commands, commands[0]] }], [{ owner: "attendance", commands: [{ ...commands[0], type: 2 }, commands[1]] }], [{ owner: "attendance", commands: [{ ...commands[0], name: "dummy-hour" }, commands[1]] }]]) assert.throws(() => composeDiscordCommands(contributions));
  commands[0].name = "changed";
  assert.equal(composeDiscordCommands()[0].name, "pair", "callers cannot alter the release registry");
});
test("Discord reconciliation repairs only managed drift and preserves unrelated command objects", async () => {
  const original = globalThis.fetch, calls: string[] = [], writes: string[] = [];
  const managed = composeDiscordCommands().map((command, i) => ({ ...command, id: String(523456789012345678n + BigInt(i)), application_id: discordConfig.applicationId, guild_id: discordConfig.guildId }));
  let remote = [...managed.map(command => ({ ...command, description: "outdated" })), { id: "623456789012345678", application_id: discordConfig.applicationId, guild_id: discordConfig.guildId, name: "Unrelated", type: 2, description: "", options: [] }];
  const unrelated = JSON.stringify(remote[2]);
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path.endsWith("/oauth2/applications/@me")) return Response.json({ id: discordConfig.applicationId });
    if (path.endsWith(`/guilds/${discordConfig.guildId}`)) return Response.json({ id: discordConfig.guildId });
    if (path.endsWith(`/channels/${discordConfig.channelId}`)) return Response.json({ guild_id: discordConfig.guildId, type: 0 });
    if (path.endsWith("/commands")) { assert.equal(init?.method, "GET"); return Response.json(remote); }
    assert.equal(init?.method, "PATCH"); writes.push(path);
    remote = remote.map(command => path.endsWith(`/${command.id}`) ? { ...command, ...JSON.parse(String(init.body)) } : command);
    return Response.json(remote.find(command => path.endsWith(`/${command.id}`)));
  };
  try {
    await reconcileDiscordApplicationCommands(discordConfig);
    assert.equal(writes.length, 2); assert.equal(JSON.stringify(remote[2]), unrelated);
    assert.ok(writes.every(path => managed.some(command => path.endsWith(`/${command.id}`))));
    await reconcileDiscordApplicationCommands(discordConfig);
    assert.equal(writes.length, 2, "verified matching state requires no writes");
    assert.equal(calls.length, 12);
  } finally { globalThis.fetch = original; }
});
test("Discord malformed inventories and mismatched readback cannot report command success", async () => {
  const original = globalThis.fetch;
  for (const scenario of ["duplicate", "foreign", "malformed", "missing-readback", "unrelated-changed"]) {
    let reads = 0, writes = 0;
    const managed = composeDiscordCommands().map((command, i) => ({ ...command, id: String(523456789012345678n + BigInt(i)), application_id: discordConfig.applicationId, guild_id: discordConfig.guildId }));
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.endsWith("/oauth2/applications/@me")) return Response.json({ id: discordConfig.applicationId });
      if (path.endsWith(`/guilds/${discordConfig.guildId}`)) return Response.json({ id: discordConfig.guildId });
      if (path.endsWith(`/channels/${discordConfig.channelId}`)) return Response.json({ guild_id: discordConfig.guildId, type: 0 });
      if (init?.method !== "GET") { writes++; return Response.json({}); }
      reads++;
      if (scenario === "duplicate") return Response.json([managed[0], managed[0]]);
      if (scenario === "foreign") return Response.json([{ ...managed[0], guild_id: "999999999999999999" }]);
      if (scenario === "malformed") return Response.json([{ ...managed[0], options: [null] }]);
      if (scenario === "missing-readback") return Response.json([]);
      return Response.json([...managed, { ...managed[0], id: "823456789012345678", name: "unrelated", description: reads === 1 ? "before" : "after" }]);
    };
    try { await assert.rejects(reconcileDiscordApplicationCommands(discordConfig)); if (["duplicate", "foreign", "malformed"].includes(scenario)) assert.equal(writes, 0); }
    finally { globalThis.fetch = original; }
  }
});
test("Discord transport bounds retries, payloads, destination and scheduler request admission", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ retry_after: 0, message: "sensitive-reflection" }, { status: 429 }); };
  try {
    await assert.rejects(discordRequest(discordConfig, "/users/@me", { method: "GET" }), /rate limiting/); assert.equal(calls, 3);
    calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ retry_after: 6 }, { status: 429 }); };
    await assert.rejects(discordRequest(discordConfig, "/users/@me", { method: "GET" }), /6 seconds/); assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ message: "sensitive-reflection", code: 10008 }, { status: 404 });
    await assert.rejects(discordRequest(discordConfig, "/channels/123/messages/456", { method: "GET" }), error => error instanceof Error && !error.message.includes("sensitive-reflection"));
    await assert.rejects(discordRequest(discordConfig, "https://example.test", { method: "GET" }), /operation path/);
    globalThis.fetch = async () => new Response('"' + "x".repeat(1_048_576) + '"');
    await assert.rejects(discordRequest(discordConfig, "/users/@me", { method: "GET" }), /supported limit/);
    const budget = new SchedulerBudget(); for (let i = 0; i < 12; i++) budget.request();
    const bounded = { ...discordConfig }; Object.defineProperty(bounded, schedulerBudgetKey, { value: budget });
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(discordRequest(bounded, "/users/@me", { method: "GET" }), /budget exhausted/);
  } finally { globalThis.fetch = original; }
});
test("Discord raw bytes and signature timestamps reject oversized, altered and stale interactions", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const config = { publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex") };
  const body = '{"type":1}', timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { "x-signature-timestamp": timestamp, "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex") };
  const request = new Request("https://example.test/discord/interactions", { method: "POST", headers, body });
  assert.equal(await verifyDiscordInteraction(request, config, await readDiscordBody(request)), true);
  assert.equal(await verifyDiscordInteraction(request, config, body + " "), false);
  for (const changed of [{ "x-signature-timestamp": "0" }, { "x-signature-timestamp": "9".repeat(400) }, { "x-signature-ed25519": "a".repeat(126) }, { "x-signature-timestamp": String(Number(timestamp) + 600) }]) assert.equal(await verifyDiscordInteraction(new Request("https://example.test", { headers: { ...headers, ...changed } }), config, body), false);
  await assert.rejects(readDiscordBody(new Request("https://example.test", { method: "POST", body: "x".repeat(65_537) })), /supported limit/);
  await assert.rejects(readDiscordBody(new Response(new Uint8Array([255]))), /malformed/);
});

test("Discord shared credential loading keeps verification and scheduler budget on the single encrypted record", async () => {
  const encrypted = await encryptIntegration(discordConfig, key), budget = new SchedulerBudget(); let enabled = 1, verifiedAt: string | null = "2026-09-01T00:00:00Z", queries = 0;
  const env = { INTEGRATION_KEY: key, [schedulerBudgetKey]: budget, DB: { prepare(sql: string) { queries++; assert.match(sql, /x.discord_enabled/); return { bind(provider: string) { assert.equal(provider, "discord"); return { async first() { return { id: "synthetic", ...encrypted, enabled, verifiedAt }; } }; } }; } } };
  const config = await discordConfiguration(env as never);
  assert.equal(config.botToken, discordConfig.botToken);
  assert.equal((config as unknown as { [schedulerBudgetKey]: SchedulerBudget })[schedulerBudgetKey], budget);
  assert.equal(Object.keys(config).includes(String(schedulerBudgetKey)), false); assert.equal(queries, 1);
  verifiedAt = null; await assert.rejects(discordConfiguration(env as never), /verification is required/);
  assert.equal((await discordConfiguration(env as never, true)).botToken, discordConfig.botToken);
  enabled = 0; await assert.rejects(discordConfiguration(env as never, true), /not enabled/);
});
