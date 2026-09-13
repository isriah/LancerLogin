import { expect, test, type Page } from '@playwright/test';

const key = 'lancerlogin-pending-meeting-deletion';
async function seed(page: Page, value: string) {
  await page.goto('/meetings/active-meeting');
  await expect(page.getByRole('heading', { name: 'Build session' })).toBeVisible();
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key, value });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
const handoff = (createdAt: number) => JSON.stringify({ meetingId: 'active-meeting', title: 'Build session', scope: 'occurrence', createdAt });

test('fresh deletion handoff expires at its original deadline and cannot return after refresh', async ({ page }) => {
  const now = Date.UTC(2026, 8, 10, 12);
  // Install before the pause target so command latency cannot make it a past time.
  await page.clock.install({ time: now - 3_600_000 });
  await page.clock.pauseAt(now);
  await seed(page, handoff(now - 20_000));
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  await page.clock.fastForward(9_999);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.clock.fastForward(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
});

test('refresh consumes even an unexpired handoff', async ({ page }) => {
  await seed(page, handoff(Date.now()));
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
});

for (const invalid of ['invalid JSON', 'null', '{}', 'future', 'expired']) {
  test(`ignores and clears ${invalid} deletion handoff`, async ({ page }) => {
    await seed(page, invalid === 'future' ? handoff(Date.now() + 60_000) : invalid === 'expired' ? handoff(Date.now() - 30_001) : invalid);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  });
}

test('keyboard Undo restores the saved occurrence and clears notice and storage', async ({ page }) => {
  let restored: unknown;
  await page.route('**/meetings/active-meeting/restore', async route => {
    restored = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await seed(page, handoff(Date.now()));
  await page.getByRole('button', { name: 'Undo', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Build session was restored.' })).toBeVisible();
  expect(restored).toEqual({ scope: 'occurrence' });
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
});
