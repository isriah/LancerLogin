import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { decryptIntegration, encryptIntegration } from "./integration-crypto.ts";
import { GeoapifyCarpoolGeocoder } from "./carpool-geocoding.ts";

export const carpoolDefaultDistances = Object.freeze({ radiusMiles: 12, preferredRadiusMiles: 4 });
type Credentials = { ciphertext: string | null; iv: string | null; disabled: number };

export async function readCarpoolDefaults(db: D1Database) {
  const row = await db.prepare("SELECT radius_miles AS radiusMiles,preferred_radius_miles AS preferredRadiusMiles,revision FROM carpool_settings WHERE installation_id='primary'").first<{ radiusMiles: number; preferredRadiusMiles: number; revision: number }>();
  return row ?? { ...carpoolDefaultDistances, revision: 0 };
}

export async function readCarpoolGeocoder(db: D1Database, encryptionKey?: string, legacyKey?: string) {
  const row = await db.prepare("SELECT ciphertext,iv,disabled FROM carpool_geocoding_credentials WHERE installation_id='primary'").first<Credentials>();
  if (row?.disabled) return undefined;
  if (row?.ciphertext && row.iv) {
    if (!encryptionKey) throw new HttpError(503, "Carpool credential encryption is unavailable");
    try {
      const secret = await decryptIntegration(row.ciphertext, row.iv, encryptionKey);
      if (!secret.apiKey?.trim()) throw new Error("Invalid credential");
      return new GeoapifyCarpoolGeocoder(secret.apiKey);
    } catch { throw new HttpError(503, "Carpool credentials could not be read. Save the API key again in Carpool settings."); }
  }
  return legacyKey?.trim() ? new GeoapifyCarpoolGeocoder(legacyKey.trim()) : undefined;
}

export async function carpoolSettingsRoute(db: D1Database, actor: string, request: Request, input: unknown, encryptionKey?: string, legacyKey?: string) {
  async function status() {
    const [defaults, credentials] = await Promise.all([readCarpoolDefaults(db), db.prepare("SELECT ciphertext,iv,disabled FROM carpool_geocoding_credentials WHERE installation_id='primary'").first<Credentials>()]);
    return { ...defaults, geocodingConfigured: !credentials?.disabled && Boolean(credentials?.ciphertext || legacyKey?.trim()), canSaveApiKey: Boolean(encryptionKey) };
  }
  if (request.method === "GET") return status();
  if (request.method !== "PUT") throw new HttpError(405, "Use GET or PUT for Carpool settings");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Provide Carpool settings");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["radiusMiles", "preferredRadiusMiles", "revision", "apiKey", "removeApiKey"].includes(key))) throw new HttpError(400, "Unknown Carpool setting");
  const { radiusMiles, preferredRadiusMiles, revision } = value;
  if (typeof radiusMiles !== "number" || !Number.isFinite(radiusMiles) || radiusMiles < 0.5 || radiusMiles > 250 || typeof preferredRadiusMiles !== "number" || !Number.isFinite(preferredRadiusMiles) || preferredRadiusMiles < 0.5 || preferredRadiusMiles > radiusMiles) throw new HttpError(400, "Preferred radius must be between 0.5 miles and the maximum radius, up to 250 miles");
  if (!Number.isSafeInteger(revision) || Number(revision) < 0 || Number(revision) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "Provide the current Carpool settings revision");
  if (value.removeApiKey !== undefined && typeof value.removeApiKey !== "boolean") throw new HttpError(400, "Choose whether to remove the API key");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !value.apiKey.trim() || value.apiKey.length > 1000 || /\s/.test(value.apiKey.trim()))) throw new HttpError(400, "Provide a valid Geoapify API key");
  if (value.apiKey && value.removeApiKey) throw new HttpError(400, "Choose to save or remove the API key");
  if (value.apiKey && !encryptionKey) throw new HttpError(503, "Carpool credential encryption is unavailable");
  const encrypted = value.apiKey ? await encryptIntegration({ apiKey: String(value.apiKey).trim() }, encryptionKey!) : null;
  const now = new Date().toISOString(); const auditId = crypto.randomUUID();
  const statements = [
    db.prepare("INSERT INTO carpool_settings(installation_id,radius_miles,preferred_radius_miles,revision,updated_at) SELECT 'primary',?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM carpool_settings WHERE installation_id='primary' AND revision=?) ON CONFLICT(installation_id) DO UPDATE SET radius_miles=excluded.radius_miles,preferred_radius_miles=excluded.preferred_radius_miles,revision=carpool_settings.revision+1,updated_at=excluded.updated_at WHERE carpool_settings.revision=?").bind(radiusMiles, preferredRadiusMiles, now, revision, revision, revision),
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,'primary',?,'carpool.settings_updated','carpool_settings','primary',? WHERE changes()=1").bind(auditId, actor, now),
  ];
  if (encrypted || value.removeApiKey) statements.push(db.prepare("INSERT INTO carpool_geocoding_credentials(installation_id,ciphertext,iv,disabled) SELECT 'primary',?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=? AND installation_id='primary') ON CONFLICT(installation_id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,disabled=excluded.disabled").bind(encrypted?.ciphertext ?? null, encrypted?.iv ?? null, value.removeApiKey ? 1 : 0, auditId));
  const results = await db.batch(statements);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) throw new HttpError(409, "Carpool settings changed. Reload before saving.");
  return status();
}
