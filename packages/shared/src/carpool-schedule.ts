import { instantToCivil, resolveCivilTime, selectCivilTime, type CivilTimeOccurrence } from "@lancerlogin/shared/civil-time";
import type { CarpoolTripScope } from "@lancerlogin/shared/carpool-state";

export type CarpoolSchedule = { timeZone: string; outboundDepartureAt: string | null; returnDepartureAt: string | null };
export function carpoolInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error("Provide a trip time as an exact UTC instant");
  const epoch = Date.parse(value); if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value.replace(/(?<=:\d{2})Z$/, ".000Z")) throw new Error("Provide a valid trip date and time");
  return new Date(epoch).toISOString();
}
export function validateCarpoolSchedule(value: { timeZone?: unknown; outboundDepartureAt?: unknown; returnDepartureAt?: unknown }, scope: CarpoolTripScope = "both"): CarpoolSchedule {
  const timeZone = value.timeZone === undefined ? "UTC" : value.timeZone;
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100 || timeZone !== timeZone.trim()) throw new Error("Choose a supported trip time zone");
  instantToCivil(0, timeZone);
  const outboundDepartureAt = carpoolInstant(value.outboundDepartureAt); const returnDepartureAt = carpoolInstant(value.returnDepartureAt);
  if (scope === "both" && outboundDepartureAt && returnDepartureAt && returnDepartureAt <= outboundDepartureAt) throw new Error("From-event departure must be after to-event departure");
  return { timeZone, outboundDepartureAt, returnDepartureAt };
}
export function carpoolLocalTime(instant: string | null | undefined, timeZone: string): { value: string; occurrence: "" | CivilTimeOccurrence } {
  if (!instant) return { value: "", occurrence: "" };
  const epoch = Date.parse(instant); const civil = instantToCivil(epoch, timeZone); const value = `${civil.date}T${civil.time.slice(6) === "00.000" ? civil.time.slice(0, 5) : civil.time}`;
  const candidates = resolveCivilTime({ date: civil.date, time: civil.time, timeZone });
  return { value, occurrence: candidates.length > 1 ? candidates.at(-1)!.epochMilliseconds === epoch ? "later" : "earlier" : "" };
}
export function carpoolLocalInstant(value: string, timeZone: string, occurrence: "" | CivilTimeOccurrence = ""): string | null {
  if (!value) return null;
  const [date, time] = value.split("T"); const candidate = selectCivilTime({ date: date ?? "", time: time ?? "", timeZone }, occurrence || undefined);
  return new Date(candidate.epochMilliseconds).toISOString();
}
export function formatCarpoolTime(instant: string | null | undefined, timeZone: string): string {
  if (!instant) return "Not specified";
  const epoch = Date.parse(instant); const civil = instantToCivil(epoch, timeZone);
  const repeated = resolveCivilTime({ date: civil.date, time: civil.time, timeZone }).length > 1;
  const offset = repeated ? new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(epoch).find(part => part.type === "timeZoneName")?.value : "";
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(instant)) + " (" + timeZone + ")" + (offset ? " " + offset : "");
}
