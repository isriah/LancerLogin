/**
 * Guarded Web Storage access. Storage throws when site data is blocked, so every read falls back to null and every write
 * becomes a no-op for this visit.
 */
type Area = "local" | "session";
function area(name: Area) { return name === "local" ? window.localStorage : window.sessionStorage; }
export function readStorage(name: Area, key: string): string | null { try { return area(name).getItem(key); } catch { return null; } }
export function writeStorage(name: Area, key: string, value: string) { try { area(name).setItem(key, value); } catch { /* Storage is unavailable; keep the value for this visit only. */ } }
export function removeStorage(name: Area, key: string) { try { area(name).removeItem(key); } catch { /* Storage is unavailable. */ } }

/** Save a downloaded file. The link is attached and the object URL is revoked later, so slower browsers can finish starting the download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try { const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); }
  finally { window.setTimeout(() => URL.revokeObjectURL(url), 1_000); }
}
