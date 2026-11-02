import { expect, test } from "@playwright/test";
import { base, chooseSearchKeys, fixture, pin, reachable, swipe, tap } from "./kiosk-maintenance-touch-fixtures";

test.use({ hasTouch: true });
test.setTimeout(120_000);

for (const viewport of [{ width: 800, height: 480 }, { width: 1024, height: 600 }, { width: 800, height: 360 }]) {
  test(`maintenance completes touch workflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    if (viewport.height === 360) test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const mock = await fixture(page);
    await page.goto(`${base}/maintenance`);
    await expect(page.locator("#workspace")).toBeHidden();
    await pin(page);
    await expect(page.locator("#workspace")).toBeVisible();
    await reachable(page, page.locator("#test-reader"), page.locator(".reader-card"));
    await tap(page, page.locator("#test-reader"));
    await expect(page.locator("#reader-status")).toContainText("Reader online");
    if (viewport.height === 360) {
      const reader = page.locator(".reader-card");
      expect(await reader.evaluate((e) => e.scrollHeight)).toBeGreaterThan(await reader.evaluate((e) => e.clientHeight));
      await swipe(page, reader);
      expect(await reader.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
      await reachable(page, page.locator("#stage-detail"), reader);
      await tap(page, page.locator("#stage-detail"));
      await reachable(page, page.locator("#test-reader"), reader, "down");
      await tap(page, page.locator("#test-reader"));
    }
    await tap(page, page.locator("#member-picker"));
    await expect(page.locator("#member-search")).toBeFocused();
    const options = page.locator("#member-options");
    expect(await options.locator("button").evaluateAll((buttons) => buttons.every((e) => e.scrollHeight <= e.clientHeight))).toBe(true);
    await swipe(page, options);
    expect(await options.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    // All keyboard keys must have reachable touch targets, including bottom-row controls.
    const keyboard = page.locator("#search-keyboard");
    expect(await keyboard.locator("button").evaluateAll((buttons) => buttons.every((e) => {
      const r = e.getBoundingClientRect();
      return r.height >= 44 && [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8]].every(([x, y]) => e.contains(document.elementFromPoint(x, y)));
    }))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`roster-keyboard-${viewport.height}.png`) });
    for (const key of "abcdefghijklmnopqrstuvwxyz0123456789-'.") {
      await chooseSearchKeys(page, key);
      const target = keyboard.getByRole("button", { name: key, exact: true });
      expect(await target.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8]].every(([x, y]) => e.contains(document.elementFromPoint(x, y)));
      })).toBe(true);
      await tap(page, target);
    }
    await expect(page.locator("#member-search")).toHaveValue("abcdefghijklmnopqrstuvwxyz0123456789-'.");
    await tap(page, keyboard.getByRole("button", { name: "Space", exact: true }));
    await tap(page, keyboard.getByRole("button", { name: "Backspace" }));
    await tap(page, keyboard.getByRole("button", { name: "Clear", exact: true }));
    for (const key of "member 79") { await chooseSearchKeys(page, key); await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true })); }
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, keyboard.getByRole("button", { name: "Backspace" }));
    await expect(page.locator("#member-search")).toHaveValue("member 7");
    await tap(page, keyboard.getByRole("button", { name: "9", exact: true }));
    await tap(page, page.locator("#member-search"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await page.locator("#member-search").evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 6));
    await chooseSearchKeys(page, "m");
    await tap(page, keyboard.getByRole("button", { name: "m", exact: true }));
    await expect(page.locator("#member-search")).toHaveValue("m 79");
    await tap(page, keyboard.getByRole("button", { name: "Clear", exact: true }));
    for (const key of "member 79") { await chooseSearchKeys(page, key); await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true })); }
    await tap(page, page.locator("#close-member-sheet"));
    await tap(page, page.locator("#member-picker"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, options.getByRole("button", { name: /Member 79/ }));
    await expect(page.locator("#member")).toHaveValue("synthetic-79");
    await expect(page.locator("#finger-picker")).toHaveCount(0);
    await reachable(page, page.locator("#slot"), page.locator(".enroll-card"));
    await tap(page, page.locator("#slot"), false);
    await expect(page.locator("#number-display")).toHaveValue("60");
    const pad = page.locator("#slot-keypad");
    const back = pad.getByRole("button", { name: "Backspace" });
    const panel = page.locator("#number-pad .sheet-panel");
    await reachable(page, back, panel);
    await tap(page, back); await tap(page, back);
    for (const digit of "999") await tap(page, pad.getByRole("button", { name: digit, exact: true }));
    await reachable(page, page.locator("#apply-number"), panel);
    await tap(page, page.locator("#apply-number"));
    await expect(page.locator("#number-error")).toContainText("0 to 199");
    await tap(page, back); await tap(page, back); await tap(page, back);
    await tap(page, pad.getByRole("button", { name: "5", exact: true }));
    await tap(page, page.locator("#apply-number"));
    await expect(page.locator("#slot")).toHaveValue("5");
    await tap(page, page.locator("#slot"), false);
    await expect(page.locator("#number-display")).toHaveValue("5");
    await tap(page, pad.getByRole("button", { name: "0", exact: true }));
    await tap(page, page.locator("#close-number-pad"));
    await expect(page.locator("#slot")).toHaveValue("5");
    const enroll = page.locator(".enroll-card");
    await reachable(page, page.locator("#begin-enroll"), enroll);
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#message")).toContainText("already contains a fingerprint or mapping");
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#replace"));
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#confirm-title")).toHaveText("Replace occupied slot?");
    await tap(page, page.locator("#cancel-action"));
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#begin-enroll"));
    await tap(page, page.locator("#accept-action"));
    await expect.poll(() => mock.enrolled).toEqual([{ memberId: "synthetic-79", slot: 5, replaceExisting: true }]);
    await expect(page.locator("#message")).toContainText("Enrollment saved");
    const reader = page.locator(".reader-card");
    await expect(page.locator("#stage-detail")).toContainText("Synthetic recovery guidance");
    await swipe(page, reader);
    expect(await reader.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    await reachable(page, page.locator("#test-reader"), reader, "down");
    await tap(page, page.locator("#test-reader"));
    await tap(page, page.getByRole("tab", { name: "Fingerprint mappings" }));
    await expect(page.getByRole("tab", { name: "Fingerprint mappings" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".enroll-card")).toBeHidden();
    const table = page.locator("[data-fingerprint].mappings-card .table-wrap");
    // The heading can scroll out of view on short screens. Swipe visible outer
    // card padding so the nested table does not consume the parent gesture.
    const mappingsCard = page.locator("[data-fingerprint].mappings-card");
    await reachable(page, table, mappingsCard, "up", "padding");
    const initialTableTop = await table.evaluate(element => element.scrollTop);
    expect(await table.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(20);
    await swipe(page, table);
    expect(await table.evaluate(element => element.scrollTop) - initialTableTop).toBeGreaterThan(20);
    if (await table.evaluate((e) => e.scrollWidth > e.clientWidth + 10)) {
      await swipe(page, table, "left");
      expect(await table.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    }
    const remove = page.locator("#mappings tr").last().getByRole("button", { name: "Remove" });
    await reachable(page, remove, table);
    await tap(page, remove);
    await tap(page, page.locator("#cancel-action"));
    expect(mock.removed).toHaveLength(0);
    await tap(page, remove); await tap(page, page.locator("#accept-action"));
    await expect.poll(() => mock.removed.length).toBe(1);
    await reachable(page, page.locator("#refresh"), mappingsCard, "down", "padding");
    await tap(page, page.locator("#refresh"));
    await expect(page.locator("#member")).toHaveValue("");
    expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual(viewport);
    await page.screenshot({ path: test.info().outputPath(`maintenance-${viewport.height}.png`) });
    await tap(page, page.locator('#maintenance-header a[href="/"]'));
    await expect(page).toHaveURL(`${base}/`);
  });
}
