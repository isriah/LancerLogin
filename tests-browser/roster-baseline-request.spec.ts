import { expect, test } from "@playwright/test";

test("roster requests baseline-filtered attendance directly and retries the same current query", async ({ page }) => {
  const queries: string[] = [];
  let fail = true;
  await page.route("**/reports/attendance*", async (route) => {
    queries.push(new URL(route.request().url()).search);
    if (fail) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), baseline: "2026-01-01" } });
  });
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
  await expect(page.getByText("Attendance rates could not be loaded.", { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry attendance rates" }).click();
  await expect(page.getByText("Attendance rates could not be loaded.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Loading attendance rates…", { exact: true })).toHaveCount(0);
  expect(queries.length).toBeGreaterThan(1);
  expect(new Set(queries).size).toBe(1);
  const query = new URLSearchParams(queries[0]);
  expect(query.get("useBaseline")).toBe("true");
  expect(query.get("roster")).toBe("all");
  expect(query.has("from")).toBe(false);
});
