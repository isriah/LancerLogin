// Core's shared FIRST data connection: `services.first` for modules and Settings > Integrations > FIRST for Admins. Core
// holds one FRC and one FTC Events API credential, encrypted with the integration key, and FIRST's public team search for
// FIRST LEGO League; modules ask for teams by number and never see a token. Answers are cached (a team for seven days,
// "no such team" for one, seasons for one), each request gives up after four seconds, and a lookup sends at most three
// requests per program. Uncached lookups count toward an installation limit per provider and, from public routes, a
// per-visitor limit; Admin credential checks count toward neither. Team lookup is the first use; events and rankings
// can join the same service later.
import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import type { ModuleCredentials } from "./integration-crypto.ts";
import {
  basicAuthorization, currentSeasonOf, eventsTeamOf, firstEventsPrograms, firstRequest, firstRootUrl, firstSeasonUrl, firstTeamsUrl, isFirstEventsProgram, isFirstFailure, likelySeason,
  parseFirstCredential, type FirstEventsProgram, type FirstFailure, type FirstReply,
} from "./first-events-api.ts";
import { fllSearchEnabled, fllSearchRequest, fllSearchUrl, parseFllSearch, type FllProgram } from "./first-fll-search.ts";

export type FirstProgram = "FRC" | "FTC" | "Challenge" | "Explore";
export type FirstTeam = { readonly program: FirstProgram; readonly number: string; readonly name: string; readonly location: string; readonly season: number; readonly source: "events-api" | "first-search" };
export type FirstUnavailableReason = "not-configured" | "rate-limited" | "timeout" | "provider-error";
export type FirstLookup = { readonly status: "found"; readonly team: FirstTeam } | { readonly status: "not-found" } | { readonly status: "unavailable"; readonly reason: FirstUnavailableReason };
export type FirstProgramStatus = { readonly available: boolean; readonly checkedAt: string | null };
export type FirstSearchResult = FirstLookup & { readonly program: FirstProgram };
export type FirstLegacyCredential = { readonly program: "FRC" | "FTC"; readonly username: string; readonly ciphertext: string; readonly iv: string; readonly checkedAt: string };

/** FIRST team data for modules (SDK 1.2.0). Tokens stay in Core; only team numbers go to FIRST. */
export type FirstDataService = {
  /** Which programs can be looked up now, and when FIRST last accepted each Events API credential. */
  status(): Promise<Readonly<Record<FirstProgram, FirstProgramStatus>>>;
  /** One team by number in one program. Throws an `HttpError` 400 for a number that is not 1 to 6 digits. */
  lookupTeam(input: { readonly program: FirstProgram; readonly number: string }): Promise<FirstLookup>;
  /**
   * One team number in several programs (all four by default), in program order. `complete` is true when every program
   * answered "found" or "not found", so a caller knows no program's answer is missing.
   */
  searchTeams(input: { readonly number: string; readonly programs?: readonly FirstProgram[] }): Promise<{ readonly results: readonly FirstSearchResult[]; readonly complete: boolean }>;
  /** Migration aid, allowlisted to module "visits". Fills an empty program only. Deprecated; removed in SDK 2. */
  importLegacyCredential(input: FirstLegacyCredential): Promise<"imported" | "kept-existing" | "unreadable">;
};

export const firstPrograms = ["FRC", "FTC", "Challenge", "Explore"] as const satisfies readonly FirstProgram[];
export const isFirstProgram = (value: unknown): value is FirstProgram => firstPrograms.includes(value as FirstProgram);

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
/** A team FIRST named is kept a week; "no such team" a day, so a new team shows up soon; the current season a day. */
export const firstFoundCacheMs = 7 * dayMs;
export const firstNotFoundCacheMs = dayMs;
export const firstSeasonCacheMs = dayMs;
/** Uncached requests to FIRST per rolling minute per provider, for the whole installation, so guests cannot use up the tokens. */
export const firstRequestLimit = 30;
/** Uncached lookups per rolling minute from one visitor address on a public route. */
export const firstVisitorLookupLimit = 10;
export const firstRequestWindowMs = minuteMs;

const installationId = "primary";
type Provider = "events-api" | "first-search";

export type FirstDataDeps = { readonly db: D1Database; readonly fetch: typeof fetch; readonly now: () => number; readonly credentials: ModuleCredentials };
/**
 * Who is asking. `visitor` resolves to the hashed address of a visitor on a public route, or null for a signed-in user, a
 * job or an Admin; it is asked only when a lookup needs FIRST.
 */
export type FirstCaller = { readonly moduleId: string; readonly visitor: () => Promise<string | null> };

/** The key a visitor's lookups count under: a hash of the connecting address, never the address itself. */
export async function firstVisitorKey(address: string | null): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lancerlogin-first-visitor:${address ?? "unknown"}`)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Count one entry in a bucket's rolling minute. False when the bucket is full. */
async function reserve(db: D1Database, bucket: string, limit: number, now: number): Promise<boolean> {
  const since = now - firstRequestWindowMs;
  const [, reserved] = await db.batch([
    db.prepare("DELETE FROM first_requests WHERE installation_id=? AND requested_ms<=?").bind(installationId, since),
    db.prepare("INSERT INTO first_requests(installation_id,bucket,id,requested_ms) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM first_requests WHERE installation_id=? AND bucket=? AND requested_ms>?)<?")
      .bind(installationId, bucket, crypto.randomUUID(), now, installationId, bucket, since, limit),
  ]);
  return reserved?.meta?.changes === 1;
}

type CredentialRow = { program: FirstEventsProgram; username: string; ciphertext: string; iv: string; checked_at: string };
async function credentialRows(db: D1Database): Promise<Map<FirstEventsProgram, CredentialRow>> {
  const result = await db.prepare("SELECT program,username,ciphertext,iv,checked_at FROM first_credentials WHERE installation_id=?").bind(installationId).all<CredentialRow>();
  return new Map((result.results ?? []).map((row) => [row.program, row]));
}

/** The token in a saved credential, or undefined when Core cannot decrypt it, for example after a restore with another key. */
async function tokenOf(credentials: ModuleCredentials, ciphertext: string, iv: string): Promise<string | undefined> {
  if (!credentials.available) return undefined;
  try { const { token } = await credentials.decrypt(ciphertext, iv); return typeof token === "string" && token ? token : undefined; } catch { return undefined; }
}

type Get = (url: string) => Promise<FirstReply | FirstFailure | "limited">;

/**
 * The program's current season, cached for a day: from the API root, or the season the date suggests when the root
 * answers without naming one, as FRC's does. A root that fails caches nothing; a stale season, else the date, serves.
 */
async function currentSeason(db: D1Database, program: FirstEventsProgram, now: number, get: Get): Promise<number> {
  const cached = await db.prepare("SELECT season,checked_ms FROM first_seasons WHERE installation_id=? AND program=?").bind(installationId, program).first<{ season: number; checked_ms: number }>();
  if (cached && cached.checked_ms > now - firstSeasonCacheMs) return cached.season;
  const reply = await get(firstRootUrl(program));
  if (typeof reply === "string" || isFirstFailure(reply) || reply.status !== 200) return cached?.season ?? likelySeason(program, now);
  const season = currentSeasonOf(reply.body, reply.text) ?? likelySeason(program, now);
  await db.prepare("INSERT INTO first_seasons(installation_id,program,season,checked_ms) VALUES(?,?,?,?) ON CONFLICT(installation_id,program) DO UPDATE SET season=excluded.season,checked_ms=excluded.checked_ms")
    .bind(installationId, program, season, now).run();
  return season;
}

const unavailable = (reason: FirstUnavailableReason): FirstLookup => ({ status: "unavailable", reason });
const notFound: FirstLookup = { status: "not-found" };

type CacheRow = { name: string | null; location: string; season: number | null; source: FirstTeam["source"] };
async function cachedAnswer(db: D1Database, program: FirstProgram, number: string, now: number): Promise<FirstLookup | undefined> {
  const row = await db.prepare("SELECT name,location,season,source FROM first_team_cache WHERE installation_id=? AND program=? AND number=? AND checked_ms>(CASE WHEN name IS NULL THEN ? ELSE ? END)")
    .bind(installationId, program, number, now - firstNotFoundCacheMs, now - firstFoundCacheMs).first<CacheRow>();
  if (!row) return undefined;
  return row.name === null || row.season === null ? notFound : { status: "found", team: { program, number, name: row.name, location: row.location, season: row.season, source: row.source } };
}

/** Keep FIRST's answer, "no such team" too; drop answers past their cache time. An Events API answer is kept only while its credential is saved. */
async function cacheAnswer(db: D1Database, program: FirstProgram, number: string, source: FirstTeam["source"], team: FirstTeam | null, now: number) {
  const credential = source === "events-api" ? " WHERE EXISTS(SELECT 1 FROM first_credentials WHERE installation_id=? AND program=?)" : "";
  await db.batch([
    db.prepare("DELETE FROM first_team_cache WHERE installation_id=? AND checked_ms<=(CASE WHEN name IS NULL THEN ? ELSE ? END)").bind(installationId, now - firstNotFoundCacheMs, now - firstFoundCacheMs),
    db.prepare(`INSERT INTO first_team_cache(installation_id,program,number,name,location,season,source,checked_ms) SELECT ?,?,?,?,?,?,?,?${credential}
      ON CONFLICT(installation_id,program,number) DO UPDATE SET name=excluded.name,location=excluded.location,season=excluded.season,source=excluded.source,checked_ms=excluded.checked_ms`)
      .bind(installationId, program, number, team?.name ?? null, team?.location ?? "", team?.season ?? null, source, now, ...source === "events-api" ? [installationId, program] : []),
  ]);
}

/** A team number as FIRST numbers teams: 1 to 6 digits without a leading zero. */
export function parseFirstTeamNumber(value: unknown): string {
  const number = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^[1-9]\d{0,5}$/.test(number)) throw new HttpError(400, "Enter a team number of 1 to 6 digits");
  return number;
}

/** Reserves the visitor's one lookup slot for a call, at most once, and only when the call needs FIRST. */
type VisitorGate = () => Promise<boolean>;
function visitorGate(db: D1Database, caller: FirstCaller, now: number): VisitorGate {
  let pending: Promise<boolean> | undefined;
  return () => pending ??= (async () => { const visitor = await caller.visitor(); return visitor === null || reserve(db, `visitor:${visitor}`, firstVisitorLookupLimit, now); })();
}

/**
 * FIRST's FRC or FTC team with this number: this season's team list and, when it has none, the previous season's. FIRST
 * answers HTTP 400 (both FRC and FTC) or 404 for a number with no team in that season. It can also report a new season
 * before its team lists are published, so a season that fails still falls back to the previous one. A team found in either
 * season answers; "no such team" needs both seasons to have said so. At most three requests: the root and two lists.
 */
async function lookUpEvents(deps: FirstDataDeps, gate: VisitorGate, program: FirstEventsProgram, number: string, now: number): Promise<FirstLookup> {
  const credential = (await credentialRows(deps.db)).get(program);
  const token = credential && await tokenOf(deps.credentials, credential.ciphertext, credential.iv);
  if (!credential || !token) return unavailable("not-configured");
  if (!await gate()) return unavailable("rate-limited");
  const authorization = basicAuthorization(credential.username, token);
  const get: Get = async (url) => await reserve(deps.db, "events-api", firstRequestLimit, deps.now()) ? firstRequest(deps.fetch, url, { authorization }) : "limited";
  const season = await currentSeason(deps.db, program, now, get);
  let failure: FirstUnavailableReason | undefined;
  let team: FirstTeam | null = null;
  for (const year of [season, season - 1]) {
    const reply = await get(firstTeamsUrl(program, year, number));
    const found = typeof reply === "string" || isFirstFailure(reply) ? undefined : reply.status === 400 || reply.status === 404 ? null : reply.status === 200 ? eventsTeamOf(reply.body, number) : undefined;
    if (found) { team = { program, number, ...found, season: year, source: "events-api" }; break; }
    if (found === undefined) failure ??= reply === "limited" ? "rate-limited" : typeof reply !== "string" && isFirstFailure(reply) ? reply.failure : "provider-error";
  }
  if (!team && failure) return unavailable(failure);
  await cacheAnswer(deps.db, program, number, "events-api", team, now);
  return team ? { status: "found", team } : notFound;
}

/** An FLL Challenge or Explore team from FIRST's public team search: one request, no credential. */
async function lookUpFll(deps: FirstDataDeps, gate: VisitorGate, program: FllProgram, number: string, now: number): Promise<FirstLookup> {
  if (!fllSearchEnabled) return unavailable("provider-error");
  if (!await gate()) return unavailable("rate-limited");
  if (!await reserve(deps.db, "first-search", firstRequestLimit, deps.now())) return unavailable("rate-limited");
  const reply = await firstRequest(deps.fetch, fllSearchUrl, { body: fllSearchRequest(program, number) });
  if (isFirstFailure(reply)) return unavailable(reply.failure);
  const team = reply.status === 200 ? parseFllSearch(reply.body, program, number) : undefined;
  if (team === undefined) return unavailable("provider-error");
  await cacheAnswer(deps.db, program, number, "first-search", team, now);
  return team ? { status: "found", team } : notFound;
}

async function lookUp(deps: FirstDataDeps, gate: VisitorGate, program: FirstProgram, number: string, now: number): Promise<FirstLookup> {
  const cached = await cachedAnswer(deps.db, program, number, now);
  if (cached) return cached;
  return isFirstEventsProgram(program) ? lookUpEvents(deps, gate, program, number, now) : lookUpFll(deps, gate, program, number, now);
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** `services.first` for one caller. */
export function firstDataService(deps: FirstDataDeps, caller: FirstCaller): FirstDataService {
  return Object.freeze({
    async status() {
      const saved = await credentialRows(deps.db);
      const events = async (program: FirstEventsProgram): Promise<FirstProgramStatus> => {
        const row = saved.get(program);
        return row && await tokenOf(deps.credentials, row.ciphertext, row.iv) ? { available: true, checkedAt: row.checked_at } : { available: false, checkedAt: null };
      };
      const [FRC, FTC] = await Promise.all(firstEventsPrograms.map(events));
      const fll = { available: fllSearchEnabled, checkedAt: null };
      return { FRC: FRC!, FTC: FTC!, Challenge: fll, Explore: fll };
    },
    async lookupTeam(input) {
      if (!input || !isFirstProgram(input.program)) throw new HttpError(400, "Choose FRC, FTC, Challenge or Explore");
      const now = deps.now();
      return lookUp(deps, visitorGate(deps.db, caller, now), input.program, parseFirstTeamNumber(input.number), now);
    },
    async searchTeams(input) {
      const programs = input?.programs ?? firstPrograms;
      if (!Array.isArray(programs) || !programs.length || programs.some((program) => !isFirstProgram(program))) throw new HttpError(400, "Choose FRC, FTC, Challenge or Explore");
      const number = parseFirstTeamNumber(input.number);
      const now = deps.now(); const gate = visitorGate(deps.db, caller, now);
      const ordered = firstPrograms.filter((program) => programs.includes(program));
      const results = await Promise.all(ordered.map(async (program): Promise<FirstSearchResult> => ({ ...await lookUp(deps, gate, program, number, now), program })));
      return { results, complete: results.every((result) => result.status !== "unavailable") };
    },
    async importLegacyCredential(input) {
      if (caller.moduleId !== "visits") throw new HttpError(403, "Only Guest Visits can import a FIRST credential");
      const parsed = input && isFirstEventsProgram(input.program) ? parseFirstCredential({ program: input.program, username: input.username, token: "x" }) : undefined;
      if (!parsed?.ok || typeof input.ciphertext !== "string" || !input.ciphertext || input.ciphertext.length > 4000 || typeof input.iv !== "string" || !input.iv || input.iv.length > 200 || typeof input.checkedAt !== "string" || !isoPattern.test(input.checkedAt)) {
        throw new HttpError(400, "The FIRST credential to import is incomplete");
      }
      if (!await tokenOf(deps.credentials, input.ciphertext, input.iv)) return "unreadable";
      const result = await deps.db.prepare("INSERT INTO first_credentials(installation_id,program,username,ciphertext,iv,key_version,checked_at,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(installation_id,program) DO NOTHING")
        .bind(installationId, input.program, parsed.value.username, input.ciphertext, input.iv, input.checkedAt, new Date(deps.now()).toISOString()).run();
      return result.meta?.changes === 1 ? "imported" : "kept-existing";
    },
  });
}

// Settings > Integrations > FIRST. Each function is the body of one Admin route; the Worker checks the role and audits.

export type FirstCredentialStatus = { readonly saved: boolean; readonly username: string; readonly checkedAt: string | null; readonly readable: boolean };
export type FirstIntegrationStatus = { readonly programs: Readonly<Record<FirstEventsProgram, FirstCredentialStatus>>; readonly fll: { readonly available: boolean }; readonly encryption: boolean };

/** `GET /admin/integrations/first`: which programs have a credential and whether Core can read it, never the token. */
export async function firstIntegrationStatus(deps: FirstDataDeps): Promise<FirstIntegrationStatus> {
  const saved = await credentialRows(deps.db);
  const status = async (program: FirstEventsProgram): Promise<FirstCredentialStatus> => {
    const row = saved.get(program);
    return row ? { saved: true, username: row.username, checkedAt: row.checked_at, readable: Boolean(await tokenOf(deps.credentials, row.ciphertext, row.iv)) } : { saved: false, username: "", checkedAt: null, readable: false };
  };
  const [FRC, FTC] = await Promise.all(firstEventsPrograms.map(status));
  return { programs: { FRC: FRC!, FTC: FTC! }, fll: { available: fllSearchEnabled }, encryption: deps.credentials.available };
}

const refused = (program: FirstEventsProgram) => new HttpError(400, `FIRST did not accept this ${program} username and token. Check both and save again.`);

/**
 * `PUT /admin/integrations/first`: check the credential with FIRST, then save it encrypted. The check reads the current
 * season (cached for a day) and then, with the credential, that season's summary, which needs a valid username and token.
 * Admin checks count toward no limit.
 */
export async function saveFirstCredential(deps: FirstDataDeps, value: unknown): Promise<FirstEventsProgram> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Request body must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["program", "username", "token"].includes(key))) throw new HttpError(400, "Send only program, username and token");
  const parsed = parseFirstCredential(input);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const { program, username, token } = parsed.value;
  if (!deps.credentials.available) throw new HttpError(503, "Integration encryption is not configured");
  const now = deps.now();
  let last: FirstReply | FirstFailure | undefined;
  const get: Get = async (url) => {
    last = await firstRequest(deps.fetch, url, { authorization: basicAuthorization(username, token) });
    if (!isFirstFailure(last) && (last.status === 401 || last.status === 403)) throw refused(program);
    return last;
  };
  // FRC's API root needs the credential and FTC's does not; a 401 or 403 from any call means FIRST refused it. A season
  // FIRST reports before its data is published can fail, so the previous season's summary also proves the credential.
  const season = await currentSeason(deps.db, program, now, get);
  const accepted = (reply: Awaited<ReturnType<Get>>) => typeof reply !== "string" && !isFirstFailure(reply) && reply.status === 200;
  if (!accepted(await get(firstSeasonUrl(program, season))) && !accepted(await get(firstSeasonUrl(program, season - 1)))) {
    const answer = last as FirstReply | FirstFailure | undefined;
    const what = !answer || isFirstFailure(answer) ? "did not answer" : answer.status === 200 ? "gave an answer LancerLogin could not read" : `answered with HTTP ${answer.status}`;
    throw new HttpError(502, `FIRST's ${program} API ${what}, so the credential was not saved. Try again in a few minutes.`);
  }
  const encrypted = await deps.credentials.encrypt({ token });
  const at = new Date(now).toISOString();
  await deps.db.prepare("INSERT INTO first_credentials(installation_id,program,username,ciphertext,iv,key_version,checked_at,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(installation_id,program) DO UPDATE SET username=excluded.username,ciphertext=excluded.ciphertext,iv=excluded.iv,key_version=first_credentials.key_version+1,checked_at=excluded.checked_at,updated_at=excluded.updated_at")
    .bind(installationId, program, username, encrypted.ciphertext, encrypted.iv, at, at).run();
  return program;
}

/** `DELETE /admin/integrations/first?program=`: forget the credential and FIRST's cached answers and season for that program. */
export async function removeFirstCredential(deps: FirstDataDeps, program: unknown): Promise<FirstEventsProgram> {
  if (!isFirstEventsProgram(program)) throw new HttpError(400, "Choose FRC or FTC");
  await deps.db.batch(["first_credentials", "first_team_cache", "first_seasons"].map((table) => deps.db.prepare(`DELETE FROM ${table} WHERE installation_id=? AND program=?`).bind(installationId, program)));
  return program;
}

/** `POST /admin/integrations/first/clear-cache`: forget every cached team answer and season, so the next lookups ask FIRST. */
export async function clearFirstCache(deps: FirstDataDeps): Promise<void> {
  await deps.db.batch(["first_team_cache", "first_seasons"].map((table) => deps.db.prepare(`DELETE FROM ${table} WHERE installation_id=?`).bind(installationId)));
}
