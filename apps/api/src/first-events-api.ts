// FIRST's FRC Events API v3 and FTC Events API v2, read with an Admin's username and token: request URLs, Basic auth,
// the current season, reading one team from a team list, credential input, and one bounded request to FIRST. Ported
// from Guest Visits' team lookup. Only the team number and the credential ever go to FIRST.

export type FirstEventsProgram = "FRC" | "FTC";
export const firstEventsPrograms = ["FRC", "FTC"] as const satisfies readonly FirstEventsProgram[];
export const isFirstEventsProgram = (value: unknown): value is FirstEventsProgram => firstEventsPrograms.includes(value as FirstEventsProgram);

const firstApiBase: Readonly<Record<FirstEventsProgram, string>> = {
  FRC: "https://frc-api.firstinspires.org/v3.0",
  FTC: "https://ftc-api.firstinspires.org/v2.0",
};

/** The API root, which reports `currentSeason`. */
export const firstRootUrl = (program: FirstEventsProgram) => `${firstApiBase[program]}/`;
/** A season summary: the one authenticated call that checks a credential. */
export const firstSeasonUrl = (program: FirstEventsProgram, season: number) => `${firstApiBase[program]}/${season}`;
/** One team by number in a season's team list. */
export const firstTeamsUrl = (program: FirstEventsProgram, season: number, number: string) => `${firstApiBase[program]}/${season}/teams?teamNumber=${encodeURIComponent(number)}`;

/** HTTP Basic auth for a FIRST credential. Usernames and tokens are printable ASCII (see `parseFirstCredential`). */
export const basicAuthorization = (username: string, token: string) => `Basic ${btoa(`${username}:${token}`)}`;

/** Each request to FIRST gives up after this long. */
export const firstTimeoutMs = 4_000;

/** FIRST's status and answer: parsed JSON, or null with the first part of the text when the answer is not JSON. */
export type FirstReply = { readonly status: number; readonly body: unknown; readonly text: string };
/** Why FIRST gave no answer: it did not answer in time, or the request failed. */
export type FirstFailure = { readonly failure: "timeout" | "provider-error" };

/** One request to FIRST, given up after `firstTimeoutMs`. Never throws; a failed or late request is a `FirstFailure`. */
export async function firstRequest(fetcher: typeof fetch, url: string, init: { readonly authorization?: string; readonly body?: unknown } = {}): Promise<FirstReply | FirstFailure> {
  try {
    const headers: Record<string, string> = { accept: "application/json", ...init.authorization ? { authorization: init.authorization } : {}, ...init.body === undefined ? {} : { "content-type": "application/json" } };
    const response = await fetcher(url, { method: init.body === undefined ? "GET" : "POST", headers, ...init.body === undefined ? {} : { body: JSON.stringify(init.body) }, signal: AbortSignal.timeout(firstTimeoutMs) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { status: response.status, body: null, text: "" }; }
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text.replace(/^﻿/, "")); } catch { /* Not JSON: the text alone is kept. */ }
    return { status: response.status, body, text: body === null ? text.slice(0, 2000) : "" };
  } catch (error) {
    return { failure: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "provider-error" };
  }
}
export const isFirstFailure = (reply: FirstReply | FirstFailure): reply is FirstFailure => "failure" in reply;

const maximumLocationLength = 200;
const maximumFirstNameLength = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();
const textOf = (value: unknown) => typeof value === "string" ? singleLine(value) : "";

const plausibleSeason = (value: unknown): number | null => {
  const season = typeof value === "string" && /^\s*\d{4}\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(season) && (season as number) >= 2000 && (season as number) <= 2999 ? season as number : null;
};

/**
 * The current season from an API root answer: `currentSeason` as a number or a numeric string, in any letter case, or that
 * name followed by a year in an answer that is not JSON. Null when missing or not a plausible year.
 */
export function currentSeasonOf(body: unknown, text = ""): number | null {
  const key = isRecord(body) ? Object.keys(body).find((name) => name.toLowerCase() === "currentseason") : undefined;
  const season = key ? plausibleSeason((body as Record<string, unknown>)[key]) : null;
  return season ?? plausibleSeason(/currentSeason\W{0,5}(\d{4})/i.exec(text)?.[1]);
}

/**
 * The season FIRST is most likely in when its root does not say: FRC names seasons for the year of their competitions,
 * FTC for the year they start in September.
 */
export function likelySeason(program: FirstEventsProgram, now: number): number {
  const date = new Date(now);
  return program === "FTC" && date.getUTCMonth() < 8 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
}

/** "City, StateProv" in the USA and Canada, "City, Country" elsewhere, the known parts only, or empty. */
export function teamLocation(team: { readonly city?: unknown; readonly stateProv?: unknown; readonly country?: unknown }): string {
  const country = textOf(team.country);
  const region = /^(USA|United States|Canada)$/i.test(country) ? textOf(team.stateProv) : country;
  return [textOf(team.city), region].filter(Boolean).join(", ").slice(0, maximumLocationLength);
}

/** A record with lower-case keys, so FIRST's answers read the same whatever case its field names use. */
const keyed = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));

/**
 * The team with this number in a `{ teams: [...] }` answer: its short name (or full name) and location. Null when the
 * list has no such team, undefined when the answer is not a team list. A team FIRST lists without a name counts as none.
 */
export function eventsTeamOf(body: unknown, number: string): { readonly name: string; readonly location: string } | null | undefined {
  const list = isRecord(body) ? keyed(body).teams : undefined;
  if (!Array.isArray(list)) return undefined;
  const team = list.filter(isRecord).map(keyed).find((item) => String(item.teamnumber) === number);
  const name = team ? (textOf(team.nameshort) || textOf(team.namefull)).slice(0, maximumFirstNameLength).trim() : "";
  return name ? { name, location: teamLocation({ city: team!.city, stateProv: team!.stateprov, country: team!.country }) } : null;
}

export type FirstCredentialInput = { readonly program: FirstEventsProgram; readonly username: string; readonly token: string };
export type FirstCredentialProblem = { readonly ok: false; readonly field: "program" | "username" | "token"; readonly error: string };

/**
 * A FIRST credential to check and save. Both parts are printable ASCII, as Basic auth needs; the username has no colon
 * and the token no spaces.
 */
export function parseFirstCredential(value: Record<string, unknown>): { readonly ok: true; readonly value: FirstCredentialInput } | FirstCredentialProblem {
  const problem = (field: FirstCredentialProblem["field"], error: string): FirstCredentialProblem => ({ ok: false, field, error });
  if (!isFirstEventsProgram(value.program)) return problem("program", "Choose FRC or FTC");
  const username = typeof value.username === "string" ? value.username.trim() : "";
  if (!username) return problem("username", "Enter the FIRST API username");
  if (username.length > 100 || !/^[\x20-\x39\x3b-\x7e]+$/.test(username)) return problem("username", "Enter the username exactly as FIRST sent it: at most 100 letters, digits and symbols, without a colon");
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!token) return problem("token", "Enter the FIRST API token");
  if (token.length > 200 || !/^[\x21-\x7e]+$/.test(token)) return problem("token", "Enter the token exactly as FIRST sent it, without spaces");
  return { ok: true, value: { program: value.program, username, token } };
}
