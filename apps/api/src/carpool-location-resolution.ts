import type { D1Database } from "./d1-usage.ts";
import { carpoolDirections, type CarpoolTripScope, type CarpoolStatePerson } from "../../../packages/shared/src/carpool-state.ts";

type Person = CarpoolStatePerson & { outboundLocationSource?: unknown; returnLocationSource?: unknown };
export type LocationDetail = { plan: { id: unknown; tripScope?: unknown }; people: Person[] };
type State = { input_key: string; state: "queued" | "running" | "complete" | "failed"; lease_token: string | null; lease_expires_at: string | null; error_code: string | null };

export function pendingCarpoolLocations(detail: LocationDetail) {
  return detail.people.flatMap(person => carpoolDirections((detail.plan.tripScope ?? "both") as CarpoolTripScope).filter(direction => ["offer", "needs-ride"].includes(person[`${direction}Status`]) && person[`${direction}Address`].trim() && (person[`${direction}Latitude`] === null || person[`${direction}Longitude`] === null) && person[`${direction}LocationSource`] !== "no-match").map(direction => ({ person, direction })));
}
async function inputKey(detail: LocationDetail) {
  const value = JSON.stringify({ scope: detail.plan.tripScope, people: detail.people.map(person => [person.id, ...carpoolDirections((detail.plan.tripScope ?? "both") as CarpoolTripScope).map(direction => [person[`${direction}Status`], person[`${direction}Address`], person[`${direction}Latitude`], person[`${direction}Longitude`], person[`${direction}LocationSource`] ?? null])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function carpoolLocationResolution(db: D1Database, detail: LocationDetail, configured: boolean) {
  const key = await inputKey(detail); const remaining = pendingCarpoolLocations(detail).length;
  const saved = await db.prepare("SELECT input_key,state,lease_token,lease_expires_at,error_code FROM carpool_location_resolution WHERE installation_id='primary' AND plan_id=?").bind(detail.plan.id).first<State>();
  if (!configured) return { inputKey: key, state: "unconfigured" as const, remaining };
  // A changed plan cannot start a second provider batch while an existing lease is active.
  if (saved?.state === "running") {
    if (saved.lease_expires_at! > new Date().toISOString()) return { inputKey: key, state: "running" as const, remaining };
    if (saved.input_key === key) return { inputKey: key, state: "failed" as const, remaining, errorCode: "interrupted" };
    return { inputKey: key, state: remaining ? "queued" as const : "complete" as const, remaining };
  }
  if (!remaining) return { inputKey: key, state: "complete" as const, remaining };
  return { inputKey: key, state: saved?.input_key === key ? saved.state : "queued" as const, remaining, ...(saved?.input_key === key && saved.error_code ? { errorCode: saved.error_code } : {}) };
}
export async function claimCarpoolLocationResolution(db: D1Database, detail: LocationDetail, retry: boolean) {
  const status = await carpoolLocationResolution(db, detail, true);
  if (status.state === "running" || !retry && status.state !== "queued") return null;
  const token = crypto.randomUUID(); const now = new Date().toISOString(); const expires = new Date(Date.now() + 90_000).toISOString();
  const claimed = await db.prepare("INSERT INTO carpool_location_resolution(installation_id,plan_id,input_key,state,lease_token,lease_expires_at,error_code) VALUES('primary',?,?,'running',?,?,NULL) ON CONFLICT(installation_id,plan_id) DO UPDATE SET input_key=excluded.input_key,state='running',lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,error_code=NULL WHERE (carpool_location_resolution.state<>'running' OR carpool_location_resolution.lease_expires_at<=?) AND (carpool_location_resolution.input_key<>excluded.input_key OR carpool_location_resolution.state='queued' OR ?=1)").bind(detail.plan.id, status.inputKey, token, expires, now, retry ? 1 : 0).run();
  return claimed.meta?.changes === 1 ? token : null;
}
export async function finishCarpoolLocationResolution(db: D1Database, detail: LocationDetail, token: string, errorCode?: "provider" | "conflict") {
  const state = errorCode ? "failed" : pendingCarpoolLocations(detail).length ? "queued" : "complete";
  await db.prepare("UPDATE carpool_location_resolution SET input_key=?,state=?,lease_token=NULL,lease_expires_at=NULL,error_code=? WHERE installation_id='primary' AND plan_id=? AND lease_token=?").bind(await inputKey(detail), state, errorCode ?? null, detail.plan.id, token).run();
}
