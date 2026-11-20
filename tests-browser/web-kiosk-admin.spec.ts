import { expect, test, type Page } from "@playwright/test";
import qrcode from "qrcode-generator";
import { useScenario as routeScenario } from "./api-fixtures";

// Web kiosk phase 1 on the Kiosks page, against the dashboard preview API's kiosk state. Each test gets its own scenario:
// a Raspberry Pi "Front desk", an online "Test web kiosk A" and "Test web kiosk B" that stopped checking in 45 minutes ago.
const useScenario = (page: Page, id: string) => routeScenario(page, `web-kiosk-admin-${id}`, ["**/admin/kiosks", "**/admin/kiosks/*", "**/admin/kiosks/*/*", "**/admin/pairing-codes"]);

const qrPath = (value: string) => {
  const code = qrcode(0, "M"); code.addData(value, "Byte"); code.make();
  let d = ""; const count = code.getModuleCount();
  for (let row = 0; row < count; row += 1) for (let column = 0; column < count; column += 1) if (code.isDark(row, column)) d += `M${column + 4} ${row + 4}h1v1h-1z`;
  return d;
};

async function openWebKioskPairing(page: Page) {
  await page.goto("/kiosks");
  await page.getByRole("button", { name: "Add kiosk" }).click();
  const dialog = page.getByRole("dialog", { name: "Add kiosk" });
  await expect(dialog.getByRole("group", { name: "Kind of kiosk" })).toBeVisible();
  // Each kind radio is named by its title and described by its detail.
  await expect(dialog.getByRole("radio", { name: "Raspberry Pi kiosk", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Raspberry Pi kiosk", exact: true })).toHaveAccessibleDescription("Fingerprint reader. Paired with a one-time pairing key.");
  await expect(dialog.getByRole("radio", { name: "Web kiosk", exact: true })).toHaveAccessibleDescription(/^Any touchscreen laptop or tablet\./);
  await dialog.getByRole("radio", { name: "Web kiosk", exact: true }).check();
  await expect(dialog.getByRole("heading", { name: "Prepare the Pi" })).toHaveCount(0);
  return dialog;
}

test("Add kiosk creates a one-time web kiosk code with a QR code and the kiosk page link", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  const dialog = await openWebKioskPairing(page);
  await dialog.getByRole("textbox", { name: "Kiosk name" }).fill("Test tablet C");
  await dialog.getByRole("button", { name: "Create pairing code" }).click();

  const code = dialog.locator(".web-kiosk-code-value");
  await expect(code).toHaveText(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const raw = (await code.textContent())!.replace("-", "");
  const origin = new URL(page.url()).origin;
  const url = `${origin}/kiosk#code=${raw}`;
  await expect(dialog.getByRole("link", { name: url })).toHaveAttribute("href", url);
  await expect(dialog).toContainText("The code works once and expires in 10 minutes.");
  const qr = dialog.getByRole("img", { name: `QR code that opens the kiosk page with code ${raw.slice(0, 4)}-${raw.slice(4)}` });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((element) => element.tagName.toLowerCase())).toBe("svg");
  expect(await qr.locator("path").getAttribute("d")).toBe(qrPath(url));
  await expect(dialog.getByRole("button", { name: "Refresh kiosk status" })).toBeVisible();

  const pairing = writes.filter((request) => request.url().endsWith("/admin/pairing-codes"));
  expect(pairing).toHaveLength(1);
  expect(pairing[0]!.postDataJSON()).toEqual({ kioskName: "Test tablet C", kind: "web" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("a web kiosk name held by a kiosk that stopped checking in offers Retire and replace", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  const dialog = await openWebKioskPairing(page);
  await dialog.getByRole("textbox", { name: "Kiosk name" }).fill("test web kiosk b");
  await dialog.getByRole("button", { name: "Create pairing code" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await expect(dialog.getByRole("alert")).toContainText("An active kiosk already uses that name. Choose a distinct device name.");
  await expect(dialog.getByRole("alert")).toContainText("The kiosk named test web kiosk b hasn't checked in for at least 10 minutes.");
  await expect(dialog.locator(".web-kiosk-code-value")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Retire and replace" }).click();
  await expect(dialog.locator(".web-kiosk-code-value")).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(dialog.getByRole("status")).toHaveText("The old test web kiosk b was retired. Its attendance history stays.");
  await expect(dialog.getByRole("button", { name: "Retire and replace" })).toHaveCount(0);
  const pairing = writes.filter((request) => request.url().endsWith("/admin/pairing-codes")).map((request) => request.postDataJSON());
  expect(pairing).toEqual([{ kioskName: "test web kiosk b", kind: "web" }, { kioskName: "test web kiosk b", kind: "web", replaceKioskId: "web-kiosk-b" }]);

  await dialog.getByRole("button", { name: "Refresh kiosk status" }).click();
  await expect(dialog).toHaveCount(0);
  const switcher = page.getByRole("group", { name: "Active kiosks" });
  await expect(switcher.getByRole("button", { name: /^Test web kiosk A/ })).toBeVisible();
  await expect(switcher.getByRole("button", { name: /^Test web kiosk B/ })).toHaveCount(0);
});

test("a web kiosk name held by a kiosk that is still checking in shows the error only", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  const dialog = await openWebKioskPairing(page);
  await dialog.getByRole("textbox", { name: "Kiosk name" }).fill("Test web kiosk A");
  await dialog.getByRole("button", { name: "Create pairing code" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("An active kiosk already uses that name. Choose a distinct device name.");
  await expect(dialog.getByRole("button", { name: "Retire and replace" })).toHaveCount(0);
  await expect(dialog.locator(".web-kiosk-code-value")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Refresh kiosk status" })).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test("the Pi path offers Retire and replace for a Pi name held by a kiosk that stopped checking in", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  await page.goto("/kiosks");
  await page.getByRole("button", { name: "Add kiosk" }).click();
  const dialog = page.getByRole("dialog", { name: "Add kiosk" });
  await dialog.getByRole("textbox", { name: "Kiosk name" }).fill("Test web kiosk B");
  await dialog.getByRole("button", { name: "Create one-time pairing key" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already uses that name");
  await dialog.getByRole("button", { name: "Retire and replace" }).click();
  await expect(dialog.locator(".pairing-key code")).toHaveText(/^LL1\./);
  expect(writes.map((request) => request.postDataJSON())).toEqual([{ kioskName: "Test web kiosk B", purpose: "hardware" }, { kioskName: "Test web kiosk B", purpose: "hardware", replaceKioskId: "web-kiosk-b" }]);
});

test("kiosk lists and Manage kiosk show each kiosk's kind, and web kiosks have no fingerprint enrollment or Pi update", async ({ page }, testInfo) => {
  await useScenario(page, testInfo.testId);
  await page.goto("/kiosks");
  const switcher = page.getByRole("group", { name: "Active kiosks" });
  await expect(switcher.getByRole("button", { name: /^Front desk/ }).locator(".kiosk-kind")).toHaveText("Raspberry Pi");
  await expect(switcher.getByRole("button", { name: /^Test web kiosk A/ }).locator(".kiosk-kind")).toHaveText("Web kiosk");
  await expect(switcher.getByRole("button", { name: /^Test web kiosk B/ }).locator(".kiosk-kind")).toHaveText("Web kiosk");

  await switcher.getByRole("button", { name: /^Test web kiosk A/ }).click();
  const kind = page.locator(".kiosk-summary > div").filter({ has: page.getByText("Kind", { exact: true }) });
  await expect(kind.locator("dd")).toHaveText("Web kiosk");
  await expect(page.locator(".kiosk-summary")).toContainText("Member ID entry");
  await expect(page.getByRole("button", { name: /^Begin enrollment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update kiosk" })).toHaveCount(0);
  await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
  await expect(page).toHaveURL(/\/kiosks\/web-kiosk-a\/manage$/);
  await expect(kind.locator("dd")).toHaveText("Web kiosk");

  await page.getByRole("link", { name: "← Kiosks", exact: true }).click();
  await switcher.getByRole("button", { name: /^Front desk/ }).click();
  await expect(kind.locator("dd")).toHaveText("Raspberry Pi");
  await expect(page.getByRole("button", { name: "Begin enrollment on Front desk" })).toBeVisible();
});

test("Manage kiosk Identification for a web kiosk offers only Discord code, Member ID and Member search and saves the lookup", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await page.getByText("Identification", { exact: true }).click();
  const choice = page.getByRole("group", { name: "How members identify themselves" });
  await expect(choice.getByRole("radio")).toHaveCount(3);
  await expect(choice.getByRole("radio", { name: "Discord code", exact: true })).not.toBeChecked();
  await expect(choice.getByRole("radio", { name: "Member ID", exact: true })).toBeChecked();
  await expect(choice.getByRole("radio", { name: "Member ID", exact: true })).toHaveAccessibleDescription("Type a member ID on a keypad, then confirm the name.");
  await expect(choice.getByRole("radio", { name: "Member search", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Authentication method for selected kiosk")).toHaveCount(0);
  await expect(page.getByText("Fingerprint", { exact: true })).toHaveCount(0);
  await expect(page.locator(".kiosk-authentication-form .warning-callout")).toHaveText("Without a PIN, anyone can sign in someone else. Use Require PIN or a fingerprint kiosk where that matters.");
  const save = page.getByRole("button", { name: "Save method" });
  await expect(save).toBeDisabled();

  await choice.getByRole("radio", { name: "Member search", exact: true }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Member search selected for Test web kiosk A. It will use this method after its next sync.");
  await expect(page.locator(".kiosk-summary")).toContainText("Member search");
  await expect(save).toBeDisabled();
  const patch = writes.filter((request) => request.url().endsWith("/authentication-method"));
  expect(patch.map((request) => request.postDataJSON())).toEqual([{ authenticationMethod: "member_id", memberLookup: "search", requirePin: false, discordCode: false }]);
});

test("Discord code on a web kiosk saves with its backup method, when to offer it and Require PIN, and is kept after a reload", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await page.getByText("Identification", { exact: true }).click();
  const choice = page.getByRole("group", { name: "How members identify themselves" });
  const code = choice.getByRole("radio", { name: "Discord code", exact: true });
  await expect(code).toHaveAccessibleDescription("Members run /code in Discord and type the 6-digit code. Needs a network connection.");
  const backupMethod = page.getByLabel("Backup method", { exact: true });
  const offer = page.getByLabel("Offer the backup", { exact: true });
  await expect(backupMethod).toHaveCount(0);
  await expect(offer).toHaveCount(0);

  // Choosing Discord code shows the backup choices, starting from the kiosk's lookup and "only when offline".
  await code.check();
  await expect(backupMethod).toHaveValue("entry");
  await expect(offer).toHaveValue("offline");
  await expect(offer.locator("option")).toHaveText(["Only when the kiosk is offline", "Any time"]);
  const warning = page.locator(".kiosk-authentication-form .warning-callout");
  await expect(warning).toHaveText("Without a PIN, the backup method lets anyone sign in someone else while the kiosk is offline. Use Require PIN for the backup method where that matters.");
  await backupMethod.selectOption("search");
  await offer.selectOption("always");
  await expect(warning).toHaveText("Without a PIN, anyone can skip the code and sign in someone else with the backup method. Use Require PIN for the backup method, or offer the backup only when the kiosk is offline.");
  await expect(page.getByRole("checkbox", { name: "Require PIN", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Require PIN for the backup method", exact: true }).check();
  await expect(warning).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save method" });
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Discord code with Require PIN for the backup method selected for Test web kiosk A. It will use this method after its next sync.");
  await expect(save).toBeDisabled();
  const bodies = () => writes.filter((request) => request.url().endsWith("/authentication-method")).map((request) => request.postDataJSON());
  expect(bodies()).toEqual([{ authenticationMethod: "member_id", memberLookup: "search", requirePin: true, discordCode: true, discordCodeBackup: "always" }]);

  // After a reload the kiosk still shows every choice.
  await page.reload();
  await expect(page.locator(".kiosk-summary")).toContainText("Discord code");
  await expect(page.locator(".kiosk-summary")).toContainText("Backup methodMember searchOffered any time");
  await page.getByText("Identification", { exact: true }).click();
  await expect(code).toBeChecked();
  await expect(backupMethod).toHaveValue("search");
  await expect(offer).toHaveValue("always");
  await expect(page.getByRole("checkbox", { name: "Require PIN for the backup method", exact: true })).toBeChecked();
  await expect(save).toBeDisabled();

  // Back to Member ID turns Discord code off and hides the backup choices.
  await choice.getByRole("radio", { name: "Member ID", exact: true }).check();
  await expect(backupMethod).toHaveCount(0);
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Member ID entry with Require PIN selected for Test web kiosk A. It will use this method after its next sync.");
  expect(bodies().at(-1)).toEqual({ authenticationMethod: "member_id", memberLookup: "entry", requirePin: true, discordCode: false });
  await expect(page.locator(".kiosk-summary")).not.toContainText("Backup method");
});

test("a Pi kiosk keeps its method choice and adds the member lookup for Member ID entry", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  await page.goto("/kiosks/kiosk-1/manage");
  await page.getByText("Identification", { exact: true }).click();
  await expect(page.getByRole("group", { name: "How members identify themselves" })).toHaveCount(0);
  const method = page.getByLabel("Authentication method for selected kiosk");
  await expect(method).toHaveValue("fingerprint");
  await expect(page.getByLabel("Member lookup")).toHaveCount(0);
  await expect(page.locator(".kiosk-authentication-form .warning-callout")).toHaveCount(0);
  await method.selectOption("member_id");
  await expect(page.getByLabel("Member lookup")).toHaveValue("entry");
  await expect(page.locator(".kiosk-authentication-form .warning-callout")).toHaveText("Without a PIN, anyone can sign in someone else. Use Require PIN or a fingerprint kiosk where that matters.");
  await page.getByLabel("Member lookup").selectOption("search");
  await page.getByRole("button", { name: "Save method" }).click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Member search selected for Front desk. It will use this method after its next sync.");
  await expect(page.locator(".kiosk-summary")).toContainText("Member search configured - waiting for kiosk sync");
  expect(writes.filter((request) => request.url().endsWith("/authentication-method")).map((request) => request.postDataJSON())).toEqual([{ authenticationMethod: "member_id", memberLookup: "search", requirePin: false, discordCode: false }]);

  await method.selectOption("qr");
  await expect(page.getByLabel("Member lookup")).toHaveCount(0);
});

test("web kiosks offer only Reload display and Reset settings PIN", async ({ page }, testInfo) => {
  const writes = await useScenario(page, testInfo.testId);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await page.getByText("Device maintenance", { exact: true }).click();
  const actions = page.locator(".kiosk-actions");
  await expect(actions.getByRole("button", { name: "Reload display" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Reset settings PIN" })).toBeVisible();
  for (const name of ["Restart software", "Reboot Pi", "Reset network PIN", "Erase unlinked fingerprints"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update kiosk" })).toHaveCount(0);
  await page.getByText("Identification", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Authentication maintenance" })).toHaveCount(0);

  await actions.getByRole("button", { name: "Reload display" }).click();
  await expect(page.getByRole("status").filter({ hasText: "queued" })).toHaveText("Display reload queued. The kiosk normally receives it within ten seconds.");
  page.once("dialog", (dialog) => { expect(dialog.message()).toBe("Reset the settings PIN on Test web kiosk A? The next person to open maintenance on the kiosk chooses a new PIN."); void dialog.accept(); });
  await actions.getByRole("button", { name: "Reset settings PIN" }).click();
  await expect(page.getByRole("status").filter({ hasText: "queued" })).toHaveText("Settings PIN reset queued. The kiosk normally receives it within ten seconds.");
  expect(writes.filter((request) => request.url().endsWith("/commands")).map((request) => request.postDataJSON())).toEqual([{ command: "reload_display" }, { command: "reset_network_pin" }]);

  // The Pi keeps its full set of commands.
  await page.goto("/kiosks/kiosk-1/manage");
  await page.getByText("Device maintenance", { exact: true }).click();
  for (const name of ["Reload display", "Restart software", "Reboot Pi", "Reset network PIN"]) await expect(page.getByRole("button", { name })).toBeVisible();
});

test("Diagnostics for a web kiosk leaves out the network, Wi-Fi scan and uptime rows a Pi kiosk reports", async ({ page }, testInfo) => {
  await useScenario(page, testInfo.testId);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await page.getByText("Diagnostics", { exact: true }).click();
  const terms = page.locator(".kiosk-management-section dl.kiosk-diagnostics dt");
  for (const row of ["Pending scans", "Last successful sync", "Last heartbeat", "Paired"]) await expect(terms.filter({ hasText: row })).toBeVisible();
  for (const row of ["Network", "Last Wi-Fi scan", "Uptime"]) await expect(terms.filter({ hasText: row })).toHaveCount(0);

  await page.goto("/kiosks/kiosk-1/manage");
  await page.getByText("Diagnostics", { exact: true }).click();
  for (const row of ["Network", "Last Wi-Fi scan", "Uptime", "Pending scans", "Last successful sync", "Last heartbeat", "Paired"]) await expect(terms.filter({ hasText: row })).toBeVisible();
});

test("web kiosks show their installed release without the Pi's latest release or update status", async ({ page }, testInfo) => {
  await useScenario(page, testInfo.testId);
  await page.goto("/kiosks");
  const switcher = page.getByRole("group", { name: "Active kiosks" });
  const summary = page.locator(".kiosk-summary");
  const row = (label: string) => summary.locator("> div").filter({ has: page.getByText(label, { exact: true }) });

  await switcher.getByRole("button", { name: /^Front desk/ }).click();
  await expect(row("Latest release")).toHaveCount(1);

  for (const path of [undefined, "/kiosks/web-kiosk-a/manage"]) {
    if (path) await page.goto(path); else await switcher.getByRole("button", { name: /^Test web kiosk A/ }).click();
    await expect(row("Installed release").locator("dd")).toHaveText("0.8.0");
    await expect(row("Latest release")).toHaveCount(0);
    for (const text of ["Up to date", "Update available", "Stable track", "Beta track", "Previously checked; confirmation required", "Replace development build with confirmation"]) await expect(summary.getByText(text, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Update kiosk" })).toHaveCount(0);
    await expect(page.getByText("Prepare the Pi", { exact: true })).toHaveCount(0);
  }

  // A Pi kiosk keeps its release details on Manage kiosk.
  await page.goto("/kiosks/kiosk-1/manage");
  await expect(row("Latest release")).toHaveCount(1);
  await expect(row("Installed release")).toHaveCount(1);
});
