import { expect, test, type Page } from "@playwright/test";
import { attendanceSnapshot } from "./module-fixtures";
import { inside, logoBoxes, logoShapes, overlaps, pngLogo, useLogoDashboard, usePairedWebKiosk, type Box } from "./logo-fixtures";

// An organization logo of any shape is scaled to fit inside its frame: in the dashboard's top bar, on the sign-in page,
// in the Settings > Organization previews, on the web kiosk and on the Pi kiosk's screen. It is never cropped and never
// runs over what is next to it.
//
// The frame keeps the height it always had and takes its width from the logo: the logo's drawn width plus the frame's
// padding, no narrower than the frame is tall and no wider than the frame used to be. So a wide logo's frame is the
// size it was before the frame followed the logo, and the organization name sits right after a narrower one.

const kioskBaseUrl = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";
const viewports = [{ width: 1280, height: 900 }, { width: 375, height: 812 }] as const;
const backdrops = [["Automatic", "auto"], ["Light", "light"], ["Dark", "dark"], ["None", "none"]] as const;

/** The browser swaps each logo for a copy with its transparent edges trimmed; wait for that copy before measuring. */
async function trimmedLogos(page: Page, selector: string, original: string, count: number) {
  await expect(page.locator(selector)).toHaveCount(count);
  for (const image of await page.locator(selector).all()) await expect(image).not.toHaveAttribute("src", original);
}

/** Every `selector` logo lies inside its frame and is drawn whole (scaled to fit, not cropped or stretched). */
async function expectLogosFit(page: Page, selector: string, count: number) {
  const boxes = await logoBoxes(page, selector, ".adaptive-logo");
  expect(boxes).toHaveLength(count);
  for (const { image, frame } of boxes) expect(inside(image, frame), `logo ${JSON.stringify(image)} inside frame ${JSON.stringify(frame)}`).toBe(true);
  expect(await page.locator(selector).evaluateAll((images) => images.map((image) => getComputedStyle(image).objectFit))).toEqual(Array(count).fill("contain"));
  return boxes;
}

type Measured = Awaited<ReturnType<typeof logoBoxes>>[number];
const within = (actual: number, expected: number, slack: number, label: string) => expect(Math.abs(actual - expected), `${label}: ${actual} is not within ${slack} of ${expected}`).toBeLessThanOrEqual(slack);

/** The page's rem in pixels, and the widest a header frame gets: the fixed width every header frame had before it followed the logo. */
const frameLimits = (page: Page) => page.evaluate(() => { const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); return { rem, headerMax: Math.min(Math.max(3.5 * rem, innerWidth * 0.08), 7 * rem) }; });

/**
 * A dashboard frame is `height` tall and as wide as its logo needs, between a square and `max` (in pixels; `height` and
 * `max` are the frame's fixed size before it followed the logo). The logo is as tall as the padding allows unless that
 * makes it wider than `max` allows. A plain frame has no padding, only its 1px border.
 */
function expectFrameFollowsLogo({ image, frame, natural, plain }: Measured, { height, max, rem }: { height: number; max: number; rem: number }, label: string) {
  const inset = (plain ? 0 : 0.38 * rem) + 1;
  within(frame.height, height, 0.1, `${label} frame height`);
  within(image.width, Math.min((height - 2 * inset) * natural.width / natural.height, max - 2 * inset), 1, `${label} logo width`);
  within(frame.width, Math.min(max, Math.max(Math.min(height, max), image.width + 2 * inset)), 1, `${label} frame width`);
}

/** The frame and the image box of a logo too wide to narrow its frame are exactly what they were before the frame followed the logo. */
function expectWideFrameUnchanged({ image, frame, plain }: Measured, { height, max, rem }: { height: number; max: number; rem: number }, label: string) {
  const inset = (plain ? 0 : 0.38 * rem) + 1;
  within(frame.width, max, 0.1, `${label} wide frame width`); within(frame.height, height, 0.1, `${label} wide frame height`);
  within(image.width, max - 2 * inset, 0.1, `${label} wide image box width`); within(image.height, height - 2 * inset, 0.1, `${label} wide image box height`);
}

/** The text beside a header logo starts one .8rem gap after the frame, whatever the frame's width. */
async function expectNameAfterFrame(page: Page, heading: string, frame: Box, rem: number) {
  within((await boxOf(page, heading)).x, frame.x + frame.width + 0.8 * rem, 0.6, "organization name after the frame");
}

const boxOf = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox()) as Box;
const boxesOf = (page: Page, selector: string) => page.locator(selector).evaluateAll((elements) => elements.map((element) => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; }));

for (const viewport of viewports) for (const shape of logoShapes) {
  test(`a ${shape.name} logo fits the top bar and both previews at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let logoData = "";
    await useLogoDashboard(page, attendanceSnapshot(), () => ({ logoData }));
    await page.goto("/settings/organization");
    await expect(page.getByRole("heading", { level: 1, name: "Organization" })).toBeVisible();
    await expect(page.locator(".dashboard-brand .brand-mark")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const plainToolbar = await boxOf(page, ".dashboard-toolbar");

    logoData = shape.logo();
    await page.reload();
    await trimmedLogos(page, ".dashboard-brand img", logoData, 1);
    await trimmedLogos(page, ".logo-preview-grid img", logoData, 2);

    // Top bar: the logo is inside its frame, and the bar is as tall as it is with no logo.
    const [brand] = await expectLogosFit(page, ".dashboard-brand img", 1);
    const toolbar = await boxOf(page, ".dashboard-toolbar");
    expect(toolbar.height).toBe(plainToolbar.height);
    expect(inside(brand.frame, toolbar)).toBe(true);
    // Its frame is one control tall and follows the logo's width, and the organization name starts right after it.
    const { rem, headerMax } = await frameLimits(page);
    const topBar = { height: 2.75 * rem, max: headerMax, rem };
    expectFrameFollowsLogo(brand, topBar, "top bar");
    if (shape.name === "wide") expectWideFrameUnchanged(brand, topBar, "top bar");
    await expectNameAfterFrame(page, ".dashboard-brand .brand-heading", brand.frame, rem);

    // Previews: with each contrast background, the logo is inside its frame, the frame inside its preview card, and
    // nothing lies over the contrast background choices.
    const options = page.getByRole("group", { name: "Logo contrast background" });
    for (const [label] of backdrops) {
      await options.getByText(label, { exact: true }).click();
      await expect(options.getByRole("radio", { name: label })).toBeChecked();
      const previews = await expectLogosFit(page, ".logo-preview-grid img", 2);
      const cards = await boxesOf(page, ".logo-preview-grid > div");
      previews.forEach((preview, index) => expect(inside(preview.frame, cards[index]), `${label} preview frame inside its card`).toBe(true));
      // Each preview frame is 5rem tall and follows the logo's width up to 14rem (or the card's content width, 1rem of
      // padding and a 1px border in from each side), starting at the card's left edge.
      previews.forEach((preview, index) => {
        const limits = { height: 5 * rem, max: Math.min(14 * rem, cards[index].width - 2 * rem - 2), rem };
        expectFrameFollowsLogo(preview, limits, `${label} preview`);
        if (shape.name === "wide") expectWideFrameUnchanged(preview, limits, `${label} preview`);
        within(preview.frame.x, cards[index].x + rem + 1, 0.6, `${label} preview frame at the card's left edge`);
      });
      const choices = [await boxOf(page, ".logo-backdrop-options"), ...await boxesOf(page, ".logo-backdrop-options label")];
      expect(choices).toHaveLength(5);
      for (const choice of choices) for (const preview of previews) {
        expect(overlaps(preview.image, choice), `${label}: logo over the contrast background choices`).toBe(false);
        expect(overlaps(preview.frame, choice), `${label}: logo frame over the contrast background choices`).toBe(false);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

for (const [label, logoBackdrop] of backdrops) {
  test(`a tall logo fits the top bar with the ${label} contrast background`, async ({ page }) => {
    await page.setViewportSize(viewports[0]);
    const logoData = pngLogo(300, 600);
    await useLogoDashboard(page, attendanceSnapshot(), () => ({ logoData, logoBackdrop }));
    await page.goto("/settings/organization");
    await trimmedLogos(page, ".dashboard-brand img", logoData, 1);
    await expect(page.locator(".dashboard-brand .adaptive-logo")).toHaveClass(new RegExp(logoBackdrop === "auto" ? "backdrop-(light|dark)" : `backdrop-${logoBackdrop}`));
    const [brand] = await expectLogosFit(page, ".dashboard-brand img", 1);
    expect(inside(brand.frame, await boxOf(page, ".dashboard-toolbar"))).toBe(true);
    const { rem, headerMax } = await frameLimits(page);
    expectFrameFollowsLogo(brand, { height: 2.75 * rem, max: headerMax, rem }, `${label} top bar`);
    await expectNameAfterFrame(page, ".dashboard-brand .brand-heading", brand.frame, rem);
  });
}

for (const viewport of viewports) {
  test(`the sign-in header is the same height with a logo of any shape, and its frame follows the logo, at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let logoData = pngLogo(600, 120);
    await useLogoDashboard(page, attendanceSnapshot(), () => ({ logoData }), { signedIn: false });
    await page.goto("/dashboard");
    await trimmedLogos(page, ".setup-header img", logoData, 1);
    const [wide] = await expectLogosFit(page, ".setup-header img", 1);
    const wideHeader = await boxOf(page, ".setup-header");
    const { rem, headerMax } = await frameLimits(page);
    const limits = { height: 3.6 * rem, max: headerMax, rem };
    expectFrameFollowsLogo(wide, limits, "wide sign-in");
    expectWideFrameUnchanged(wide, limits, "sign-in");
    await expectNameAfterFrame(page, ".setup-header .brand-heading", wide.frame, rem);

    for (const shape of logoShapes.filter((shape) => shape.name !== "wide")) {
      logoData = shape.logo();
      await page.reload();
      await trimmedLogos(page, ".setup-header img", logoData, 1);
      const [brand] = await expectLogosFit(page, ".setup-header img", 1);
      const header = await boxOf(page, ".setup-header");
      expect(header.height, `${shape.name} sign-in header height`).toBe(wideHeader.height);
      expect(inside(brand.frame, header)).toBe(true);
      expectFrameFollowsLogo(brand, limits, `${shape.name} sign-in`);
      await expectNameAfterFrame(page, ".setup-header .brand-heading", brand.frame, rem);
    }
  });
}

for (const shape of logoShapes) {
  test(`a ${shape.name} logo fits the web kiosk's brand row`, async ({ page }) => {
    await usePairedWebKiosk(page, shape.logo());
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/kiosk");
      await expect(page.locator(".wk-logo")).toBeVisible();
      const [{ image, frame, natural }] = await logoBoxes(page, ".wk-logo", ".wk-brand-hold");
      expect(inside(image, frame), `logo ${JSON.stringify(image)} inside brand row ${JSON.stringify(frame)}`).toBe(true);
      expect(inside(frame, await boxOf(page, ".wk-brand"))).toBe(true);
      // The box keeps the image's own proportions, so nothing is cropped or stretched.
      expect(image.width / image.height).toBeCloseTo(natural.width / natural.height, 1);
      // The web kiosk draws no frame around its logo: the image is its own box, at most 2.6em tall and 9em wide and
      // never larger than the file, so it is exactly as wide as the logo and the name starts one gap after it.
      const { em, gap } = await page.locator(".wk-brand-hold").evaluate((hold) => ({ em: parseFloat(getComputedStyle(hold).fontSize), gap: parseFloat(getComputedStyle(hold).columnGap) }));
      const scale = Math.min(1, 2.6 * em / natural.height, 9 * em / natural.width);
      within(image.width, natural.width * scale, 1, "web kiosk logo width"); within(image.height, natural.height * scale, 1, "web kiosk logo height");
      within((await boxOf(page, ".wk-brand-hold strong")).x, image.x + image.width + gap, 0.6, "web kiosk name after the logo");
      expect(overlaps(image, await boxOf(page, ".wk-body"))).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });

  for (const logoBackdrop of ["auto", "none"]) test(`a ${shape.name} logo fits the Pi kiosk's brand row with the ${logoBackdrop} contrast background`, async ({ page }) => {
    // The kiosk keeps polling display-state; let a poll inside the handler finish before the context closes.
    const logoData = shape.logo();
    await page.route(`${kioskBaseUrl}/display-state`, async (route) => {
      const response = await route.fetch(); const state = await response.json();
      await route.fulfill({ response, json: { ...state, branding: { ...state.branding, logoData, logoBackdrop } } });
    });
    try {
      for (const viewport of [{ width: 800, height: 480 }, { width: 1280, height: 720 }]) {
        await page.setViewportSize(viewport);
        await page.goto(`${kioskBaseUrl}/`);
        await expect(page.locator("#brand-logo")).toBeVisible();
        await expect(page.locator("#brand-logo")).not.toHaveAttribute("src", logoData);
        const [{ image, frame, natural, plain }] = await logoBoxes(page, "#brand-logo", "#brand-logo-frame");
        expect(inside(image, frame), `logo ${JSON.stringify(image)} inside frame ${JSON.stringify(frame)} at ${viewport.height}px`).toBe(true);
        expect(inside(frame, await boxOf(page, "#brand"))).toBe(true);
        expect(image.width / image.height).toBeCloseTo(natural.width / natural.height, 1);
        const height = viewport.height <= 520 ? 48 : 60;
        expect(frame.height).toBe(height);
        // The frame follows the logo's width between a square and 180px. Its inset is 7px, or the 1px border when plain.
        // The logo is as large as that allows, but never larger than the file.
        const inset = plain ? 1 : 7;
        const scale = Math.min(1, (height - 2 * inset) / natural.height, (180 - 2 * inset) / natural.width);
        within(image.width, natural.width * scale, 1, "Pi kiosk logo width");
        within(frame.width, Math.min(180, Math.max(height, image.width + 2 * inset)), 1, "Pi kiosk frame width");
        // The name ends, and the subtitle starts, one 16px gap from the frame.
        const name = await boxOf(page, "#brand-name"), subtitle = await boxOf(page, "#brand-subtitle");
        within(name.x + name.width, frame.x - 16, 0.6, "Pi kiosk name before the frame"); within(subtitle.x, frame.x + frame.width + 16, 0.6, "Pi kiosk subtitle after the frame");
        expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual(viewport);
      }
    } finally { await page.unrouteAll({ behavior: "wait" }); }
  });
}
