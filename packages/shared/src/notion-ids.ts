// Pure helpers for Notion IDs and links, shared by the Worker, the dashboard and plugins (module SDK 1.8.0). Nothing
// here calls Notion. Traps these record: a Notion link redirects to wherever the workspace lives, so links are parsed and
// never followed; a `?v=` value names a view, not the database; and Notion reports the same property ID percent-encoded
// in some places and plain in others, so property IDs are compared decoded.

const notionHosts = ["notion.so", "notion.com", "notion.site"];
const onNotionHost = (hostname: string) => notionHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
const idPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?:\/)?$/i;

export type NotionIdResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

/** A Notion ID in its dashed form (8-4-4-4-12, lower case), or undefined when the value is not 32 hex digits. */
export function formatNotionId(value: unknown): string | undefined {
  const hex = typeof value === "string" ? value.trim().replaceAll("-", "").toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
}

/** Whether two Notion IDs name the same object, whichever form (dashed or plain) each is in. */
export function sameNotionId(left: unknown, right: unknown): boolean {
  const first = formatNotionId(left);
  return first !== undefined && first === formatNotionId(right);
}

/**
 * The database or page ID in a Notion link or a bare ID, with a message an Admin can act on when there is none. Only
 * https links on Notion's own hosts are read. A `?v=` value identifies a view and is ignored.
 */
export function parseNotionId(input: unknown): NotionIdResult {
  if (typeof input !== "string" || !input.trim() || input.length > 2000) return { ok: false, error: "Enter a Notion link or ID." };
  let path = input.trim();
  if (/^https?:/i.test(path)) {
    let url: URL;
    try { url = new URL(path); } catch { return { ok: false, error: "Enter a valid Notion link or ID." }; }
    if (url.protocol !== "https:" || url.username || url.password || !onNotionHost(url.hostname)) return { ok: false, error: "Use a Notion page or database link." };
    path = url.pathname;
  }
  const id = formatNotionId(idPattern.exec(path)?.[1]);
  return id ? { ok: true, id } : { ok: false, error: "The link must contain a Notion page or database ID. Copy its full link from Notion." };
}

/** A link to a database or page from its ID. Notion redirects it to wherever the workspace lives. */
export function notionLink(id: string): string {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

/** The link as given when it is an https link on one of Notion's hosts, else undefined. For links Notion returns. */
export function validNotionUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && onNotionHost(url.hostname) ? url.href : undefined;
  } catch { return undefined; }
}

/** A Notion property ID decoded, so an encoded and a plain copy of the same ID compare equal. */
export function decodedNotionPropertyId(id: unknown): string {
  try { return decodeURIComponent(String(id)); } catch { return String(id); }
}
