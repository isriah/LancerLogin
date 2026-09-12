import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const pages = ["index.html", "setup.html", "kiosk.html", "operations.html", "privacy.html", "releases.html", "technical.html"];
const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const themes = ["light", "dark"] as const;

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
}

function contrast(foreground: string, background: string) {
  const parse = (value: string) => {
    if (value.startsWith("#")) {
      const hex = value.slice(1);
      return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    }
    return value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  };
  const luminance = (value: string) => {
    const [red, green, blue] = parse(value).map(channel);
    return .2126 * red + .7152 * green + .0722 * blue;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + .05) / (darker + .05);
}

for (const viewport of viewports) {
  for (const theme of themes) {
    test(`${viewport.name} ${theme} public documentation conformance`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });

      for (const file of pages) {
        await test.step(file, async () => {
          await page.goto(pathToFileURL(resolve("docs-site", file)).href);
          await expect(page.locator("h1")).toHaveCount(1);
          await expect(page.locator("main")).toHaveAttribute("id", "main");
          await expect(page.locator(".nav")).toHaveAttribute("aria-label", "Documentation");
          await expect(page.locator(".skip")).toHaveAttribute("href", "#main");

          const palette = await page.locator(":root").evaluate((root) => {
            const styles = getComputedStyle(root);
            return {
              primary: styles.getPropertyValue("--brand-primary").trim(),
              secondary: styles.getPropertyValue("--brand-secondary").trim(),
              canvas: styles.getPropertyValue("--ui-canvas").trim(),
              text: styles.getPropertyValue("--ui-text").trim(),
              motion: styles.scrollBehavior,
            };
          });
          expect(palette.primary.toUpperCase()).toBe("#B80100");
          expect(palette.secondary.toUpperCase()).toBe("#EEB822");
          expect(contrast(palette.text, palette.canvas)).toBeGreaterThanOrEqual(4.5);
          expect(palette.motion).toBe("auto");

          const documentWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
          expect(documentWidth.scroll).toBeLessThanOrEqual(documentWidth.viewport);

          for (const image of await page.locator("img").all()) {
            await expect(image).toBeVisible();
            expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          }
          for (const table of await page.locator("table").all()) {
            const box = await table.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          }

          await page.keyboard.press("Tab");
          await expect(page.locator(".skip")).toBeFocused();
          await expect(page.locator(".skip")).toHaveCSS("transform", "none");
          const skipStyle = await page.locator(".skip").evaluate((element) => {
            const styles = getComputedStyle(element);
            return { outline: parseFloat(styles.outlineWidth), top: element.getBoundingClientRect().top };
          });
          expect(skipStyle.outline).toBeGreaterThanOrEqual(3);
          expect(skipStyle.top).toBeGreaterThanOrEqual(0);

          const navigationTargets = await page.locator(".nav a").evaluateAll((links) =>
            links.map((link) => link.getBoundingClientRect().height),
          );
          expect(navigationTargets.every((height) => height >= 44)).toBe(true);
          await page.screenshot({ fullPage: true });
        });
      }
    });
  }
}
