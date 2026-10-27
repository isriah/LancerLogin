import { expect, test, type Locator, type Page } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";
import { pairedViews } from "./paired-views";
import { requireOutreachPlugin } from "./outreach-fixtures";

requireOutreachPlugin();

const event = { id: "event-1", mode: "event", labelIds: [], labels: [], serviceDate: "2026-10-12", teamId: null, title: "Synthetic Outreach event", description: "Community service at the library", location: "Library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null };
const entry = (id: string, startLocal: string, endLocal: string, durationMinutes: number) => ({ id, memberId: "member-a", activityId: event.id, memberName: "Avery Synthetic", externalId: "SYN-A", activityTitle: event.title, serviceDate: event.serviceDate, startLocal, endLocal, durationMinutes, timeZone: "America/New_York", revision: 0, status: "counted", attribution: "self_asserted", taskNotes: "Original notes", createdAt: "2026-10-13T17:00:00.000Z" });

async function fixture(page: Page) {
  await page.clock.install({ time: new Date("2026-10-13T18:00:00Z") });
  const state = { activity: { ...event }, entries: [entry("entry-a", "09:00", "10:00", 60), entry("entry-b", "11:00", "12:30", 90)], writes: [] as Array<{ path: string; body: Record<string, unknown> }>, windows: [] as Record<string, unknown>[], publication: { activityId: event.id, revision: 0, googleCalendar: true, googleStatus: "delivered", googleAction: "publish", googleExternalId: "synthetic-google-id", googleError: null, discord: false, discordStatus: null, discordAction: null, discordExternalId: null, discordError: null } as Record<string, unknown>, labels: Array.from({ length: 41 }, (_, index) => ({ id: `label-${String(index).padStart(3, "0")}`, name: `Synthetic label ${String(index).padStart(3, "0")}`, archived: index === 40, revision: 0 })), teams: [{ id: "team-1", name: "Synthetic team", number: "101", program: "FTC", archived: false, revision: 0 }] };
  await page.route("**/platform/modules", route => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/auth/walkthroughs/*", route => route.fulfill({ json: { progress: { pageId: "outreach", version: 1, status: "completed", stepId: null } } }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", subtitle: "Member services", logoData: "", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } } }));
  await page.route("**/module-setup/hour-tracking/rules", route => route.fulfill({ json: { values: { reportingDays: 2, reopenHours: 24, revision: 0 } } }));
  await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method(); const body = method === "GET" ? undefined : route.request().postDataJSON();
    if (body) state.writes.push({ path, body });
    if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 2, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-10-13" } });
    if (path === "/admin/hours/member-choices") return route.fulfill({ json: { items: [{ id: "member-z", label: "Zoe Synthetic", externalId: "SYN-Z", active: true }, { id: "member-a", label: "Avery Synthetic", externalId: "SYN-A", active: true }, { id: "member-b", label: "Blake Synthetic", externalId: "SYN-B", active: true }], nextCursor: null } });
    if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: true, discord: true } });
    if (path === "/admin/hours/publication-settings") return route.fulfill({ json: { automatic: false, revision: 0 } });
    if (path === "/admin/hours/public-form-settings") return route.fulfill({ json: { memberValidation: "off", revision: 0 } });
    if (path === "/admin/hours/publications") return route.fulfill({ json: { items: [state.publication], nextCursor: null } });
    if (path === `/admin/hours/activities/${event.id}/publication`) {
      if (body) { const prefix = body.provider === "discord" ? "discord" : "google"; Object.assign(state.publication, { revision: Number(state.publication.revision) + 1, [prefix === "google" ? "googleCalendar" : "discord"]: true, [`${prefix}Status`]: "delivered", [`${prefix}Action`]: body.action ?? "publish", [`${prefix}ExternalId`]: `synthetic-${prefix}-id` }); }
      return route.fulfill({ json: state.publication });
    }
    if (path === `/admin/hours/activities/${event.id}` && body) { Object.assign(state.activity, body, { revision: state.activity.revision + 1 }); return route.fulfill({ json: state.activity }); }
    if (path === "/admin/hours/activities") return route.fulfill({ json: { items: [state.activity], nextCursor: null } });
    if (path === "/admin/hours/reopen-windows") {
      if (body) state.windows.push({ id: "window-1", activityId: event.id, startsMs: Date.parse("2026-10-13T18:00:00Z"), expiresMs: Date.parse("2026-10-14T18:00:00Z"), reason: body.reason, revoked: false, revision: 0, active: true });
      return route.fulfill({ json: body ? state.windows.at(-1) : { items: state.windows, nextCursor: null } });
    }
    if (path.startsWith("/admin/hours/entries/") && body) {
      const existing = state.entries.find(item => item.id === path.split("/").at(-1))!;
      Object.assign(existing, body, { status: body.action === "voided" ? "void" : "counted", revision: existing.revision + 1, durationMinutes: body.endLocal === "10:30" ? 90 : existing.durationMinutes }); return route.fulfill({ json: existing });
    }
    if (path === "/admin/hours/entries") return route.fulfill({ json: { items: state.entries, nextCursor: null } });
    const catalog = /^\/admin\/hours\/(teams|labels)(?:\/([^/]+))?$/.exec(path);
    if (catalog) {
      const kind = catalog[1] as "teams" | "labels"; const items = state[kind] as Array<Record<string, unknown>>;
      if (body) {
        if (catalog[2]) Object.assign(items.find(item => item.id === catalog[2])!, body);
        else items.push({ id: `${kind}-added`, ...body, revision: 0 });
        return route.fulfill({ json: items.at(-1) });
      }
      const archive = url.searchParams.get("archived") ?? "false"; const query = (url.searchParams.get("q") ?? "").toLowerCase(); const after = url.searchParams.get("after") ?? ""; const limit = Number(url.searchParams.get("limit") ?? 50);
      const matching = items.filter(item => (archive === "all" || Boolean(item.archived) === (archive === "true")) && `${item.name} ${item.number ?? ""} ${item.program ?? ""}`.toLowerCase().includes(query)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const remaining = matching.filter(item => String(item.id) > after); const shown = remaining.slice(0, limit);
      return route.fulfill({ json: { items: shown, nextCursor: remaining.length > limit ? shown.at(-1)!.id : null, total: matching.length, activeCount: items.filter(item => !item.archived).length, archivedCount: items.filter(item => item.archived).length } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

async function themed(page: Page, control: Locator, tone: "surface" | "primary" | "danger" = "surface", textToken = "--ui-text") {
  const style = await control.evaluate((element, { tone, textToken }) => {
    const app = element.closest(".app")!; const probe = document.createElement("span"); app.append(probe); const resolved = (token: string) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const actual = getComputedStyle(element); const colors = tone === "primary" ? ["--primary", "--on-primary", "--primary"] : tone === "danger" ? ["--ui-error-surface", "--ui-error", "--ui-error"] : ["--ui-surface-subtle", textToken, "--ui-border"];
    probe.style.borderRadius = "var(--radius-control)"; const result = { actual: [actual.backgroundColor, actual.color, actual.borderTopColor], expected: colors.map(resolved), radius: actual.borderRadius, expectedRadius: getComputedStyle(probe).borderRadius, height: element.getBoundingClientRect().height }; probe.remove(); return result;
  }, { tone, textToken });
  expect(style.actual).toEqual(style.expected); expect(style.radius).toBe(style.expectedRadius); expect(style.height).toBeGreaterThanOrEqual(44);
}

async function chooseClock(page: Page, label: string, hour: number, minute: number, period: "AM" | "PM") {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click(); const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: `${hour} o'clock`, exact: true }).click(); await dialog.getByRole("button", { name: `${minute} minutes`, exact: true }).click(); await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: period, exact: true }).click();
}

test("deleting the last counted participation hides the zero-hour person and retains the entry history", async ({ page }) => {
  const state = await fixture(page); state.entries.splice(1);
  await page.goto(`/hours/activities/${event.id}`);
  await page.getByRole("button", { name: "Details for Avery Synthetic" }).click();
  await page.locator('[data-entry-id="entry-a"]').getByRole("button", { name: /^Delete participation/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete participation" });
  await expect(dialog.getByLabel("Type DELETE PARTICIPATION")).toHaveCount(0);
  await dialog.getByLabel("Staff reason").fill("Duplicate synthetic submission");
  await dialog.getByRole("button", { name: "Delete participation", exact: true }).click();
  await expect(page.getByText("0.00 hours total", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Details for Avery Synthetic" })).toHaveCount(0);
  expect(state.entries).toHaveLength(1); expect(state.entries[0].status).toBe("void");
});

for (const theme of ["light", "dark"]) for (const width of [1280, 390]) test(`compact activity controls retain entry history and themes at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), theme); const state = await fixture(page);
  await page.goto(`/hours/activities/${event.id}`); await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Event publication", exact: true })).toHaveCount(0); await expect(page.getByRole("heading", { name: "Reporting window", exact: true })).toHaveCount(0);
  const summary = page.getByRole("region", { name: "Activity summary" }); await expect(summary).toContainText("All day"); await expect(summary).toContainText("Closes");
  await expect(summary.locator("dt")).toHaveText(["Date", "Time", "Location", "Labels", "Reporting"]);
  await expect(page.locator(".meeting-detail-heading h1 + .outreach-activity-type")).toHaveText("Event");
  const icons = await summary.locator(".outreach-detail-icon").evaluateAll(elements => elements.map(element => ({ hidden: element.getAttribute("aria-hidden"), stroke: getComputedStyle(element).stroke, expected: getComputedStyle(element.parentElement!).color, width: element.getBoundingClientRect().width })));
  expect(icons).toHaveLength(4); for (const icon of icons) { expect(icon.hidden).toBe("true"); expect(icon.stroke).toBe(icon.expected); expect(icon.width).toBeGreaterThan(0); }
  const reopen = summary.getByRole("button", { name: "Reopen for 24 hours" }); await themed(page, reopen); await reopen.click(); await expect(page.getByText("Reporting reopened for 24 hours.", { exact: true })).toBeVisible();
  expect(state.writes.find(item => item.path.endsWith("reopen-windows"))?.body).toMatchObject({ hours: 24, settingsRevision: 0 });
  const google = page.getByRole("button", { name: "Google Calendar: Published", exact: true }); const discord = page.getByRole("button", { name: "Discord: Not published", exact: true }); await expect(google).toHaveAttribute("data-published", "true"); await expect(discord).toHaveAttribute("data-published", "false");
  await google.click(); await themed(page, page.getByRole("button", { name: "Update Google Calendar" })); await themed(page, page.getByRole("button", { name: "Unpublish Google Calendar" }), "danger"); await page.keyboard.press("Escape"); await expect(google).toBeFocused();
  await discord.click(); await expect(page.getByRole("button", { name: "Discord: Published", exact: true })).toBeVisible(); expect(state.writes.at(-1)?.body).toMatchObject({ provider: "discord", action: "publish" });
  await page.getByRole("button", { name: "Google Calendar: Published", exact: true }).click(); await page.getByRole("button", { name: "Unpublish Google Calendar" }).click(); await expect(page.getByRole("button", { name: "Google Calendar: Removed", exact: true })).toHaveAttribute("data-published", "false"); await expect(page.getByRole("button", { name: "Discord: Published", exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "Activity participation" }); await expect(table.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible(); await expect(table.getByRole("columnheader", { name: "Counted entries" })).toHaveCount(0); await expect(table.getByRole("columnheader", { name: "Submissions" })).toHaveCount(0);
  const details = table.getByRole("button", { name: "Details for Avery Synthetic" }); await themed(page, details);
  const buttonBefore = await details.boundingBox(); const columnsBefore = await table.locator("thead th").evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width })));
  await details.click();
  const hideDetails = table.getByRole("button", { name: "Hide details for Avery Synthetic" }); await page.mouse.move(0, 0); await themed(page, hideDetails); await expect(hideDetails).toHaveAttribute("aria-expanded", "true");
  const buttonAfter = await hideDetails.boundingBox(); expect(buttonAfter!.width).toBeCloseTo(buttonBefore!.width, 1); expect(buttonAfter!.height).toBeCloseTo(buttonBefore!.height, 1);
  const columnsAfter = await table.locator("thead th").evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width })));
  for (let index = 0; index < columnsBefore.length; index++) { expect(columnsAfter[index]!.x).toBeCloseTo(columnsBefore[index]!.x, 1); expect(columnsAfter[index]!.width).toBeCloseTo(columnsBefore[index]!.width, 1); }
  const row = page.locator('article[data-entry-id="entry-a"]'); await themed(page, row.getByRole("button", { name: /^Edit participation/ })); await themed(page, row.getByRole("button", { name: /^Delete participation/ }), "danger");
  await row.getByRole("button", { name: /^Edit participation/ }).click(); const edit = page.getByRole("dialog", { name: "Edit participation" }); await expect(edit.getByRole("combobox", { name: "Member", exact: true })).toBeFocused(); await edit.getByRole("button", { name: /^Start time:/ }).click(); await expect(page.getByRole("dialog", { name: "Start time", exact: true }).locator(".outreach-clock-readout button").first()).toBeFocused(); await page.keyboard.press("Escape"); await expect(edit).toBeVisible(); await expect(page.getByRole("dialog", { name: "Start time", exact: true })).toHaveCount(0); await edit.getByLabel("Task notes").fill("Updated notes"); await chooseClock(page, "End time", 10, 30, "AM"); await edit.getByLabel("Staff reason").fill("Verified by event lead"); await themed(page, edit.getByRole("button", { name: "Save participation" }), "primary"); await edit.getByRole("button", { name: "Save participation" }).click(); await expect(page.getByText("3.00 hours total", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details for Avery Synthetic" }).click(); await page.locator('article[data-entry-id="entry-a"]').getByRole("button", { name: /^Delete participation/ }).click(); const deletion = page.getByRole("dialog", { name: "Delete participation" }); await expect(deletion.getByRole("button", { name: "Delete participation", exact: true })).toBeDisabled(); await expect(deletion.getByLabel("Type DELETE PARTICIPATION")).toHaveCount(0); await deletion.getByLabel("Staff reason").fill("Duplicate record"); await themed(page, deletion.getByRole("button", { name: "Delete participation", exact: true }), "danger"); await deletion.getByRole("button", { name: "Delete participation", exact: true }).click(); await expect(page.getByText("1.50 hours total", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details for Avery Synthetic" }).click(); await expect(page.getByText("Deleted - excluded from totals", { exact: true })).toBeVisible(); await expect(page.locator('article[data-entry-id="entry-a"]').getByRole("button", { name: /^Edit participation/ })).toBeDisabled();
  await page.getByRole("button", { name: "Add member participation" }).click(); await expect(page.getByRole("combobox", { name: "Member", exact: true }).locator("option")).toHaveText(["Avery Synthetic (SYN-A)", "Blake Synthetic (SYN-B)", "Zoe Synthetic (SYN-Z)"]); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (width === 390) expect(await table.evaluate(element => element.scrollWidth <= element.parentElement!.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("activity-feedback.png"), fullPage: false });
  await page.goto("/hours"); await page.getByRole("radio", { name: "Table", exact: true }).check();
  const activityTable = page.locator(".outreach-activity-directory"); const title = activityTable.getByRole("link", { name: event.title, exact: true });
  await expect(activityTable.getByRole("button", { name: /^Open / })).toHaveCount(0); await expect(title).toHaveAttribute("href", `/hours/activities/${event.id}`); await expect(title).toBeVisible();
  await title.hover(); await title.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await expect(title).toBeFocused();
  const linkStyle = await title.evaluate(element => { const probe = document.createElement("span"); element.append(probe); probe.style.color = "var(--ui-text)"; const expected = getComputedStyle(probe).color; const style = getComputedStyle(element); probe.remove(); return { color: style.color, expected, outline: style.outlineStyle, height: element.getBoundingClientRect().height }; });
  expect(linkStyle.color).toBe(linkStyle.expected); expect(linkStyle.outline).toBe("solid"); expect(linkStyle.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("activity-title-link.png"), fullPage: false });
  await page.keyboard.press("Enter"); await expect(page).toHaveURL(new RegExp(`/hours/activities/${event.id}$`)); await expect(page.getByRole("heading", { level: 1, name: event.title, exact: true })).toBeVisible();
});

for (const change of [{ date: "2026-03-08", hour: 2, message: "This local time does not exist because the clock changes. Choose another time." }, { date: "2026-11-01", hour: 1, message: "This time occurs twice. Choose the intended occurrence." }]) test(`hidden timezone hints retain validation on ${change.date}`, async ({ page }) => {
  const state = await fixture(page); state.entries[0]!.serviceDate = change.date;
  await page.goto(`/hours/activities/${event.id}`); await page.getByRole("button", { name: "Details for Avery Synthetic" }).click();
  await page.locator('article[data-entry-id="entry-a"]').getByRole("button", { name: /^Edit participation/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit participation", exact: true }); const times = edit.locator(".outreach-time-grid");
  await expect(times).not.toContainText("America/New_York"); await chooseClock(page, "Start time", change.hour, 30, "AM");
  const start = edit.getByRole("button", { name: /^Start time:/ }); await expect(start).toHaveAttribute("aria-invalid", "true"); await expect(times.getByText(change.message, { exact: true })).toBeVisible();
  if (change.hour === 1) await edit.getByLabel("Start time occurrence").selectOption("earlier"); else await chooseClock(page, "Start time", 3, 30, "AM");
  await expect(start).toHaveAttribute("aria-invalid", "false"); await expect(times.getByText(change.message, { exact: true })).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

test("an unchanged initial search must not reset a newly selected catalog page", async ({ page }) => {
  await fixture(page);
  await page.clock.pauseAt(new Date("2026-10-13T18:01:00Z"));
  await page.goto("/settings/outreach-setup?section=labels");
  const table = page.getByRole("table", { name: "Outreach labels" });
  await expect(table).toContainText("Synthetic label 000");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(table).toContainText("Synthetic label 020");
  await page.clock.runFor(300);
  await expect(table).toContainText("Synthetic label 020");
  await expect(table).not.toContainText("Synthetic label 000");
});

for (const { theme, width } of pairedViews) test(`catalog tabs search every page and use focused dialogs at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), theme); const state = await fixture(page); await page.goto("/settings/outreach-setup");
  const sections = page.getByRole("combobox", { name: "Outreach section", exact: true });
  if (width === 390) { await expect(sections).toHaveValue("/settings/outreach-setup?section=general"); await expect(sections.locator("option")).toHaveText(["General", "Supported teams (1)", "Labels (41)"]); }
  else await expect(page.getByRole("link", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Add label", exact: true })).toHaveCount(0); await expect(page.getByLabel("Reporting window in days")).toHaveValue("2");
  if (width === 390) await sections.selectOption({ label: "Labels (41)" }); else await page.getByRole("link", { name: "Labels (41)", exact: true }).click();
  const table = page.getByRole("table", { name: "Outreach labels" }); await expect(table.getByRole("row")).toHaveCount(21); await themed(page, page.getByRole("button", { name: "Add label", exact: true }), "primary"); await page.getByRole("button", { name: "Next", exact: true }).click(); await expect(table).toContainText("Synthetic label 020"); await expect(table).not.toContainText("Synthetic label 000");
  await page.getByLabel("Search labels").fill("039"); await page.clock.runFor(300); await expect(table.getByRole("row")).toHaveCount(2); await expect(table).toContainText("Synthetic label 039");
  await table.getByRole("button", { name: "Edit Synthetic label 039" }).click(); const dialog = page.getByRole("dialog", { name: "Edit Outreach label" }); await expect(dialog.getByLabel("Label name")).toBeFocused(); await dialog.getByLabel("Label name").fill("Updated synthetic label 039"); await dialog.getByRole("button", { name: "Save label", exact: true }).click(); await expect(table).toContainText("Updated synthetic label 039");
  await table.getByRole("button", { name: "Archive Updated synthetic label 039" }).click(); await expect(page.getByText("No matching labels.")).toBeVisible(); await page.getByLabel("Label status").selectOption("true"); await expect(table).toContainText("Updated synthetic label 039"); await table.getByRole("button", { name: "Reopen Updated synthetic label 039" }).click(); await expect(page.getByText("No matching labels.")).toBeVisible();
  await page.getByLabel("Search labels").fill(""); await page.clock.runFor(300); await page.getByLabel("Label status").selectOption("false"); await page.getByRole("button", { name: "Add label", exact: true }).click(); const add = page.getByRole("dialog", { name: "Add Outreach label" }); await add.getByLabel("Label name").fill("New synthetic label"); await add.getByRole("button", { name: "Add label", exact: true }).click();
  if (width === 390) await expect(sections.locator("option:checked")).toHaveText("Labels (42)"); else await expect(page.getByRole("link", { name: "Labels (42)", exact: true })).toBeVisible();
  expect(state.labels.some(item => item.name === "New synthetic label")).toBe(true);
  if (width === 390) await sections.selectOption({ label: "Supported teams (1)" }); else await page.getByRole("link", { name: "Supported teams (1)", exact: true }).click();
  await page.getByRole("button", { name: "Edit Synthetic team" }).click(); const team = page.getByRole("dialog", { name: "Edit supported team" }); await expect(team.getByLabel("Program").locator("option")).toHaveText(["Choose program", "Explore", "Challenge", "FTC", "FRC"]); await team.getByLabel("Team name").fill("Updated synthetic team"); await team.getByLabel("Program").selectOption("FRC"); await team.getByRole("button", { name: "Save team", exact: true }).click();
  if (width === 390) await expect(page.locator(".outreach-team-record")).toContainText("Updated synthetic team"); else await expect(page.getByRole("table", { name: "Supported teams" })).toContainText("Updated synthetic team");
  await page.getByRole("button", { name: "Add team", exact: true }).click(); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "Add team", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("catalog-feedback.png"), fullPage: false });
});

test("clicking outside a nested clock closes only the picker and preserves participation", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/hours/activities/${event.id}`);
  await page.getByRole("button", { name: "Details for Avery Synthetic" }).click();
  await page.locator('article[data-entry-id="entry-a"]').getByRole("button", { name: /^Edit participation/ }).click();
  const edit = page.getByRole("dialog", { name: "Edit participation", exact: true });
  await edit.getByRole("button", { name: /^Start time:/ }).click();
  const picker = page.getByRole("dialog", { name: "Start time", exact: true });
  await picker.getByRole("button", { name: "11 o'clock" }).click();
  await edit.getByLabel("Task notes").click({ position: { x: 4, y: 4 } });
  await expect(picker).toHaveCount(0);
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("Task notes")).toBeFocused();
  await expect(edit.getByRole("button", { name: /^Start time:/ })).toHaveText("9:00 AM");
  await expect(edit.locator(".outreach-time-grid")).not.toContainText("America/New_York");
  await chooseClock(page, "End time", 10, 30, "AM");
  await expect(edit.getByRole("button", { name: /^End time:/ })).toHaveText("10:30 AM");
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(0);
});

test("Filter closes on outside click and Escape; optional event times begin blank", async ({ page }) => {
  await fixture(page); await page.goto("/hours"); const filter = page.locator(".outreach-activity-visibility"); await filter.locator("summary").click(); await expect(filter).toHaveAttribute("open", ""); await page.getByRole("heading", { level: 1 }).click(); await expect(filter).not.toHaveAttribute("open", ""); await filter.locator("summary").click(); await page.keyboard.press("Escape"); await expect(filter).not.toHaveAttribute("open", ""); await expect(filter.locator("summary")).toBeFocused();
  await page.getByRole("button", { name: "Create activity", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Create Outreach activity" }); await expect(dialog.getByLabel("Set event times")).toHaveCount(0); await expect(dialog.getByLabel("Event start time", { exact: true })).toHaveValue(""); await expect(dialog.getByLabel("Event end time", { exact: true })).toHaveValue("");
});

for (const { theme, width } of pairedViews) test(`submission pagination stays at the screen bottom at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), theme);
  const state = await fixture(page); const requests: string[] = []; let mode: "entries" | "empty" | "error" = "entries"; let releaseNext: (() => Promise<void>) | undefined;
  const firstPage = Array.from({ length: 25 }, (_, index) => ({ ...state.entries[0]!, id: `logged-${index}`, memberName: `Synthetic member ${index}` }));
  await page.route(/\/admin\/hours\/entries\?order=logged-desc/, route => {
    const url = new URL(route.request().url()); requests.push(url.search);
    if (mode === "error") return route.fulfill({ status: 500, json: { error: "Synthetic log unavailable" } });
    if (mode === "empty") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.searchParams.has("after")) { releaseNext = () => route.fulfill({ json: { items: [state.entries[1]], nextCursor: null } }); return; }
    return route.fulfill({ json: { items: firstPage, nextCursor: "next-entries" } });
  });
  await page.goto("/hours"); await page.locator(".outreach-submission-disclosure > summary").click();
  const log = page.locator(".outreach-submission-log"); const bar = page.getByRole("navigation", { name: "Submission log pages", exact: true });
  const previous = bar.getByRole("button", { name: "Previous submissions", exact: true }); const next = bar.getByRole("button", { name: "Next submissions", exact: true });
  const atBottom = async () => {
    await expect(bar).toBeVisible();
    const layout = await bar.evaluate(element => { const log = document.querySelector(".outreach-submission-log")!; const rect = element.getBoundingClientRect(); return { position: getComputedStyle(element).position, bottom: rect.bottom, left: rect.left, right: rect.right, viewport: innerHeight, width: innerWidth, height: rect.height, reserved: parseFloat(getComputedStyle(log).paddingBottom) }; });
    expect(layout.position).toBe("fixed"); expect(layout.bottom).toBeCloseTo(layout.viewport, 1); expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(layout.width); expect(layout.reserved).toBeGreaterThan(layout.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await expect(log.locator("article")).toHaveCount(25); await expect(previous).toBeDisabled(); await expect(next).toBeEnabled(); await themed(page, previous, "surface", "--ui-text-muted"); await themed(page, next); await atBottom();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })); await atBottom();
  const lastEntry = (await log.locator("article").last().boundingBox())!; expect(lastEntry.y + lastEntry.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
  await page.screenshot({ path: test.info().outputPath("submission-pagination.png"), fullPage: false });
  await next.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await expect(next).toBeFocused(); await page.keyboard.press("Enter");
  await expect(log.getByText("Loading submissions...", { exact: true })).toBeVisible(); await expect(previous).toBeDisabled(); await expect(next).toBeDisabled(); await atBottom();
  await expect.poll(() => Boolean(releaseNext)).toBe(true); await releaseNext!(); await expect(log.locator("article")).toHaveCount(1); await expect(bar).toContainText("Page 2"); await expect(previous).toBeEnabled(); await expect(next).toBeDisabled(); await atBottom();
  await previous.click(); await expect(log.locator("article")).toHaveCount(25); await expect(bar).toContainText("Page 1");
  expect(requests).toContain("?order=logged-desc&limit=25&after=next-entries");
  for (const nextMode of ["empty", "error"] as const) { mode = nextMode; await page.locator(".outreach-submission-disclosure > summary").click(); await page.locator(".outreach-submission-disclosure > summary").click(); if (mode === "empty") await expect(log.getByText("No participation submissions yet.", { exact: true })).toBeVisible(); else await expect(log.getByRole("alert")).toBeVisible(); await expect(next).toBeDisabled(); await atBottom(); }
  await page.locator(".outreach-submission-disclosure > summary").click(); await expect(bar).toHaveCount(0);
});

test("public form starts unselected and Enter in fields never submits", async ({ page }) => {
  await fixture(page); const writes: Record<string, unknown>[] = [];
  await page.route("**/public/hours/context", route => route.fulfill({ json: { organizationName: "Synthetic Robotics", timeZone: "America/New_York", today: "2026-10-13", earliestServiceDate: "2026-09-14", reportingDays: 30 } }));
  await page.route(/\/public\/hours\/activities(?:\?.*)?$/, route => route.fulfill({ json: { items: [{ id: event.id, title: event.title, serviceDate: event.serviceDate, location: "Library", reopened: false }], nextCursor: null } }));
  await page.route("**/public/hours/entries", route => { const body = route.request().postDataJSON(); writes.push(body); return route.fulfill({ json: { id: "receipt-1", serviceDate: body.serviceDate, startLocal: body.startLocal, endLocal: body.endLocal, durationMinutes: 60, createdAt: "2026-10-13T18:00:00.000Z" } }); });
  await page.goto("/submit-hours"); await expect(page.getByLabel("Dated activity")).toHaveValue(""); await expect(page.getByRole("button", { name: "Start time: Choose time" })).toBeDisabled(); await expect(page.getByRole("button", { name: "End time: Choose time" })).toBeDisabled();
  const id = page.getByLabel("Roster member ID"); await id.fill("SYN-A"); await id.press("Enter"); expect(writes).toHaveLength(0); await page.getByLabel("Dated activity").selectOption(event.id); await chooseClock(page, "Start time", 9, 0, "AM"); await expect(page.getByRole("button", { name: "End time: Choose time" })).toBeVisible(); await expect(page.getByRole("button", { name: "Record completed participation" })).toBeDisabled(); await chooseClock(page, "End time", 10, 0, "AM"); await id.press("Enter"); expect(writes).toHaveLength(0);
  const notes = page.getByLabel("Private task notes (optional)"); await notes.fill("Line one"); await notes.press("Enter"); await notes.press("a"); await expect(notes).toHaveValue("Line one\na"); expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Record completed participation" }).click(); await expect(page.getByRole("heading", { name: "Participation recorded" })).toBeVisible(); expect(writes).toHaveLength(1); await page.getByRole("button", { name: "Record separate participation" }).click(); await expect(page.getByLabel("Dated activity")).toHaveValue(""); await expect(page.getByRole("button", { name: "Start time: Choose time" })).toBeVisible();
});
