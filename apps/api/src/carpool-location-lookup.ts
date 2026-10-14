import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { carpoolLocationCacheKey, normalizeCarpoolAddress, type CarpoolGeocodeBias, type CarpoolGeocodeTransport } from "./carpool-geocoding.ts";

export async function lookupCarpoolLocation(db: D1Database, provider: CarpoolGeocodeTransport, address: string, bias?: CarpoolGeocodeBias) {
  const key = carpoolLocationCacheKey(provider.id, address, bias);
  const cached = await db.prepare("SELECT status,latitude,longitude,label FROM carpool_location_cache WHERE installation_id=? AND cache_key=? AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))").bind("primary", key).first<{ status: "success" | "no-match"; latitude: number | null; longitude: number | null; label: string | null }>();
  if (cached) return { ...cached, lookupKey: key };
  let found;
  try { found = await provider.resolve(address, bias); } catch { throw new HttpError(502, "The location lookup service could not be reached. Try again or place a manual pin."); }
  if (found && (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude) || found.latitude < -90 || found.latitude > 90 || found.longitude < -180 || found.longitude > 180 || found.label !== undefined && (typeof found.label !== "string" || found.label.length > 500))) throw new HttpError(502, "The location lookup service returned an unusable pin. Place a manual pin instead.");
  const now = new Date(); const status = found ? "success" : "no-match"; const label = found?.label ?? null;
  await db.prepare("INSERT INTO carpool_location_cache(installation_id,cache_key,provider,normalized_address,original_address,status,latitude,longitude,label,saved_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,cache_key) DO UPDATE SET status=excluded.status,latitude=excluded.latitude,longitude=excluded.longitude,label=excluded.label,saved_at=excluded.saved_at,expires_at=excluded.expires_at")
    .bind("primary", key, provider.id, normalizeCarpoolAddress(address), address, status, found?.latitude ?? null, found?.longitude ?? null, label, now.toISOString(), found ? null : new Date(now.getTime() + 86_400_000).toISOString()).run();
  return { status: status as "success" | "no-match", latitude: found?.latitude ?? null, longitude: found?.longitude ?? null, label, lookupKey: key };
}
