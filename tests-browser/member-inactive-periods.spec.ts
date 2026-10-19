import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';

test('reactivating a member keeps inactive meetings out of attendance totals', async ({ page, baseURL }) => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const db = await runtime.getD1Database('DB');
    for (const name of readdirSync('apps/api/migrations').filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync('apps/api/migrations/' + name, 'utf8').replace(/^\s*--.*$/gm, '').replace(/\r?\n/g, ' '));
    await db.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1),('primary','hour-tracking',1),('primary','carpool',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1),('primary','hour-tracking',1,1,'disabled',1,0),('primary','carpool',1,1,'disabled',1,0);
      INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) SELECT 'primary','attendance',value,2,'completed','2026-01-01T00:00:00.000Z','admin' FROM json_each('["rules","meeting","input"]');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('member','primary','GAP001','Synthetic','Member','2026-01-01');`.replace(/\n/g, ' '));
    const secret = 'A'.repeat(43);
    const cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin' });
    const apiPort = Number(new URL(baseURL!).port) + 1;
    await page.route('**/*', async route => {
      if (Number(new URL(route.request().url()).port) !== apiPort) return route.continue();
      const request = route.request();
      const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers: { ...request.headers(), cookie }, ...(request.postData() ? { body: request.postData()! } : {}) }), { DB: db, SESSION_KEY: secret, APP_MODE: 'configured', ALLOWED_ORIGIN: new URL(baseURL!).origin });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto('/roster');
    await page.getByRole('button', { name: "Don't show automatically again", exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'GAP001' });
    await row.getByRole('button', { name: 'Edit Synthetic Member', exact: true }).click();
    await page.getByRole('dialog', { name: 'Edit roster member' }).getByRole('button', { name: 'Deactivate member', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('all');
    await expect(row.getByText('Inactive', { exact: true })).toBeVisible();
    // Move only the synthetic interval back in time to exercise a completed meeting.
    await db.prepare("UPDATE members SET inactive_periods_json=? WHERE id='member'").bind(JSON.stringify([['2026-02-01T00:00:00.000Z', null]])).run();
    await db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('gap','primary','Inactive meeting','2026-02-02T12:00:00.000Z','2026-02-02T13:00:00.000Z','admin','2026-01-01')").run();
    await row.getByRole('button', { name: 'Edit Synthetic Member', exact: true }).click();
    await page.getByRole('dialog', { name: 'Edit roster member' }).getByRole('button', { name: 'Activate member', exact: true }).click();
    await expect(row.getByText('Inactive', { exact: true })).toHaveCount(0);
    await expect(row.locator('.roster-attendance-rate')).toContainText('N/A');
    const report = await worker.fetch(new Request('https://fixture.test/reports/attendance', { headers: { cookie } }), { DB: db, SESSION_KEY: secret, APP_MODE: 'configured', ALLOWED_ORIGIN: 'https://fixture.test' });
    expect(report.status).toBe(200);
    const summary = (await report.json() as { members: { primaryTotal: number; rows: unknown[] }[] }).members[0];
    expect(summary.primaryTotal).toBe(0); expect(summary.rows).toEqual([]);
    const member = await db.prepare("SELECT active,inactive_periods_json AS periods FROM members WHERE id='member'").first<{ active: number; periods: string }>();
    expect(member?.active).toBe(1); expect(JSON.parse(member!.periods)[0][1]).toBeTruthy();
  } finally { await runtime.dispose(); }
});
