import { pathToFileURL } from "node:url";

export async function readD1Usage({ accountId, token, date = new Date().toISOString().slice(0, 10), dailyLimit = 5_000_000, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  const start = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) throw new Error("Use a valid UTC date in YYYY-MM-DD format.");
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw new Error("Daily row-read budget must be a positive integer.");
  const query = `query($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { databaseId } sum { rowsRead rowsWritten readQueries writeQueries }
      }
    } }
  }`;
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: accountId, filter: { datetimeHour_geq: start.toISOString(), datetimeHour_lt: new Date(start.getTime() + 86_400_000).toISOString() } } }),
  });
  if (!response.ok) throw new Error(`Cloudflare analytics request failed (${response.status}).`);
  const result = await response.json();
  const rows = result.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (result.errors?.length || !Array.isArray(rows)) throw new Error("Cloudflare analytics are unavailable. Check the account and analytics-read permission.");
  const databases = new Map();
  for (const row of rows) {
    const id = row.dimensions.databaseId;
    const total = databases.get(id) ?? { databaseId: id, rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
    for (const field of ["rowsRead", "rowsWritten", "readQueries", "writeQueries"]) {
      const value = row.sum?.[field];
      if (!Number.isFinite(value) || value < 0) throw new Error("Cloudflare returned incomplete usage metrics.");
      total[field] += value;
    }
    databases.set(id, total);
  }
  const totalRowsRead = [...databases.values()].reduce((sum, row) => sum + row.rowsRead, 0);
  const usedPercent = totalRowsRead / dailyLimit * 100;
  return { date, capturedAt: new Date().toISOString(), dailyLimit, totalRowsRead, usedPercent,
    level: usedPercent >= 90 ? "critical" : usedPercent >= 75 ? "warning" : usedPercent >= 50 ? "watch" : "normal",
    databases: [...databases.values()].sort((a, b) => b.rowsRead - a.rowsRead),
    note: "Account-wide UTC-day analytics can lag and need not reconcile exactly with query insights or billing enforcement." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [date, budget] = process.argv.slice(2);
    const report = await readD1Usage({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, date, ...(budget ? { dailyLimit: Number(budget) } : {}) });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
