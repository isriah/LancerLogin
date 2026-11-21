import { apiBaseUrl } from "./dashboard-api";
import { downloadBackup, TransferRefused, type DownloadInput, type TransferRequest } from "./backup-transfer";

/** Sends a backup or restore request to the API with the signed-in session. */
export const transferRequest: TransferRequest = (path, init) => fetch(`${apiBaseUrl}${path}`, {
  method: init?.method ?? "GET", credentials: "include", cache: "no-store",
  ...(init?.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: init.body as BodyInit }),
});

/**
 * Download a backup file: in parts, or in one request when the API cannot stage one (an earlier release, or writes
 * suspended for an update). Throws TransferRefused with the API's answer when the backup is refused.
 */
export async function fetchBackup(input: DownloadInput): Promise<{ blob: Blob; filename: string }> {
  const staged = await downloadBackup(transferRequest, input);
  if (staged) return { blob: new Blob([staged.text], { type: "application/json" }), filename: staged.filename };
  const update = input.updateRequestId ? `&updateRequestId=${encodeURIComponent(input.updateRequestId)}` : "";
  const result = await fetch(`${apiBaseUrl}/admin/data/backup?scope=${input.scope}${update}`, { credentials: "include", cache: "no-store" });
  if (!result.ok) throw new TransferRefused(result);
  return { blob: await result.blob(), filename: result.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `lancerlogin-${input.scope}-backup.json` };
}
