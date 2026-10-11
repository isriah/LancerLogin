import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`bulk contest acceptance uses only the filtered selection and retains failed entries at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const contest = (memberId: string, firstName: string, lastName: string) => ({ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId, externalId: memberId, firstName, lastName, status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "none" });
    let contests = [contest("member-1", "Avery", "Alpha"), contest("member-2", "Morgan", "Alpha"), contest("member-3", "Jordan", "Beta")];
    const accepted: Record<string, unknown>[] = [];
    let failSecond = true;
    await page.route(/\/discord\/contests(?:\?.*)?$/, (route) => route.fulfill({ json: { contests } }));
    await page.route("**/discord/contests/resolve", async (route) => {
      const body = route.request().postDataJSON();
      accepted.push(body);
      if (body.memberId === "member-2" && failSecond) return route.fulfill({ status: 409, json: { error: "Review changed. Reload this contest before retrying." } });
      contests = contests.filter((item) => item.memberId !== body.memberId);
      return route.fulfill({ json: { resolved: true, attendanceChanged: true } });
    });
    await page.goto("/meetings/active-meeting");
    const review = page.locator(".meeting-contests .contest-review-list");
    const filter = review.getByRole("searchbox", { name: "Filter contests" });
    await filter.fill("Alpha");
    await expect(review.locator("article")).toHaveCount(2);
    await review.getByRole("checkbox", { name: "Select all 2 filtered contests" }).check();
    const accept = review.getByRole("button", { name: "Accept 2 selected contests" });
    await accept.click();
    await expect(review.getByRole("alert")).toHaveText("A shared review reason is required before accepting these contests.");
    expect(accepted).toEqual([]);
    await review.getByLabel("Shared review reason", { exact: true }).fill("Verified the kiosk interruption with these members.");
    await accept.click();
    await expect(review.locator("article")).toHaveCount(1);
    await expect(review.getByRole("status")).toHaveText("1 contest accepted. 1 could not be accepted. Review the errors beside those entries before retrying.");
    await expect(review.getByRole("alert")).toContainText("Review changed.");
    expect(accepted.map((body) => body.memberId)).toEqual(["member-1", "member-2"]);
    for (const body of accepted) expect(body).toMatchObject({ meetingId: "active-meeting", resolution: "approved", reviewNote: "Verified the kiosk interruption with these members." });
    failSecond = false;
    await review.getByRole("button", { name: "Accept 1 selected contest", exact: true }).click();
    await expect(review.locator("article")).toHaveCount(0);
    await filter.fill("");
    await expect(review.locator("article")).toHaveCount(1);
    await expect(review.locator("article")).toContainText("Jordan Beta");
    expect(accepted.map((body) => body.memberId)).toEqual(["member-1", "member-2", "member-2"]);
    await review.getByRole("checkbox", { name: "Select contest for Jordan Beta at Build session" }).check();
    await filter.fill("no match");
    await expect(review.getByRole("button", { name: /Accept .* selected/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
