// Example-owned queries. Every statement touches only example_ tables or reads Core identity.
export async function countOpenItems(db: any, installationId: string, title?: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM example_items WHERE installation_id = ? AND closed = 0${title ? " AND title = ?" : ""}`).bind(...(title ? [installationId, title] : [installationId])).first();
  return Number(row?.count ?? 0);
}

export async function itemsWithRequests(db: any, installationId: string): Promise<{ id: string; title: string; requests: number }[]> {
  const result = await db.prepare("SELECT i.id, i.title, COUNT(r.id) AS requests FROM example_items i LEFT JOIN example_requests r ON r.installation_id = i.installation_id AND r.item_id = i.id WHERE i.installation_id = ? GROUP BY i.id, i.title ORDER BY i.title").bind(installationId).all();
  return (result.results ?? []).map((row: any) => ({ id: String(row.id), title: String(row.title), requests: Number(row.requests) }));
}
