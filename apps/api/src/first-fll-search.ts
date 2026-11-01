// FIRST LEGO League teams from FIRST's public team search, the search behind firstinspires.org's team finder. FIRST's IT
// confirmed it is an intentional public search, though undocumented, so it needs no username or token and the request
// carries no Authorization header. Only the team number and the program go to FIRST.
//
// The search answers `{ results: [...] }`, one entry per team per season. FIRST reuses team numbers across programs and
// seasons, so one number can return FRC, FTC, Challenge and Explore entries from many years, and different teams in
// different years. The request asks for the number and the program, and `parseFllSearch` checks both again itself
// rather than trusting the search to have filtered, then keeps the latest season's entry.
import type { FirstTeam } from "./first-data.ts";
import { teamLocation } from "./first-events-api.ts";

export type FllProgram = "Challenge" | "Explore";

export const fllSearchEnabled = true;
export const fllSearchUrl = "https://3dl2fnsh51.execute-api.us-east-1.amazonaws.com/prod/first-search";
/** Entries asked for: enough for every season one number has been used in one program. */
export const fllSearchSize = 50;

/** FIRST's program codes in its team index (`ff_team_type`): FLL Challenge is FLL, FLL Explore is JFLL. */
export const fllProgramCodes: Readonly<Record<FllProgram, string>> = { Challenge: "FLL", Explore: "JFLL" };

/**
 * The search body for one team number in one FLL program, across every season's team index. It matches the number field
 * only: a free-text search also matches FIRST's internal IDs, so it can return an unrelated team.
 */
export function fllSearchRequest(program: FllProgram, number: string) {
  return {
    index: "teams_*",
    query: {
      size: fllSearchSize,
      query: { bool: { must: [{ match: { team_number_yearly: number } }, { match: { ff_team_type: fllProgramCodes[program] } }] } },
    },
  };
}

const maximumNameLength = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const yearOf = (value: unknown): number | null => {
  const year = typeof value === "string" && /^\s*\d{4}\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(year) && (year as number) >= 2000 && (year as number) <= 2999 ? year as number : null;
};
const modifiedOf = (value: unknown) => { const time = typeof value === "string" ? Date.parse(value) : NaN; return Number.isNaN(time) ? -Infinity : time; };

type Entry = { readonly name: string; readonly location: string; readonly season: number; readonly current: boolean; readonly modified: number };

/**
 * The team with this number in this program from a search answer: null when FIRST has no such team, undefined when the
 * answer cannot be read. Only entries whose `team_number_yearly` is the number and whose `ff_team_type` is the program's
 * code count. Of those, the latest `profile_year` wins, then one flagged as the current season, then the latest
 * `modified_when`; the flag alone is not trusted, as FIRST leaves it unset on some current entries. The name is the
 * team's nickname, else `team_name_calc` (its sponsors or school); the location is formatted as for the Events APIs ("City, State" in the USA and Canada) with empty parts
 * left out. Matching entries that have no name or season are skipped, and an answer whose matching entries are all
 * unreadable is undefined, so a change in FIRST's format is never mistaken for "no such team".
 */
export function parseFllSearch(body: unknown, program: FllProgram, number: string): FirstTeam | null | undefined {
  const results = isRecord(body) ? body.results : undefined;
  if (!Array.isArray(results)) return undefined;
  const code = fllProgramCodes[program];
  const matching = results.filter(isRecord).filter((item) =>
    (typeof item.team_number_yearly === "string" || typeof item.team_number_yearly === "number") && String(item.team_number_yearly).trim() === number && item.ff_team_type === code);
  if (!matching.length) return null;
  const entries = matching.flatMap((item): Entry[] => {
    const name = (textOf(item.team_nickname) || textOf(item.team_name_calc)).slice(0, maximumNameLength).trim();
    const season = yearOf(item.profile_year);
    if (!name || season === null) return [];
    const location = teamLocation({ city: item.team_city, stateProv: item.team_stateprov, country: item.team_country });
    return [{ name, location, season, current: textOf(item.flag_current_season) === "1", modified: modifiedOf(item.modified_when) }];
  });
  const best = entries.reduce<Entry | undefined>((top, entry) =>
    !top || entry.season > top.season || entry.season === top.season && (entry.current !== top.current ? entry.current : entry.modified > top.modified) ? entry : top, undefined);
  return best ? { program, number, name: best.name, location: best.location, season: best.season, source: "first-search" } : undefined;
}
