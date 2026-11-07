// Discord rate-limit messages name the Core feature that was limited, never a fixed one, and give no exact countdown
// that would freeze once the message is stored and shown again.
import test from "node:test";
import assert from "node:assert/strict";
import { DiscordRateLimitError, discordRateLimitFailsFast, discordRateLimitMessage, discordRateLimitOperation } from "../apps/api/src/discord-rate-limit.ts";

const guild = "/guilds/123456789012345678";

test("each Discord path is labelled with its own feature", () => {
  assert.equal(discordRateLimitOperation(`${guild}/members/223456789012345678/roles/323456789012345678`), "role sync");
  assert.equal(discordRateLimitOperation(`${guild}/members?limit=1000&after=0`), "role sync");
  assert.equal(discordRateLimitOperation("/applications/103456789012345678/guilds/123456789012345678/commands"), "command setup");
  assert.equal(discordRateLimitOperation(`${guild}/scheduled-events`), "calendar sync");
  assert.equal(discordRateLimitOperation(`${guild}/scheduled-events/423456789012345678`), "calendar sync");
  assert.equal(discordRateLimitOperation("/channels/223456789012345678/messages"), "requests");
});

test("a long delay fails fast without being called role sync", () => {
  assert.equal(discordRateLimitFailsFast(`${guild}/scheduled-events`, 9_000), true);
  assert.equal(discordRateLimitFailsFast(`${guild}/scheduled-events`, 1_250), false);
  assert.equal(discordRateLimitFailsFast(`${guild}/members/1/roles/2`, 100), true);
  const error = new DiscordRateLimitError(9_000, discordRateLimitOperation(`${guild}/scheduled-events`));
  assert.equal(error.message, "Discord is rate limiting calendar sync. Try again in a few seconds.");
  assert.equal(error.status, 503);
  assert.equal(error.retryAfterMs, 9_000);
});

test("the message gives a hint that stays true after it is stored, not a frozen countdown", () => {
  assert.equal(new DiscordRateLimitError(9_000).message, "Discord is rate limiting requests. Try again in a few seconds.");
  assert.equal(discordRateLimitMessage(15_000), "Discord is rate limiting requests. Try again in a few seconds.");
  assert.equal(discordRateLimitMessage(45_000, "role sync"), "Discord is rate limiting role sync. Try again in about a minute.");
  assert.equal(discordRateLimitMessage(600_000, "calendar sync"), "Discord is rate limiting calendar sync. Try again in about 10 minutes.");
  for (const milliseconds of [1_000, 9_000, 45_000, 600_000]) assert.doesNotMatch(discordRateLimitMessage(milliseconds), /\d+ seconds|Wait /);
});
