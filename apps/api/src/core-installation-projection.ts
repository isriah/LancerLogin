import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

/** Stable Core projection: the installation's IANA time zone, for modules that show or interpret local dates and times. */
export async function installationTimeZone(db: D1Database, installationId: string): Promise<string> {
  const row = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
  if (!row?.timeZone) throw new HttpError(409, "The installation time zone is not configured");
  return row.timeZone;
}
