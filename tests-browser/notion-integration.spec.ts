import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

// Settings > Integrations > Notion: saving, checking, turning off and removing Core's shared Notion connection, what its
// token allows, and choosing each module's database, with every /admin/integrations/notion route answered here. Nothing
// reaches Notion. Every token, name, link and ID is synthetic.
type Capability = "ok" | "refused" | "unknown";
type Binding = { moduleId: string; moduleLabel: string; id: string; label: string; reason: string; required: boolean; operations: string[]; bound: boolean; databaseId: string | null; dataSourceId: string | null; name: string; link: string | null };
type Status = { saved: boolean; enabled: boolean; readable: boolean; encryption: boolean; botName: string; workspaceName: string; checkedAt: string | null; pausedUntil: string | null; capabilities: Record<"read" | "insert" | "update" | "comment" | "users" | "email", Capability>; revision: number; bindings: Binding[] };

const unknown = { read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "unknown", email: "unknown" } as const;
const binding = (moduleId: string, moduleLabel: string, id: string, label: string, reason: string, required: boolean): Binding => ({ moduleId, moduleLabel, id, label, reason, required, operations: ["query"], bound: false, databaseId: null, dataSourceId: null, name: "", link: null });
const connected = { saved: true, enabled: true, readable: true, botName: "Test Bot", workspaceName: "Test Workspace", checkedAt: "2026-11-26T16:00:00.000Z" };
const databaseId = "dddddddd-dddd-dddd-dddd-dddddddddd01";
const databaseLink = `https://www.notion.so/test-workspace/Orders-${databaseId.replaceAll("-", "")}`;

async function useNotion(page: Page, initial: Partial<Status> = {}) {
  const state: Status = {
    saved: false, enabled: false, readable: false, encryption: true, botName: "", workspaceName: "", checkedAt: null, pausedUntil: null, capabilities: { ...unknown }, revision: 0,
    bindings: [binding("part-requests", "Part Requests", "orders", "Ordering database", "Part requests are added to this database.", true), binding("part-requests", "Part Requests", "people", "People database", "Names are read from this database.", false)],
    ...initial,
  };
  const writes: { method: string; url: string; body: unknown }[] = [];
  await page.route("**/admin/integrations/notion**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const body = request.postData() ? request.postDataJSON() as Record<string, any> : undefined;
    if (request.method() !== "GET") writes.push({ method: request.method(), url: url.pathname, body });
    const target = /\/bindings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (target) {
      const item = state.bindings.find((entry) => entry.moduleId === target[1] && entry.id === target[2])!;
      if (request.method() === "DELETE") { Object.assign(item, { bound: false, databaseId: null, dataSourceId: null, name: "", link: null }); return route.fulfill({ json: { bound: false, dataSources: [], integration: state } }); }
      if (String(body?.database).includes("not-shared")) return route.fulfill({ status: 400, json: { error: "Notion cannot access that database or page. Add the connection to the database and check its link." } });
      if (String(body?.database).includes("several") && !body?.dataSourceId) return route.fulfill({ json: { bound: false, dataSources: [{ id: "55555555-5555-5555-5555-555555555501", name: "Test Orders" }, { id: "55555555-5555-5555-5555-555555555502", name: "" }], integration: state } });
      Object.assign(item, { bound: true, databaseId, dataSourceId: body?.dataSourceId ?? "55555555-5555-5555-5555-555555555501", name: body?.dataSourceId?.endsWith("02") ? "" : "Test Orders", link: `https://www.notion.so/${databaseId.replaceAll("-", "")}` });
      state.capabilities.read = "ok";
      return route.fulfill({ json: { bound: true, dataSources: [], integration: state } });
    }
    if (request.method() === "PUT") {
      if (body?.revision !== state.revision) return route.fulfill({ status: 409, json: { error: "The Notion connection changed since this page loaded. Review it and try again.", code: "notion_connection_changed" } });
      if (body?.token !== undefined) {
        if (body.token !== "ntn_synthetic_token_0001") return route.fulfill({ status: 400, json: { error: "Notion did not accept this token. Check it and save again." } });
        Object.assign(state, connected, { capabilities: { ...unknown, users: "ok", email: "refused" } });
      } else if (body?.check) Object.assign(state, { checkedAt: "2026-11-27T16:00:00.000Z" });
      else state.enabled = Boolean(body?.enabled);
      state.revision += 1;
    }
    if (request.method() === "DELETE") Object.assign(state, { revision: 0, saved: false, enabled: false, readable: false, botName: "", workspaceName: "", checkedAt: null, capabilities: { ...unknown } });
    await route.fulfill({ json: state });
  });
  // The state rides along, hidden from comparisons of the writes, so a test can change it as another Admin would.
  return Object.defineProperty(writes, "state", { value: state, enumerable: false }) as typeof writes & { state: Status };
}
const card = (page: Page) => page.locator(".notion-integration");
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const viewport of dashboardConformanceReferences.viewports) {
  test(`an Admin connects Notion and chooses a module's database at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    if (viewport.width < 768) { await page.emulateMedia({ colorScheme: "dark" }); await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark")); }
    const writes = await useNotion(page);
    await page.goto("/settings/integrations");
    const notion = card(page);
    await expect(notion.getByRole("heading", { name: "Notion", exact: true })).toBeVisible();
    await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Not connected");
    await expect(notion.getByRole("link", { name: /integration settings/ })).toHaveAttribute("href", "https://www.notion.so/profile/integrations");
    // The Notion card follows Discord, so the FIRST card keeps its place just before it.
    await expect(page.locator(".integration-grid > .integration-card").last()).toHaveClass(/notion-integration/);

    const connection = notion.getByRole("form", { name: "Connection" });
    const save = connection.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled(); await expect(save).toHaveClass(/ui-button--primary/);
    await expect(connection.getByRole("button", { name: "Check" })).toHaveCount(0); await expect(connection.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(notion.getByRole("switch", { name: "Enable Notion" })).toHaveCount(0);
    await expect(notion.getByRole("region", { name: "What the token allows" })).toHaveCount(0);
    // Until Notion is connected a database cannot be chosen.
    const orders = notion.getByRole("form", { name: "Ordering database" });
    await expect(orders.locator(".status-pill")).toHaveText("Not chosen");
    await expect(orders.getByLabel("Database link")).toBeDisabled();
    await expect(notion.getByRole("form", { name: "People database (optional)" })).toContainText("Names are read from this database.");

    await connection.getByLabel("Integration token").fill("ntn_wrong_token_0009");
    await save.click();
    await expect(connection.getByRole("alert")).toHaveText("Notion did not accept this token. Check it and save again.");
    await connection.getByLabel("Integration token").fill("ntn_synthetic_token_0001");
    // The form submits from the keyboard.
    await connection.getByLabel("Integration token").press("Enter");
    await expect(connection.getByRole("status").filter({ hasText: "accepted" })).toHaveText("Notion accepted the token.");
    await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Connected");
    await expect(connection).toContainText(/Connected as Test Bot in Test Workspace\. Checked /);
    await expect(connection.getByLabel("Integration token")).toHaveValue(""); await expect(connection.getByLabel("Integration token")).toHaveAttribute("placeholder", "Saved, hidden");
    await expect(connection.getByRole("button", { name: "Save", exact: true })).not.toHaveClass(/ui-button--primary/);

    // The five capabilities, in Notion's words, with what has been seen of each.
    const capabilities = notion.getByRole("region", { name: "What the token allows" }).getByRole("listitem");
    await expect(capabilities).toHaveText(["Read contentNot used yet", "Insert contentNot used yet", "Update contentNot used yet", "Insert commentsNot used yet", "Read user information Without email addressesWorking"]);

    await connection.getByRole("button", { name: "Check" }).click();
    await expect(connection.getByRole("status").filter({ hasText: "saved token" })).toHaveText("Notion accepted the saved token.");
    const toggle = notion.getByRole("switch", { name: "Enable Notion" });
    await expect(toggle).toBeChecked();
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Turned off");
    await expect(orders.getByLabel("Database link")).toBeDisabled();
    await page.keyboard.press("Space");
    await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Connected");

    // Choosing a database: a database the integration was not added to, one with several data sources, then one that saves.
    const link = orders.getByLabel("Database link");
    await expect(orders.getByRole("button", { name: "Save database" })).toBeDisabled();
    await link.fill("https://www.notion.so/test-workspace/not-shared");
    await orders.getByRole("button", { name: "Save database" }).click();
    await expect(orders.getByRole("alert")).toHaveText("Notion cannot access that database or page. Add the connection to the database and check its link.");
    await link.fill("https://www.notion.so/test-workspace/several");
    await orders.getByRole("button", { name: "Save database" }).click();
    await expect(orders.getByRole("status").filter({ hasText: "data source" })).toHaveText("This database has more than one data source. Choose one, then save.");
    await expect(orders.getByLabel("Data source").locator("option")).toHaveText(["Test Orders", "Untitled data source"]);
    await link.fill(databaseLink);
    await expect(orders.getByLabel("Data source")).toHaveCount(0);
    await orders.getByRole("button", { name: "Save database" }).click();
    await expect(orders.locator(".status-pill")).toHaveText("Chosen");
    await expect(orders.getByRole("link", { name: /Test Orders/ })).toHaveAttribute("href", `https://www.notion.so/${databaseId.replaceAll("-", "")}`);
    await expect(orders.getByLabel("Change to another database link")).toHaveValue("");
    await expect(capabilities.first()).toHaveText("Read contentWorking");
    page.once("dialog", (dialog) => void dialog.accept());
    await orders.getByRole("button", { name: "Clear" }).click();
    await expect(orders.locator(".status-pill")).toHaveText("Not chosen");

    expect(writes).toEqual([
      // Each change names the revision the page last loaded.
      { method: "PUT", url: "/admin/integrations/notion", body: { token: "ntn_wrong_token_0009", revision: 0 } }, { method: "PUT", url: "/admin/integrations/notion", body: { token: "ntn_synthetic_token_0001", revision: 0 } },
      { method: "PUT", url: "/admin/integrations/notion", body: { check: true, revision: 1 } }, { method: "PUT", url: "/admin/integrations/notion", body: { enabled: false, revision: 2 } }, { method: "PUT", url: "/admin/integrations/notion", body: { enabled: true, revision: 3 } },
      { method: "PUT", url: "/admin/integrations/notion/bindings/part-requests/orders", body: { database: "https://www.notion.so/test-workspace/not-shared" } },
      { method: "PUT", url: "/admin/integrations/notion/bindings/part-requests/orders", body: { database: "https://www.notion.so/test-workspace/several" } },
      { method: "PUT", url: "/admin/integrations/notion/bindings/part-requests/orders", body: { database: databaseLink } },
      { method: "DELETE", url: "/admin/integrations/notion/bindings/part-requests/orders", body: undefined },
    ]);
    expect(await noSideScroll(page)).toBe(true);
  });
}

test("a token that can't be read asks to be saved again, capabilities show refusals, and Remove keeps chosen databases", async ({ page }) => {
  const chosen = { ...binding("part-requests", "Part Requests", "orders", "Ordering database", "Part requests are added to this database.", true), bound: true, databaseId, dataSourceId: "55555555-5555-5555-5555-555555555501", name: "Test Orders", link: `https://www.notion.so/${databaseId.replaceAll("-", "")}` };
  const writes = await useNotion(page, { ...connected, readable: false, capabilities: { read: "ok", insert: "refused", update: "unknown", comment: "unknown", users: "ok", email: "ok" }, bindings: [chosen] });
  await page.goto("/settings/integrations");
  const notion = card(page); const connection = notion.getByRole("form", { name: "Connection" });
  await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Saved, but can't be read");
  await expect(connection.getByRole("status")).toHaveText("Saved, but can't be read. Save it again.");
  await expect(connection.getByRole("button", { name: "Check" })).toHaveCount(0);
  await expect(notion.getByRole("region", { name: "What the token allows" }).getByRole("listitem")).toHaveText(["Read contentWorking", "Insert contentRefused by Notion", "Update contentNot used yet", "Insert commentsNot used yet", "Read user information Including email addressesWorking"]);
  const orders = notion.getByRole("form", { name: "Ordering database" });
  await expect(orders.locator(".status-pill")).toHaveText("Chosen");
  await expect(orders.getByLabel("Change to another database link")).toBeDisabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await connection.getByRole("button", { name: "Remove" }).click();
  await expect(connection.getByRole("status")).toHaveText("The Notion token is removed.");
  await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Not connected");
  await expect(orders.locator(".status-pill")).toHaveText("Chosen");
  expect(writes).toEqual([{ method: "DELETE", url: "/admin/integrations/notion", body: undefined }]);
});

test("a change made in another window is reported, and the card shows what is saved now", async ({ page }) => {
  const writes = await useNotion(page, { ...connected, revision: 4 });
  await page.goto("/settings/integrations");
  const notion = card(page); const connection = notion.getByRole("form", { name: "Connection" });
  await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Connected");
  // Another Admin turns the connection off after this page loaded.
  Object.assign(writes.state, { enabled: false, revision: 5 });
  await connection.getByRole("button", { name: "Check" }).click();
  await expect(connection.getByRole("alert")).toHaveText("The Notion connection changed since this page loaded. Review it and try again.");
  await expect(notion.locator(".notion-integration-heading .status-pill")).toHaveText("Turned off");
  await expect(notion.getByRole("switch", { name: "Enable Notion" })).not.toBeChecked();
  // The next change starts from the reloaded revision and goes through.
  await connection.getByRole("button", { name: "Check" }).click();
  await expect(connection.getByRole("status").filter({ hasText: "saved token" })).toHaveText("Notion accepted the saved token.");
  expect(writes.map((write) => write.body)).toEqual([{ check: true, revision: 4 }, { check: true, revision: 5 }]);
});

test("with no module using Notion the card says so, and a typed token holds the page until it is saved", async ({ page }) => {
  await useNotion(page, { bindings: [] });
  await page.goto("/settings/integrations");
  await expect(card(page).getByRole("region", { name: "Databases" })).toContainText("No installed module uses Notion yet.");
  const token = card(page).getByRole("form", { name: "Connection" }).getByLabel("Integration token");
  await token.click(); await token.fill("ntn_synthetic_token_0001");
  const prompted = new Promise<string>((resolve) => page.once("dialog", (dialog) => { resolve(dialog.type()); void dialog.accept(); }));
  await page.close({ runBeforeUnload: true });
  expect(await prompted).toBe("beforeunload");
});
