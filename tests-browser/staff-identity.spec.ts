import { test, expect } from '@playwright/test';
import { dashboardConformanceReferences as reference } from '../apps/dashboard/src/design-conformance';
for (const viewport of reference.viewports) for (const theme of reference.themes) {
 test('staff workspace is isolated at '+viewport.width+' in '+theme, async ({page}) => {
  await page.setViewportSize(viewport);
  await page.addInitScript(value=>localStorage.setItem('lancerlogin-theme',value),theme);
  await page.route('**/setup/status',route=>route.fulfill({json:{configured:true,installation:{authMode:'local'},settings:{organizationName:'Synthetic Committee',primaryColor:reference.brand.primary,secondaryColor:reference.brand.secondary,appearance:theme}}}));
  const role='staff';
  await page.route('**/auth/session',route=>route.fulfill({json:{user:{role}}}));
  let capabilities:string[]=[];
  await page.route('**/platform/modules',route=>route.fulfill({json:{capabilities,modules:[{id:'hour-tracking',enabled:true,capabilities:['hours.manage'],navigation:{path:'/hours',label:'Hour Tracking'}}]}}));
  const forbidden:string[]=[];
  page.on('request',request=>{ if (/\/(admin|meetings|attendance|integrations)\//.test(new URL(request.url()).pathname)) forbidden.push(request.url()); });
  await page.goto('/settings/access');
  await expect(page.getByRole('heading',{level:1,name:'Your workspace'})).toBeVisible();
  await expect(page.getByText('No module workspace is enabled', {exact:false})).toBeVisible();
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByRole('navigation',{name:'Primary dashboard navigation'})).toHaveCount(0);
  await expect(page.locator('.app')).toHaveAttribute('data-theme',theme);
  await expect(page.locator('.app')).toHaveCSS('--primary',reference.brand.primary);
  const signOut=page.getByRole('button',{name:'Sign out'});
  await signOut.focus(); await expect(signOut).toBeFocused();
  expect(await signOut.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe('none');
  expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  capabilities=['hours.manage'];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('link',{name:'Hour Tracking',exact:true})).toBeVisible();
  expect(forbidden).toEqual([]);
  await page.screenshot({path:test.info().outputPath('staff-'+theme+'.png'),fullPage:true});
  await signOut.press('Enter');
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
 });
}
test('Admin role selector supports Staff',async({page})=>{
 await page.route('**/auth/session',route=>route.fulfill({json:{user:{role:'admin'}}}));
 await page.route('**/admin/setup/progress',route=>route.fulfill({json:{completedSteps:['branding','roster','pair-kiosk','fingerprint-test','confirm-attendance'].map(step=>({step}))}}));
 await page.route('**/admin/users',route=>route.fulfill({json:{users:[]}}));
 await page.goto('/settings/access');
 const role=page.getByRole('combobox',{name:'Role',exact:true});
 await role.selectOption('staff');
 await expect(role).toHaveValue('staff');
 await expect(page.getByRole('option',{name:'Staff (module access only)'}).first()).toBeAttached();
});
