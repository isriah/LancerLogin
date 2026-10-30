import { expect, test } from "@playwright/test";

test("66 selected contests use one acceptance request and one attendance refresh", async ({ page }) => {
  let contests = Array.from({ length: 66 }, (_, index) => ({ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: `synthetic-${index}`, externalId: `SYN-${index}`, firstName: "Synthetic", lastName: `Member ${index}`, status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "none" }));
  let accepts = 0, attendanceReads = 0;
  await page.route(/\/discord\/contests(?:\?.*)?$/, route => route.fulfill({ json: { contests } }));
  await page.route(/\/attendance\?meetingId=active-meeting$/, async route => { attendanceReads++; await route.continue(); });
  await page.route("**/discord/contests/accept", async route => {
    accepts++; const body = route.request().postDataJSON(); expect(body.contests).toHaveLength(66);
    contests = []; await route.fulfill({ json: { results: body.contests.map((item: { meetingId: string; memberId: string }) => ({ ...item, resolved: true })) } });
  });
  await page.goto("/meetings/active-meeting");
  const review = page.locator(".meeting-contests .contest-review-list");
  await expect(review.locator("article")).toHaveCount(66); await expect.poll(() => attendanceReads).toBe(1);
  await review.getByRole("checkbox", { name: "Select all 66 filtered contests" }).check();
  await review.getByLabel("Shared review reason", { exact: true }).fill("Verified synthetic attendance");
  await review.getByRole("button", { name: "Accept 66 selected contests" }).click();
  await expect(page.locator(".meeting-contests")).toHaveCount(0);
  await expect.poll(() => attendanceReads).toBe(2); expect(accepts).toBe(1);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const action of ["accept", "reject"]) test(`bulk contest ${action} uses only the filtered selection and retains failed entries at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const past = action === "accept" ? "accepted" : "rejected";
    const title = action === "accept" ? "Accept" : "Reject";
    const contest = (memberId: string, firstName: string, lastName: string) => ({ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId, externalId: memberId, firstName, lastName, status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "none" });
    let contests = [contest("member-1", "Avery", "Alpha"), contest("member-2", "Morgan", "Alpha"), contest("member-3", "Jordan", "Beta")];
    const accepted: Record<string, unknown>[] = [];
    let failSecond = true;
    await page.route(/\/discord\/contests(?:\?.*)?$/, (route) => route.fulfill({ json: { contests } }));
    let batchRequests = 0;
    await page.route(`**/discord/contests/${action}`, async (route) => {
      const body = route.request().postDataJSON();
      batchRequests++;
      const results = body.contests.map((item: { meetingId: string; memberId: string }) => {
        accepted.push({ ...item, resolution: action === "accept" ? "approved" : "rejected", reviewNote: body.reviewNote });
        if (item.memberId === "member-2" && failSecond) return { ...item, resolved: false, error: "Review changed. Reload this contest before retrying." };
        contests = contests.filter(contest => contest.memberId !== item.memberId);
        return { ...item, resolved: true };
      });
      return route.fulfill({ json: { results } });
    });
    await page.goto("/meetings/active-meeting");
    const review = page.locator(".meeting-contests .contest-review-list");
    const filter = review.getByRole("searchbox", { name: "Filter contests" });
    await filter.fill("Alpha");
    await expect(review.locator("article")).toHaveCount(2);
    await review.getByRole("checkbox", { name: "Select all 2 filtered contests" }).check();
    const accept = review.getByRole("button", { name: `${title} 2 selected contests` });
    await accept.click();
    await expect(review.getByRole("alert")).toHaveText(`A shared review reason is required before ${action}ing these contests.`);
    expect(accepted).toEqual([]);
    await review.getByLabel("Shared review reason", { exact: true }).fill("Verified the kiosk interruption with these members.");
    await accept.click();
    await expect(review.locator("article")).toHaveCount(1);
    await expect(review.getByRole("status")).toHaveText(`1 contest ${past}. 1 could not be ${past}. Review the errors beside those entries before retrying.`);
    await expect(review.getByRole("alert")).toContainText("Review changed.");
    expect(accepted.map((body) => body.memberId)).toEqual(["member-1", "member-2"]);
    expect(batchRequests).toBe(1);
    for (const body of accepted) expect(body).toMatchObject({ meetingId: "active-meeting", resolution: action === "accept" ? "approved" : "rejected", reviewNote: "Verified the kiosk interruption with these members." });
    failSecond = false;
    await review.getByRole("button", { name: `${title} 1 selected contest`, exact: true }).click();
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

for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
  test(`rejection controls and earlier reviews remain themed and keyboard accessible at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    const contest = { meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "synthetic", externalId: "SYN", firstName: "Synthetic", lastName: "Member", status: "open", createdAt: "2026-09-03T21:05:00Z", lifetimeContestCount: 2, hasPartialScan: false, rawScanStatus: "none", priorReviews: [{ status: "rejected", createdAt: "2026-09-03T20:05:00Z", resolvedAt: "2026-09-03T20:15:00Z", reviewNote: "Original rejection retained" }] };
    await page.route(/\/discord\/contests(?:\?.*)?$/, route => route.fulfill({ json: { contests: [contest] } }));
    await page.goto("/meetings/active-meeting");
    await page.locator(".app").evaluate(root => { (root as HTMLElement).style.setProperty("--primary", "#663399"); (root as HTMLElement).style.setProperty("--secondary", "#146c63"); });
    const review = page.locator(".meeting-contests .contest-review-list");
    const history = review.getByText("Previous reviews (1)", { exact: true });
    await history.focus(); await page.keyboard.press("Enter");
    await expect(review.getByText(/Original rejection retained/)).toBeVisible();
    await review.getByRole("checkbox", { name: "Select all 1 filtered contests" }).check();
    const reject = review.getByRole("button", { name: "Reject 1 selected contest", exact: true });
    const appearance = await reject.evaluate(element => {
      const style = getComputedStyle(element), root = element.closest(".app")!;
      const probe = document.createElement("span"); probe.style.color = "var(--ui-error)"; probe.style.background = "var(--ui-error-surface)"; probe.style.borderRadius = "var(--radius-control)"; root.append(probe);
      const expected = getComputedStyle(probe);
      const result = { color: style.color, border: style.borderTopColor, background: style.backgroundColor, radius: style.borderRadius, expectedColor: expected.color, expectedBackground: expected.backgroundColor, expectedRadius: expected.borderRadius, height: element.getBoundingClientRect().height };
      probe.remove(); return result;
    });
    expect(appearance.color).toBe(appearance.expectedColor); expect(appearance.border).toBe(appearance.expectedColor); expect(appearance.background).toBe(appearance.expectedBackground); expect(appearance.radius).toBe(appearance.expectedRadius); expect(appearance.height).toBeGreaterThanOrEqual(44);
    await review.getByRole("button", { name: "Accept 1 selected contest", exact: true }).focus(); await page.keyboard.press("Tab"); await expect(reject).toBeFocused();
    expect(await reject.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await reject.hover(); expect(await reject.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(appearance.background);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/discord/contests/reject", async route => { expect(route.request().postDataJSON().contests[0].createdAt).toBe(contest.createdAt); await pending; await route.fulfill({ json: { results: [{ meetingId: contest.meetingId, memberId: contest.memberId, resolved: false, error: "Refresh this contest" }] } }); });
    await review.getByLabel("Shared review reason", { exact: true }).fill("Checked the original review");
    await reject.click(); await expect(review.getByRole("button", { name: "Rejecting..." })).toBeDisabled();
    release(); await expect(review.getByRole("alert")).toContainText("Refresh this contest");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("contest review popup links each member to their member page in a new tab without toggling selection", async ({ page, context }) => {
  const contest = { meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "synthetic-internal", externalId: "TEST A/1", firstName: "Test Student", lastName: "A", status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "none" };
  await page.route(/\/discord\/contests(?:\?.*)?$/, route => route.fulfill({ json: { contests: [contest] } }));
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "1 attendance contest awaiting review. Open contest review." }).click();
  const dialog = page.getByRole("dialog", { name: "Contests awaiting review" });
  const link = dialog.getByRole("link", { name: "Open Test Student A's member page in a new tab" });
  await expect(link).toHaveAttribute("href", "/roster/TEST%20A%2F1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toContainText("Test Student A"); await expect(link).toContainText("TEST A/1");
  await expect(link).not.toContainText("↗"); await expect(link.locator(".contest-member-link-cue")).toHaveCount(0);
  const checkbox = dialog.getByRole("checkbox", { name: "Select contest for Test Student A at Build session" });
  await checkbox.focus(); await page.keyboard.press("Tab"); await expect(link).toBeFocused();
  for (const target of [link.locator("strong").getByText("Test Student A", { exact: false }).first(), link.locator("small")]) {
    const opened = context.waitForEvent("page");
    await target.click();
    const tab = await opened; await tab.waitForLoadState("domcontentloaded");
    expect(new URL(tab.url()).pathname).toBe("/roster/TEST%20A%2F1");
    await tab.close();
    await expect(checkbox).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: /selected contest/ })).toHaveCount(0);
  }
  await expect(page).toHaveURL(/\/dashboard$/);
});
