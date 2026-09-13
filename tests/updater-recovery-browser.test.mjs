import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { recoveryFixture } from './fixtures/updater-recovery-fixture.mjs';

test('standalone recovery supports keyboard/mobile login and preserves recovery UUID after a lost reply and reload', async t => {
  const f = await recoveryFixture(); t.after(f.close);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const page = await context.newPage(), errors = [], recoveryRequests = []; let loseReply = true, expiresAt, advances = 0;
  await page.clock.install();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const incoming = route.request(); assert.equal(new URL(incoming.url()).origin, f.origin, 'no application or third-party requests');
    const headers = await incoming.allHeaders(), body = incoming.postDataBuffer();
    const request = new Request(incoming.url(), { method: incoming.method(), headers, body: ['GET', 'HEAD'].includes(incoming.method()) ? undefined : body });
    if (new URL(incoming.url()).pathname === '/recovery/advance') advances++;
    if (new URL(incoming.url()).pathname === '/recovery/recovery') {
      recoveryRequests.push(JSON.parse(incoming.postData()));
      if (loseReply) { loseReply = false; await route.abort(); return; }
    }
    const response = await f.service.fetch(request);
    if(response.headers.get('content-type')?.includes('application/json')){const value=await response.clone().json();if(value.expiresAt)expiresAt=value.expiresAt;}
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(f.origin + '/recovery');
  const credential = page.getByLabel('Recovery credential'); await credential.fill(f.credential);
  await page.getByRole('button', { name: 'Sign in to recovery' }).focus();
  assert.equal(await page.getByRole('button', { name: 'Sign in to recovery' }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Recover the failed update' }).waitFor();
  assert.equal(await credential.inputValue(), '');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(f.credential));
  assert.equal(await page.evaluate(() => document.cookie.includes('__Host-lancerlogin_recovery')), false);
  assert.equal(await page.getByRole('button', { name: 'Restore verified backup' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.ok((await page.getByRole('button', { name: 'Recover previous code' }).boundingBox()).height >= 44);
  await page.getByRole('button', { name: 'Recover previous code' }).click();
  await page.getByText('A recovery request is awaiting confirmation.', { exact: false }).waitFor();
  const savedRequest=await page.evaluate(()=>localStorage.getItem('lancerlogin-independent-recovery-request-v1'));
  await page.clock.setSystemTime(new Date((expiresAt-59)*1000));await page.clock.runFor(1000);
  assert.match(await page.locator('#expiry').textContent(),/within one minute/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path:'test-results/recovery-expiry-mobile.png',fullPage:true});
  f.expire();await page.clock.setSystemTime(new Date((expiresAt+1)*1000));await page.clock.runFor(1000);
  await page.getByRole('heading',{name:'Recovery sign-in'}).waitFor();assert.equal(await page.locator('#workspace').isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Recover previous code'}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('lancerlogin-independent-recovery-request-v1')),savedRequest);
  await credential.fill(f.credential);await page.getByRole('button',{name:'Sign in to recovery'}).click();
  await page.getByText('Signed in. Select Continue automatically to resume a job.',{exact:true}).waitFor();
  await page.clock.runFor(1100);assert.equal(advances,0,'sign-in cannot arm retained job or retry frozen mutation');
  assert.equal(await page.evaluate(()=>localStorage.getItem('lancerlogin-independent-recovery-request-v1')),savedRequest);
  await page.reload(); await page.getByRole('button', { name: 'Recover previous code' }).click();
  await page.getByRole('button', { name: 'Continue automatically' }).waitFor();
  await page.getByRole('button', { name: 'Pause automatic progress' }).click();
  assert.equal(recoveryRequests.length, 2); assert.deepEqual(recoveryRequests[1], recoveryRequests[0]);
  assert.equal(await page.evaluate(() => localStorage.getItem('lancerlogin-independent-recovery-request-v1')), null);
  await page.getByRole('button', { name: 'Continue automatically' }).focus(); await page.keyboard.press('Enter');
  for(let i=0;i<9;i++) await page.clock.runFor(1100);
  await page.locator('#job').filter({hasText:'recovered'}).waitFor();
  await page.setViewportSize({width:1280,height:900}); await page.emulateMedia({colorScheme:'light'});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByRole('heading', { name: 'Recovery sign-in' }).waitFor();
  assert.deepEqual(errors, []);
});
