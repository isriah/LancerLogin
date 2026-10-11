import { expect, type Page } from "@playwright/test";

export async function setDashboardTheme(page: Page, theme: "light" | "dark") {
  const current = page.url();
  await page.goto("/settings/session");
  const toggle = page.getByRole("switch", { name: "Dark mode" });
  if (await toggle.isChecked() !== (theme === "dark")) await toggle.click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await page.goto(current);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
}
