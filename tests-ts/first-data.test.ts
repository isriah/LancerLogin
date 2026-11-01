// Core's shared FIRST data connection (first-data.ts) against real SQLite with every Core migration: cache times, the
// installation and per-visitor limits, who counts toward them, timeouts, missing or unreadable credentials, FLL's public
// team search and its parser, credential checks and the legacy import Guest Visits uses. FIRST is always a fake; no request leaves the
// test. Every team, name, address and credential here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { encryptIntegration, moduleCredentials } from "../apps/api/src/integration-crypto.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import {
  firstDataService, firstFoundCacheMs, firstIntegrationStatus, firstNotFoundCacheMs, firstRequestLimit, firstVisitorKey, firstVisitorLookupLimit, removeFirstCredential, saveFirstCredential,
  type FirstCaller, type FirstDataDeps,
} from "../apps/api/src/first-data.ts";
import { fllSearchEnabled, fllSearchRequest, fllSearchUrl, parseFllSearch } from "../apps/api/src/first-fll-search.ts";
import { firstTimeoutMs } from "../apps/api/src/first-events-api.ts";

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherSecret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const start = Date.parse("2026-11-01T12:00:00.000Z");
const minute = 60_000;

type Answer = { status: number; body?: unknown } | Error;
/** A fake FIRST: answers by URL, records every request, and fails any request it was not told about. */
function fakeFirst(answers: (url: string, init: RequestInit) => Answer | undefined) {
  const calls: { url: string; authorization: string | null; method: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get("authorization"), method: init.method ?? "GET" });
    assert.ok(init.signal, "every request to FIRST has a timeout");
    const answer = answers(url, init);
    if (!answer) throw new Error(`Unexpected request to ${url}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetch, calls };
}
const team = (number: number, nameShort: string) => ({ teams: [{ teamNumber: number, nameShort, city: "Testville", stateProv: "PA", country: "USA" }] });
/** FRC root without a season (as FRC's answers), team 321 in 2026, and no other team in either season. */
const frcAnswers = (url: string, init: RequestInit): Answer | undefined => {
  if (url === "https://frc-api.firstinspires.org/v3.0/") return { status: 200, body: { name: "FRC Events API" } };
  const number = /\/(\d{4})\/teams\?teamNumber=(\d+)$/.exec(url);
  if (number && url.startsWith("https://frc-api")) return number[2] === "321" && number[1] === "2026" ? { status: 200, body: team(321, "Test Robotics A") } : number[2]!.startsWith("1") && number[1] === "2026" ? { status: 200, body: team(Number(number[2]), `Test Team ${number[2]}`) } : { status: 404 };
  if (url === fllSearchUrl) return { status: 200, body: { results: fllSearchEntries.filter((entry) => entry.team_number_yearly === searchedNumber(init)) } };
  return undefined;
};

/** One entry in FIRST's team search answer, in its shape, with synthetic values. */
const fllEntry = (fields: Record<string, string>) => ({
  team_number_yearly: "321", ff_team_type: "FLL", ff_program_moniker: "FLL Challenge", team_nickname: "Test Team Alpha", team_name_calc: "Test Sponsors Inc",
  team_city: "Testville", team_stateprov: "PA", team_country: "USA", countrycode: "US", profile_year: "2025", flag_current_season: "0",
  modified_when: "2025-09-01T00:00:00Z", events: [], ...fields,
});
/**
 * Team number 321 reused as FIRST reuses numbers: an FRC and an FTC team, a different Challenge team each season, and an
 * Explore team only under another number. The fake search answers every entry with the number, whatever the program, so
 * the parser's own program check is what keeps the other programs out.
 */
const fllSearchEntries = [
  fllEntry({ ff_team_type: "FRC", ff_program_moniker: "FRC", team_nickname: "Test Robotics A", profile_year: "2026", flag_current_season: "0" }),
  fllEntry({ ff_team_type: "FTC", ff_program_moniker: "FTC", team_nickname: "Test Gears", profile_year: "2026", flag_current_season: "1" }),
  fllEntry({ team_nickname: "Test Team Beta", team_city: "Mocktown ", profile_year: "2024", modified_when: "2024-09-01T00:00:00Z" }),
  fllEntry({}),
  fllEntry({ team_number_yearly: "3210", ff_team_type: "JFLL", ff_program_moniker: "FLL Explore", team_nickname: "Test Explorers", profile_year: "2023" }),
];
const searchedNumber = (init: RequestInit) => (JSON.parse(String(init.body)) as ReturnType<typeof fllSearchRequest>).query.query.bool.must[0]!.match.team_number_yearly;

async function setup(answers = frcAnswers) {
  const db = new TestD1Database();
  db.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01T00:00:00.000Z','local')");
  let now = start; const first = fakeFirst(answers);
  const deps: FirstDataDeps = { db, fetch: first.fetch, now: () => now, credentials: moduleCredentials(secret) };
  const caller = (visitor: string | null = null, moduleId = "visits"): FirstCaller => ({ moduleId, visitor: async () => visitor });
  return {
    db, deps, first, caller, service: (visitor: string | null = null, moduleId = "visits") => firstDataService(deps, caller(visitor, moduleId)),
    advance(ms: number) { now += ms; }, at: () => now,
    async saveCredential(program: "FRC" | "FTC", key = secret) {
      const encrypted = await encryptIntegration({ token: `synthetic-${program}-token` }, key);
      db.sqlite.prepare("INSERT INTO first_credentials(installation_id,program,username,ciphertext,iv,checked_at,updated_at) VALUES('primary',?,?,?,?,?,?)").run(program, `test-${program.toLowerCase()}-user`, encrypted.ciphertext, encrypted.iv, "2026-10-31T00:00:00.000Z", "2026-10-31T00:00:00.000Z");
    },
    count: (sql: string) => Number((db.sqlite.prepare(sql).get() as { n: number }).n),
  };
}

test("a found team is cached for seven days and a missing team for one", async () => {
  const fixture = await setup(); await fixture.saveCredential("FRC"); const service = fixture.service();
  const found = await service.lookupTeam({ program: "FRC", number: "321" });
  assert.deepEqual(found, { status: "found", team: { program: "FRC", number: "321", name: "Test Robotics A", location: "Testville, PA", season: 2026, source: "events-api" } });
  assert.deepEqual(fixture.first.calls.map((call) => call.url), ["https://frc-api.firstinspires.org/v3.0/", "https://frc-api.firstinspires.org/v3.0/2026/teams?teamNumber=321"]);
  assert.equal(fixture.first.calls[1]!.authorization, `Basic ${btoa("test-frc-user:synthetic-FRC-token")}`);
  fixture.advance(firstFoundCacheMs - minute);
  assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "321" }), found);
  assert.equal(fixture.first.calls.length, 2, "a cached team sends nothing");
  fixture.advance(2 * minute);
  assert.equal((await service.lookupTeam({ program: "FRC", number: "321" })).status, "found");
  assert.equal(fixture.first.calls.at(-1)!.url, "https://frc-api.firstinspires.org/v3.0/2026/teams?teamNumber=321", "after seven days FIRST is asked again");

  const asked = fixture.first.calls.length;
  assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "99999" }), { status: "not-found" });
  assert.deepEqual(fixture.first.calls.slice(asked).map((call) => call.url.slice(-30)), ["/v3.0/2026/teams?teamNumber=99999", "/v3.0/2025/teams?teamNumber=99999"].map((url) => url.slice(-30)), "no team needs both seasons");
  assert.ok(fixture.first.calls.length - asked <= 3, "at most three requests per program per lookup");
  fixture.advance(firstNotFoundCacheMs - minute);
  assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "99999" }), { status: "not-found" });
  assert.equal(fixture.first.calls.length - asked, 2, "a cached missing team sends nothing for a day");
  fixture.advance(2 * minute);
  await service.lookupTeam({ program: "FRC", number: "99999" });
  assert.ok(fixture.first.calls.length - asked > 2, "after a day FIRST is asked again");
});

test("public lookups stop at the per-visitor limit; staff, other visitors and cache hits are not held back", async () => {
  const fixture = await setup(); await fixture.saveCredential("FRC");
  const visitor = fixture.service("visitor-a");
  for (let index = 0; index < firstVisitorLookupLimit; index += 1) assert.equal((await visitor.lookupTeam({ program: "FRC", number: String(1000 + index) })).status, "found");
  assert.deepEqual(await visitor.lookupTeam({ program: "FRC", number: "1999" }), { status: "unavailable", reason: "rate-limited" });
  const sent = fixture.first.calls.length;
  for (let index = 0; index < 20; index += 1) assert.equal((await visitor.lookupTeam({ program: "FRC", number: "1000" })).status, "found", "cache hits never count");
  assert.equal(fixture.first.calls.length, sent);
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket LIKE 'visitor:%'"), firstVisitorLookupLimit);
  assert.equal((await fixture.service("visitor-b").lookupTeam({ program: "FRC", number: "1999" })).status, "found", "another visitor has their own limit");
  assert.equal((await fixture.service(null).lookupTeam({ program: "FRC", number: "1998" })).status, "found", "staff and jobs count only toward the installation limit");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket LIKE 'visitor:%'"), firstVisitorLookupLimit + 1);
  fixture.advance(minute + 1);
  assert.equal((await visitor.lookupTeam({ program: "FRC", number: "1997" })).status, "found", "the limit rolls over after a minute");
});

test("uncached requests stop at the installation limit for every caller, while cached answers still serve", async () => {
  const fixture = await setup(); await fixture.saveCredential("FRC"); const staff = fixture.service();
  assert.equal((await staff.lookupTeam({ program: "FRC", number: "321" })).status, "found");
  const insert = fixture.db.sqlite.prepare("INSERT INTO first_requests(installation_id,bucket,id,requested_ms) VALUES('primary','events-api',?,?)");
  const used = fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket='events-api'");
  for (let index = used; index < firstRequestLimit; index += 1) insert.run(`synthetic-${index}`, fixture.at());
  const sent = fixture.first.calls.length;
  assert.deepEqual(await staff.lookupTeam({ program: "FRC", number: "1001" }), { status: "unavailable", reason: "rate-limited" });
  assert.deepEqual(await fixture.service("visitor-a").lookupTeam({ program: "FRC", number: "1001" }), { status: "unavailable", reason: "rate-limited" });
  assert.equal(fixture.first.calls.length, sent, "nothing is sent over the limit");
  assert.equal((await staff.lookupTeam({ program: "FRC", number: "321" })).status, "found");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_team_cache WHERE number='1001'"), 0, "a refused lookup caches nothing");
  fixture.advance(minute + 1);
  assert.equal((await staff.lookupTeam({ program: "FRC", number: "1001" })).status, "found");
});

test("timeouts and failures answer unavailable and cache nothing; no credential answers not-configured", async () => {
  let mode: "timeout" | "error" | "500" = "timeout";
  const fixture = await setup((url) => url.endsWith("/v3.0/") ? { status: 200, body: {} } : mode === "timeout" ? new DOMException("The operation timed out.", "TimeoutError") : mode === "error" ? new TypeError("fetch failed") : { status: 500 });
  const service = fixture.service();
  assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "321" }), { status: "unavailable", reason: "not-configured" });
  assert.deepEqual(await service.lookupTeam({ program: "FTC", number: "321" }), { status: "unavailable", reason: "not-configured" });
  assert.equal(fixture.first.calls.length, 0, "nothing is sent without a credential");
  await fixture.saveCredential("FRC");
  assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "321" }), { status: "unavailable", reason: "timeout" });
  mode = "error"; assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "321" }), { status: "unavailable", reason: "provider-error" });
  mode = "500"; assert.deepEqual(await service.lookupTeam({ program: "FRC", number: "321" }), { status: "unavailable", reason: "provider-error" });
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_team_cache"), 0);
  assert.equal(firstTimeoutMs, 4_000);
});

test("a credential Core cannot decrypt is not configured, and status says which programs are available", async () => {
  const fixture = await setup(); await fixture.saveCredential("FRC"); await fixture.saveCredential("FTC", otherSecret);
  const service = fixture.service();
  assert.deepEqual(await service.status(), { FRC: { available: true, checkedAt: "2026-10-31T00:00:00.000Z" }, FTC: { available: false, checkedAt: null }, Challenge: { available: true, checkedAt: null }, Explore: { available: true, checkedAt: null } });
  assert.deepEqual(await service.lookupTeam({ program: "FTC", number: "321" }), { status: "unavailable", reason: "not-configured" });
  const status = await firstIntegrationStatus(fixture.deps);
  assert.deepEqual(status.programs.FTC, { saved: true, username: "test-ftc-user", checkedAt: "2026-10-31T00:00:00.000Z", readable: false });
  assert.equal(JSON.stringify(status).includes("synthetic-"), false, "status never carries a token");
});

test("the FLL search asks for the number in one program only, without a credential", () => {
  assert.equal(fllSearchEnabled, true);
  assert.deepEqual(fllSearchRequest("Challenge", "321"), { index: "teams_*", query: { size: 50, query: { bool: { must: [{ match: { team_number_yearly: "321" } }, { match: { ff_team_type: "FLL" } }] } } } });
  assert.equal(fllSearchRequest("Explore", "321").query.query.bool.must[1]!.match.ff_team_type, "JFLL");
  assert.match(fllSearchUrl, /^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com\/prod\/first-search$/);
});

test("the FLL parser keeps the latest season of the right number in the right program", () => {
  const answer = { results: fllSearchEntries };
  assert.deepEqual(parseFllSearch(answer, "Challenge", "321"), { program: "Challenge", number: "321", name: "Test Team Alpha", location: "Testville, PA", season: 2025, source: "first-search" }, "the newest Challenge season wins over an older team with the number, and FRC and FTC entries are ignored");
  assert.equal(parseFllSearch(answer, "Explore", "321"), null, "no Explore team has this number, though other programs do");
  assert.equal(parseFllSearch(answer, "Explore", "32"), null, "a number must match exactly, not as a prefix");
  assert.deepEqual(parseFllSearch(answer, "Explore", "3210"), { program: "Explore", number: "3210", name: "Test Explorers", location: "Testville, PA", season: 2023, source: "first-search" });
  assert.equal(parseFllSearch({ results: [fllEntry({ ff_team_type: "JFLL" })] }, "Challenge", "321"), null, "an Explore entry never answers for Challenge");
  assert.equal(parseFllSearch({ results: [fllEntry({ ff_team_type: "FLL" })] }, "Explore", "321"), null, "a Challenge entry never answers for Explore");
  assert.equal(parseFllSearch({ results: [fllEntry({ ff_team_type: "FRC", profile_year: "2026" }), fllEntry({ ff_team_type: "FTC", profile_year: "2026" })] }, "Challenge", "321"), null, "FRC and FTC entries never answer for FLL");
  assert.equal(parseFllSearch({ results: [fllEntry({ team_number_yearly: "3212" })] }, "Challenge", "321"), null, "a team the search matched on another field is ignored");

  // Season ties: the current-season flag, then the latest change. The flag never beats a later season.
  const tie = [fllEntry({ team_nickname: "Test Team Old", modified_when: "2025-12-01T00:00:00Z" }), fllEntry({ team_nickname: "Test Team Flagged", flag_current_season: "1", modified_when: "2025-01-01T00:00:00Z" })];
  assert.equal(parseFllSearch({ results: tie }, "Challenge", "321")?.name, "Test Team Flagged");
  assert.equal(parseFllSearch({ results: [fllEntry({ team_nickname: "Test Team Late", modified_when: "2025-10-01T00:00:00Z" }), fllEntry({ team_nickname: "Test Team Early", modified_when: "2025-01-01T00:00:00Z" })] }, "Challenge", "321")?.name, "Test Team Late");
  assert.equal(parseFllSearch({ results: [fllEntry({ team_nickname: "Test Team Early", modified_when: "2025-01-01T00:00:00Z" }), fllEntry({ team_nickname: "Test Team Late", modified_when: "2025-10-01T00:00:00Z" })] }, "Challenge", "321")?.name, "Test Team Late");
  assert.equal(parseFllSearch({ results: [fllEntry({ team_nickname: "Test Team Flagged", flag_current_season: "1", profile_year: "2024" }), fllEntry({ team_nickname: "Test Team Newer", profile_year: "2025" })] }, "Challenge", "321")?.name, "Test Team Newer");

  // Names and locations: the sponsors' name only without a nickname, trimmed text, and empty parts left out.
  assert.equal(parseFllSearch({ results: [fllEntry({ team_nickname: "  " })] }, "Challenge", "321")?.name, "Test Sponsors Inc");
  assert.equal(parseFllSearch({ results: [fllEntry({ team_nickname: "" })] }, "Challenge", "321")?.name, "Test Sponsors Inc");
  assert.deepEqual(parseFllSearch({ results: [fllEntry({ team_nickname: " Test Team Alpha ", team_city: "Testville   ", team_stateprov: "", team_country: " Testland " })] }, "Challenge", "321"), { program: "Challenge", number: "321", name: "Test Team Alpha", location: "Testville, Testland", season: 2025, source: "first-search" });
  assert.equal(parseFllSearch({ results: [fllEntry({ team_city: "", team_stateprov: "", team_country: "" })] }, "Challenge", "321")?.location, "");

  // An empty answer is "no such team"; an answer that cannot be read is not.
  assert.equal(parseFllSearch({ results: [] }, "Challenge", "321"), null);
  for (const body of [null, undefined, {}, [], "text", { results: null }, { results: {} }, { hits: { hits: [] } }]) assert.equal(parseFllSearch(body, "Challenge", "321"), undefined, JSON.stringify(body));
  for (const fields of [{ team_nickname: "", team_name_calc: "" }, { profile_year: "" }, { profile_year: "next year" }]) assert.equal(parseFllSearch({ results: [fllEntry(fields)] }, "Challenge", "321"), undefined, `matching entries that cannot be read are not "no such team": ${JSON.stringify(fields)}`);
});

test("FLL lookups ask FIRST's public search once, without a credential, and cache like the Events API", async () => {
  const fixture = await setup(); const service = fixture.service("visitor-a");
  const found = await service.lookupTeam({ program: "Challenge", number: "321" });
  assert.deepEqual(found, { status: "found", team: { program: "Challenge", number: "321", name: "Test Team Alpha", location: "Testville, PA", season: 2025, source: "first-search" } });
  assert.deepEqual(fixture.first.calls, [{ url: fllSearchUrl, authorization: null, method: "POST" }], "one request, no Authorization header");
  assert.deepEqual(await service.lookupTeam({ program: "Explore", number: "321" }), { status: "not-found" });
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket='first-search'"), 2, "FLL requests count toward their own installation limit");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket LIKE 'visitor:%'"), 2);
  fixture.advance(firstNotFoundCacheMs - minute);
  assert.deepEqual(await service.lookupTeam({ program: "Challenge", number: "321" }), found);
  assert.deepEqual(await service.lookupTeam({ program: "Explore", number: "321" }), { status: "not-found" });
  assert.equal(fixture.first.calls.length, 2, "cached answers send nothing");
  fixture.advance(2 * minute);
  await service.lookupTeam({ program: "Explore", number: "321" });
  assert.equal(fixture.first.calls.length, 3, "after a day a missing team is asked again");
  fixture.advance(firstFoundCacheMs - firstNotFoundCacheMs);
  await service.lookupTeam({ program: "Challenge", number: "321" });
  assert.equal(fixture.first.calls.length, 4, "after seven days a found team is asked again");
  const status = await service.status();
  assert.deepEqual([status.Challenge, status.Explore], [{ available: true, checkedAt: null }, { available: true, checkedAt: null }]);
  assert.deepEqual((await firstIntegrationStatus(fixture.deps)).fll, { available: true });
});

test("FLL search errors, unreadable answers and limits answer unavailable and cache nothing", async () => {
  let answer: Answer = { status: 500 };
  const fixture = await setup((url) => url === fllSearchUrl ? answer : undefined); const service = fixture.service();
  assert.deepEqual(await service.lookupTeam({ program: "Challenge", number: "321" }), { status: "unavailable", reason: "provider-error" });
  answer = { status: 200, body: { message: "Internal server error" } };
  assert.deepEqual(await service.lookupTeam({ program: "Challenge", number: "321" }), { status: "unavailable", reason: "provider-error" });
  answer = { status: 200, body: { results: [fllEntry({ profile_year: "" })] } };
  assert.deepEqual(await service.lookupTeam({ program: "Challenge", number: "321" }), { status: "unavailable", reason: "provider-error" });
  answer = { status: 403, body: { results: [] } };
  assert.deepEqual(await service.lookupTeam({ program: "Explore", number: "321" }), { status: "unavailable", reason: "provider-error" });
  answer = new DOMException("The operation timed out.", "TimeoutError");
  assert.deepEqual(await service.lookupTeam({ program: "Explore", number: "321" }), { status: "unavailable", reason: "timeout" });
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_team_cache"), 0);
  const insert = fixture.db.sqlite.prepare("INSERT INTO first_requests(installation_id,bucket,id,requested_ms) VALUES('primary','first-search',?,?)");
  for (let index = fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket='first-search'"); index < firstRequestLimit; index += 1) insert.run(`synthetic-${index}`, fixture.at());
  const sent = fixture.first.calls.length;
  answer = { status: 200, body: { results: [] } };
  assert.deepEqual(await service.lookupTeam({ program: "Challenge", number: "321" }), { status: "unavailable", reason: "rate-limited" });
  assert.equal(fixture.first.calls.length, sent, "nothing is sent over the limit");
});

test("searchTeams answers each program in order and is complete only when every program answered", async () => {
  const fixture = await setup(); await fixture.saveCredential("FRC");
  const service = fixture.service("visitor-a");
  const all = await service.searchTeams({ number: "321" });
  assert.deepEqual(all.results.map((result) => [result.program, result.status]), [["FRC", "found"], ["FTC", "unavailable"], ["Challenge", "found"], ["Explore", "not-found"]]);
  assert.equal(all.complete, false, "FTC has no credential");
  assert.deepEqual(all.results.map((result) => result.status === "found" ? result.team.name : ""), ["Test Robotics A", "", "Test Team Alpha", ""]);
  const three = await fixture.service("visitor-b").searchTeams({ number: "1001", programs: ["Explore", "FRC", "Challenge"] });
  assert.deepEqual(three.results.map((result) => [result.program, result.status]), [["FRC", "found"], ["Challenge", "not-found"], ["Explore", "not-found"]]);
  assert.equal(three.complete, true, "every program asked answered, FLL included");
  assert.deepEqual(await service.searchTeams({ number: "321", programs: ["FRC"] }), { results: [{ status: "found", team: { program: "FRC", number: "321", name: "Test Robotics A", location: "Testville, PA", season: 2026, source: "events-api" }, program: "FRC" }], complete: true });
  assert.deepEqual(await service.searchTeams({ number: "99999", programs: ["FTC", "FRC"] }).then((result) => result.results.map((item) => item.program)), ["FRC", "FTC"]);
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket LIKE 'visitor:%'"), 3, "one visitor lookup per search that needed FIRST");
  await assert.rejects(service.searchTeams({ number: "0123" }), (error: unknown) => error instanceof HttpError && error.status === 400);
  await assert.rejects(service.lookupTeam({ program: "FLL" as never, number: "321" }), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test("saving checks the credential with FIRST without counting it, and FIRST refusing it is a clear 400", async () => {
  let accept = false;
  const fixture = await setup((url, init) => {
    const authorized = new Headers(init.headers).get("authorization") === `Basic ${btoa("test-frc-user:synthetic-token")}`;
    if (url === "https://frc-api.firstinspires.org/v3.0/") return accept && authorized ? { status: 200, body: {} } : { status: 401 };
    if (/\/v3\.0\/202[56]$/.test(url)) return accept && authorized ? { status: 200, body: { eventCount: 1 } } : { status: 401 };
    return undefined;
  });
  await assert.rejects(saveFirstCredential(fixture.deps, { program: "FRC", username: "test-frc-user", token: "synthetic-token" }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "FIRST did not accept this FRC username and token. Check both and save again.");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_credentials"), 0);
  accept = true;
  assert.equal(await saveFirstCredential(fixture.deps, { program: "FRC", username: " test-frc-user ", token: "synthetic-token" }), "FRC");
  const row = fixture.db.sqlite.prepare("SELECT username,ciphertext,checked_at,key_version FROM first_credentials").get() as Record<string, unknown>;
  assert.equal(row.username, "test-frc-user"); assert.equal(row.checked_at, new Date(start).toISOString()); assert.equal(row.key_version, 1);
  assert.equal(String(row.ciphertext).includes("synthetic-token"), false, "only ciphertext is stored");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_requests"), 0, "Admin checks count toward no limit");
  await saveFirstCredential(fixture.deps, { program: "FRC", username: "test-frc-user", token: "synthetic-token" });
  assert.equal((fixture.db.sqlite.prepare("SELECT key_version FROM first_credentials").get() as { key_version: number }).key_version, 2);
  for (const [input, message] of [[{ program: "FLL", username: "u", token: "t" }, /Choose FRC or FTC/], [{ program: "FRC", username: "a:b", token: "t" }, /without a colon/], [{ program: "FRC", username: "u", token: "has space" }, /without spaces/], [{ program: "FRC", username: "u", token: "t", extra: 1 }, /only program, username and token/]] as const) {
    await assert.rejects(saveFirstCredential(fixture.deps, input), (error: unknown) => error instanceof HttpError && error.status === 400 && message.test(error.message));
  }
  await removeFirstCredential(fixture.deps, "FRC");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_credentials"), 0);
  await assert.rejects(removeFirstCredential(fixture.deps, "Challenge"), /Choose FRC or FTC/);
});

test("Guest Visits can import its saved credential once; an Admin's credential wins and unreadable ones are refused", async () => {
  const fixture = await setup(); const visits = fixture.service(null, "visits");
  const legacy = async (key = secret, program: "FRC" | "FTC" = "FTC") => ({ program, username: "test-visits-user", ...await encryptIntegration({ token: "synthetic-legacy-token" }, key), checkedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(await visits.importLegacyCredential(await legacy()), "imported");
  assert.deepEqual({ ...fixture.db.sqlite.prepare("SELECT username,checked_at,key_version FROM first_credentials WHERE program='FTC'").get() }, { username: "test-visits-user", checked_at: "2026-09-01T00:00:00.000Z", key_version: 1 });
  assert.equal((await visits.status()).FTC.available, true, "the imported ciphertext reads with Core's key");
  await fixture.saveCredential("FRC");
  assert.equal(await visits.importLegacyCredential(await legacy(secret, "FRC")), "kept-existing");
  assert.equal((fixture.db.sqlite.prepare("SELECT username FROM first_credentials WHERE program='FRC'").get() as { username: string }).username, "test-frc-user");
  await removeFirstCredential(fixture.deps, "FTC");
  assert.equal(await visits.importLegacyCredential(await legacy(otherSecret)), "unreadable");
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_credentials WHERE program='FTC'"), 0);
  await assert.rejects(fixture.service(null, "outreach").importLegacyCredential(await legacy()), (error: unknown) => error instanceof HttpError && error.status === 403);
  await assert.rejects(visits.importLegacyCredential({ ...await legacy(), checkedAt: "yesterday" }), (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.equal(fixture.count("SELECT COUNT(*) AS n FROM first_credentials WHERE program='FTC'"), 0);
});

test("a visitor's key is a hash of their address, never the address", async () => {
  const key = await firstVisitorKey("203.0.113.7");
  assert.match(key, /^[0-9a-f]{32}$/); assert.equal(key.includes("203"), false);
  assert.equal(key, await firstVisitorKey("203.0.113.7")); assert.notEqual(key, await firstVisitorKey("203.0.113.8"));
  assert.match(await firstVisitorKey(null), /^[0-9a-f]{32}$/);
});
