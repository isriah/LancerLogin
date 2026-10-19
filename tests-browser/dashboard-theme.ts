import { expect, type Page } from "@playwright/test";

export async function setDashboardTheme(page: Page, theme: "light" | "dark") {
  const current = page.url();
  await page.goto("/settings/session");
  const navigation = page.getByRole("button", { name: /^Settings ·/ });
  if (await navigation.isVisible() && await navigation.getAttribute("aria-expanded") === "false") await navigation.click();
  const toggle = page.getByRole("switch", { name: "Light mode" });
  if (await toggle.isChecked() !== (theme === "light")) await toggle.click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await page.goto(current);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
}
