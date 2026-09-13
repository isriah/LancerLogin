import { expect, test, type Page } from '@playwright/test';
import { dashboardConformanceReferences as reference } from '../apps/dashboard/src/design-conformance';

const base = { revision: 0, archived: false };
const category = { ...base, id: 'event', name: 'Event', mode: 'event', impactDefault: false };
const team = { ...base, id: 'team-1', name: 'Synthetic partner', number: '00123', organization: 'Synthetic organization', program: 'FTC', historicalDescriptors: '' };
const activity = { ...base, id: 'activity-1', categoryId: 'event', mode: 'event', teamId: null, serviceDate: '2026-11-01', title: 'Synthetic event', description: 'Planning only', location: 'Workshop', planningTimeZone: 'America/New_York', startsAt: '2026-11-01T05:30:00.000Z', endsAt: '2026-11-01T06:30:00.000Z', impactRelevant: false, responsibleStaffIds: ['staff-choice'], partnerTeamIds: ['team-1'], sourceMeetingId: null, sourceState: undefined };
const modules = (enabled = true, granted = true) => ({ revision: 0, capabilities: granted && enabled ? ['hours.manage'] : [], modules: [{ id: 'hour-tracking', enabled, capabilities: ['hours.manage'], navigation: { path: '/hours', label: 'Hour Tracking' } }, { id: 'activity-documentation', enabled: false, capabilities: ['documentation.manage'], navigation: { path: '/documentation', label: 'Activity Documentation' } }] });
async function setup(page: Page, role = 'staff', theme = 'light') {
  let sourceEnd = '2026-11-01T06:30:00.000Z'; let zone = 'America/New_York'; let access = modules(); let failWrite = false; let malformedRead = false; let failReadback = false;
  const writes: { path: string; method: string; body: any }[] = []; const requests: string[] = [];
  const rows: Record<string, any[]> = { categories: [category, { ...category, id: 'support', name: 'Team Support', mode: 'team' }], teams: [team], activities: [activity] };
  await page.addInitScript(value => localStorage.setItem('lancerlogin-theme', value), theme);
  await page.route('**/setup/status', route => route.fulfill({ json: { configured: true, installation: { authMode: 'local' }, settings: { organizationName: 'Synthetic Hours Team', primaryColor: reference.brand.primary, secondaryColor: reference.brand.secondary, appearance: theme } } }));
  await page.route('**/auth/session', route => route.fulfill({ json: { user: { id: 'session-user', role } } }));
  await page.route('**/admin/setup/progress', route => route.fulfill({ json: { completedSteps: ['branding', 'roster', 'pair-kiosk', 'fingerprint-test', 'confirm-attendance'].map(step => ({ step })) } }));
  await page.route('**/platform/modules', route => route.fulfill({ json: access }));
  await page.route('**/admin/hours/**', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(url.pathname + url.search);
    const [, kind, id] = url.pathname.split('/admin/hours/').join('/').split('/');
    if (url.pathname.endsWith('/responsible-staff')) { await route.fulfill({ json: { items: [{ id: 'staff-choice', label: 'Synthetic planner', active: true, selectable: true, linked: !!url.searchParams.get('activityId') }, { id: 'unnamed', label: 'Account needs a roster link or local username', active: true, selectable: false, linked: false }], nextCursor: null } }); return; }
    if (url.pathname.endsWith('/attendance-sources')) { await route.fulfill({ json: { items: [{ id: 'source', title: 'Synthetic attendance plan', serviceDate: '2026-11-01', startsAt: '2026-11-01T05:30:00.000Z', endsAt: sourceEnd }], nextCursor: null, timeZone: zone } }); return; }
    if (!rows[kind]) { await route.fulfill({ status: 404, json: { error: 'Unknown fixture path' } }); return; }
    if (request.method() === 'GET') {
      if (malformedRead || (failReadback && writes.length)) { await route.fulfill({ json: {} }); return; }
      if (id) await route.fulfill({ json: rows[kind].find(row => row.id === decodeURIComponent(id)) });
      else { const result = rows[kind].filter(row => (url.searchParams.get('archived') === 'all' || row.archived === (url.searchParams.get('archived') === 'true')) && (!url.searchParams.get('after') || row.id > url.searchParams.get('after')!) && (!url.searchParams.get('mode') || row.mode === url.searchParams.get('mode')) && (!url.searchParams.get('categoryId') || row.categoryId === url.searchParams.get('categoryId')) && (!url.searchParams.get('teamId') || row.teamId === url.searchParams.get('teamId'))); const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 50); await route.fulfill({ json: { items: result.slice(0, limit), nextCursor: result.length > limit ? result[limit - 1].id : null } }); }
      return;
    }
    const body = request.postDataJSON(); writes.push({ path: url.pathname, method: request.method(), body });
    if (failWrite || (kind === 'activities' && !id && body.expectedTimeZone !== zone)) { await route.fulfill({ status: 409, json: { error: 'Fixture conflict' } }); return; }
    const previous = id ? rows[kind].find(row => row.id === id) : undefined;
    const result = { ...(kind === 'activities' ? { ...activity, sourceMeetingId: null } : kind === 'teams' ? team : category), ...previous, ...body, id: id ?? 'created-' + writes.length, revision: previous ? previous.revision + 1 : 0, ...(kind === 'activities' ? { mode: rows.categories.find(row => row.id === body.categoryId)?.mode ?? previous?.mode } : {}) };
    rows[kind] = [...rows[kind].filter(row => row.id !== result.id), result]; await route.fulfill({ status: id ? 200 : 201, json: { id: result.id, revision: result.revision } });
  });
  return { rows, writes, requests, setSourceEnd: (value: string) => sourceEnd = value, setZone: (value: string) => zone = value, setAccess: (value: ReturnType<typeof modules>) => access = value, fail: (value = true) => failWrite = value, malformed: (value = true) => malformedRead = value, failReadback: (value = true) => failReadback = value };
}

test('hours-only Staff create/edit/archive/reopen catalogs through named choices', async ({ page }) => {
  const fixture = await setup(page); await page.goto('/hours');
  await page.getByRole('button', { name: 'Categories', exact: true }).click(); await page.getByRole('button', { name: 'Create category', exact: true }).click();
  await page.getByLabel('Category name', { exact: true }).fill('Synthetic service'); await page.getByLabel('Entry mode').selectOption('task'); await page.getByLabel('Impact relevance by default').check(); await page.getByRole('button', { name: 'Save category', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit category', exact: true })).toBeFocused();
  expect(fixture.writes[0].body).toEqual({ name: 'Synthetic service', mode: 'task', impactDefault: true });
  await page.getByRole('button', { name: 'Close editor' }).click(); await page.getByRole('button', { name: 'Archive Synthetic service', exact: true }).click(); await expect(page.getByRole('button', { name: 'Edit Synthetic service' })).toHaveCount(0);
  await page.getByLabel('Record status').selectOption('true'); await page.getByRole('button', { name: 'Apply filters' }).click(); await page.getByRole('button', { name: 'Reopen Synthetic service' }).click();
  await page.getByRole('button', { name: 'Supported teams', exact: true }).click(); await page.getByRole('button', { name: 'Edit Synthetic partner' }).click(); await expect(page.getByLabel('Team number', { exact: true })).toHaveValue('00123'); await page.getByLabel('Historical descriptors').fill('Synthetic support history'); await page.getByRole('button', { name: 'Save team', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Saved and confirmed' })).toBeVisible();
  expect(fixture.writes.at(-1)!.body.number).toBe('00123'); await expect(page.getByRole('link', { name: 'Roster', exact: true })).toHaveCount(0);
});

test('planning edits preserve explicit fold occurrence and saved zone; gaps and non-event identity fail closed', async ({ page }) => {
  const fixture = await setup(page); await page.goto('/hours'); await page.getByRole('button', { name: 'Edit Synthetic event' }).click();
  await expect(page.getByLabel('Start time occurrence')).toHaveValue('earlier'); await expect(page.getByLabel('End time occurrence')).toHaveValue('later');
  await page.getByLabel('Description', { exact: true }).fill('Changed planning description'); await page.getByRole('button', { name: 'Save activity', exact: true }).click();
  expect(fixture.writes[0].body.startsAt).toBe('2026-11-01T05:30:00.000Z'); expect(fixture.writes[0].body.endsAt).toBe('2026-11-01T06:30:00.000Z');
  await page.getByLabel('Service date').fill('2026-03-08'); await page.getByLabel('Start time', { exact: true }).fill('02:30'); await expect(page.getByText('This local time does not exist', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Save activity', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close editor' }).click(); await page.getByRole('button', { name: 'Create activity', exact: true }).click(); await page.getByLabel('Category', { exact: true }).selectOption('support'); await page.getByLabel('Supported team', { exact: true }).selectOption('team-1'); await page.getByLabel('Service date').fill('2026-11-02'); await page.getByRole('button', { name: 'Save activity', exact: true }).click();
  await expect(page.getByLabel('Service date')).toBeDisabled(); expect(fixture.writes.at(-1)!.body.teamId).toBe('team-1'); await expect(page.getByLabel('Category', { exact: true })).toBeDisabled();
});

test('attendance reuse uses organization date filters and independent staff selections', async ({ page }) => {
  const fixture = await setup(page); await page.goto('/hours'); await page.getByRole('button', { name: 'Create activity', exact: true }).click(); await page.getByLabel('Category', { exact: true }).selectOption('event');
  await page.getByText('Reuse attendance planning details (optional)', { exact: true }).click(); await page.getByLabel('Source from date').fill('2026-11-01'); await page.getByLabel('Source through date').fill('2026-11-01'); await page.getByLabel('Attendance source', { exact: true }).selectOption('source');
  await expect(page.getByLabel('Activity title', { exact: true })).toHaveValue('Synthetic attendance plan'); await expect(page.getByLabel('Service date')).toHaveValue('2026-11-01');
  await page.getByLabel('Synthetic planner', { exact: true }).check(); await expect(page.getByLabel('Account needs a roster link', { exact: false })).toBeDisabled();
  await page.getByRole('button', { name: 'Save activity', exact: true }).click(); expect(fixture.writes[0].body.expectedTimeZone).toBe('America/New_York'); expect(fixture.writes[0].body.sourceMeetingId).toBe('source'); expect(fixture.writes[0].body.responsibleStaffIds).toEqual(['staff-choice']);
  const query = fixture.requests.filter(path => path.includes('/attendance-sources?from=')).at(-1)!; expect(decodeURIComponent(query)).toContain('from=2026-11-01T04:00:00.000Z'); expect(decodeURIComponent(query)).toContain('to=2026-11-02T05:00:00.000Z');
});

test('conflict and uncertain create readback require explicit reload without repeating writes', async ({ page }) => {
  const fixture = await setup(page); await page.goto('/hours'); await page.getByRole('button', { name: 'Edit Synthetic event' }).click(); fixture.fail(); await page.getByRole('button', { name: 'Save activity', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'could not be confirmed' })).toBeFocused(); await expect(page.getByRole('button', { name: 'Save activity', exact: true })).toBeDisabled();
  fixture.fail(false); await page.getByRole('button', { name: 'Reload current record' }).click(); expect(fixture.writes).toHaveLength(1); await expect(page.getByRole('button', { name: 'Save activity', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close editor' }).click(); await page.getByRole('button', { name: 'Create activity', exact: true }).click(); await page.getByLabel('Category', { exact: true }).selectOption('event'); await page.getByLabel('Service date').fill('2026-09-09'); fixture.failReadback(); await page.getByRole('button', { name: 'Save activity', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'could not be confirmed' })).toBeVisible(); fixture.failReadback(false); fixture.setZone('Asia/Tokyo'); await page.getByRole('button', { name: 'Reload current record' }).click(); expect(fixture.writes).toHaveLength(2); await expect(page.locator('fieldset').filter({ has: page.getByText('Optional planning times', { exact: true }) }).getByText('Asia/Tokyo', { exact: true })).toBeVisible();
});

for (const role of ['admin', 'operator', 'staff']) test(`server capability grants ${role} the same workspace and revocation closes it`, async ({ page }) => {
  const fixture = await setup(page, role); await page.goto('/hours'); await expect(page.getByRole('button', { name: 'Create activity', exact: true })).toBeVisible(); fixture.setAccess(modules(false)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('heading', { name: 'Workspace unavailable' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Create activity', exact: true })).toHaveCount(0);
});

test('catalog paging is bounded, date filters are explicit, and malformed reload disables writes', async ({ page }) => {
  const fixture = await setup(page); fixture.rows.activities = Array.from({ length: 51 }, (_, index) => ({ ...activity, id: 'activity-' + String(index).padStart(3, '0'), title: 'Synthetic activity ' + index }));
  await page.goto('/hours'); await expect(page.getByText('50 records on this page.', { exact: false })).toBeVisible(); await page.getByLabel('Activity mode').selectOption('task'); await page.getByRole('button', { name: 'Activities', exact: true }).click(); await expect(page.getByLabel('Activity mode')).toHaveValue('task'); await page.getByRole('button', { name: 'Next records page' }).click(); expect(fixture.requests.filter(value => value.includes('/activities?')).at(-1)).not.toContain('mode='); await page.getByLabel('Activity mode').selectOption(''); await expect(page.getByText('1 records on this page.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Synthetic activity 50', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit Synthetic activity 0', exact: true })).toHaveCount(0);
  await page.getByLabel('From service date').fill('2026-11-01'); await page.getByLabel('Through service date').fill('2026-11-02'); await page.getByRole('button', { name: 'Apply filters' }).click(); await expect(page.getByText('50 records on this page.', { exact: false })).toBeVisible();
  expect(fixture.requests.some(value => value.includes('from=2026-11-01') && value.includes('to=2026-11-02') && !value.includes('after='))).toBe(true);
  fixture.malformed(); await page.getByRole('button', { name: 'Reload catalogs' }).click(); await expect(page.getByRole('alert')).toContainText('could not be confirmed'); await expect(page.getByRole('button', { name: 'Create activity', exact: true })).toBeDisabled(); expect(fixture.writes).toHaveLength(0);
});

test('saved archived team names and changed attendance snapshots remain visible without dropping links', async ({ page }) => {
  const fixture = await setup(page); fixture.rows.teams = [{ ...team, archived: true }]; fixture.rows.activities = [{ ...activity, sourceMeetingId: 'source', sourceState: 'changed', sourceSnapshot: { title: 'Original planning title', serviceDate: activity.serviceDate, startsAt: activity.startsAt, endsAt: activity.endsAt } }];
  await page.goto('/hours'); await page.getByRole('button', { name: 'Edit Synthetic event' }).click(); await expect(page.getByText('Original planning title', { exact: false })).toContainText('Source has changed'); await expect(page.getByRole('group', { name: 'Partner teams', exact: true })).toContainText('00123 · Synthetic partner');
  await page.getByRole('button', { name: 'Save activity', exact: true }).click(); expect(fixture.writes[0].body.partnerTeamIds).toEqual(['team-1']); expect(fixture.writes[0].body).not.toHaveProperty('sourceMeetingId');
});

for (const theme of ['light', 'dark']) for (const width of [1280, 390]) test(`hours editor ${theme} ${width}: keyboard brand and layout`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.emulateMedia({ colorScheme: theme as 'light' | 'dark', reducedMotion: 'reduce' }); await setup(page, 'staff', theme); await page.goto('/hours'); await page.getByRole('button', { name: 'Edit Synthetic event' }).click();
  await expect(page.getByRole('heading', { name: 'Edit activity', exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(page.getByLabel('Service date')).toBeFocused(); expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const control of await page.locator('.hours-workspace button, .staff-workspace-navigation a').all()) if (await control.isVisible()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`hours-${theme}-${width}.png`), fullPage: true });
});


test('multi-day source timing may be explicitly disabled or detached without obsolete validation', async ({ page }) => {
  const fixture = await setup(page); fixture.setSourceEnd('2026-11-03T16:00:00.000Z'); await page.goto('/hours'); await page.getByRole('button', { name: 'Create activity', exact: true }).click(); await page.getByLabel('Category', { exact: true }).selectOption('event');
  await page.getByText('Reuse attendance planning details (optional)', { exact: true }).click(); await page.getByLabel('Attendance source', { exact: true }).selectOption('source');
  await expect(page.getByText('The source spans', { exact: false })).toBeVisible(); await page.getByLabel('Attendance source', { exact: true }).selectOption(''); await expect(page.getByText('The source spans', { exact: false })).toHaveCount(0); await expect(page.getByLabel('Activity title', { exact: true })).toHaveValue('Synthetic attendance plan');
  await page.getByLabel('Attendance source', { exact: true }).selectOption('source'); await page.getByLabel('Category', { exact: true }).selectOption('support'); await expect(page.getByText('The source spans', { exact: false })).toHaveCount(0);
  await page.getByLabel('Category', { exact: true }).selectOption('event'); await page.getByText('Reuse attendance planning details (optional)', { exact: true }).click(); await page.getByLabel('Attendance source', { exact: true }).selectOption('source');
  await page.getByLabel('Set planning times', { exact: false }).uncheck(); await page.getByRole('button', { name: 'Save activity', exact: true }).click(); expect(fixture.writes[0].body).toMatchObject({ sourceMeetingId: 'source', startsAt: null, endsAt: null });
});


test('new activity rejects a changed planning zone until explicit draft reload', async ({ page }) => {
  const fixture = await setup(page); await page.goto('/hours'); await page.getByRole('button', { name: 'Create activity', exact: true }).click(); await page.getByLabel('Category', { exact: true }).selectOption('event'); await page.getByLabel('Service date').fill('2026-11-01'); fixture.setZone('Asia/Tokyo');
  await page.getByRole('button', { name: 'Save activity', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'could not be confirmed' })).toContainText('organization planning zone'); expect(fixture.writes[0].body.expectedTimeZone).toBe('America/New_York'); await expect(page.getByRole('button', { name: 'Save activity', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload current record' }).click(); await page.getByLabel('Category', { exact: true }).selectOption('event'); await page.getByLabel('Service date').fill('2026-11-01'); expect(fixture.writes).toHaveLength(1); await page.getByRole('button', { name: 'Save activity', exact: true }).click(); expect(fixture.writes[1].body.expectedTimeZone).toBe('Asia/Tokyo');
});
