import {test,expect} from '@playwright/test';
for(const [theme,width,height]of [['light',1280,900],['dark',1280,900],['light',390,844],['dark',390,844]] as const)test(`initial profile module settings ${theme} ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height});await page.addInitScript(theme=>localStorage.setItem('lancerlogin-theme',theme),theme);
 await page.route('**/setup/status',route=>route.fulfill({json:{configured:true,installation:{authMode:'local'},settings:{organizationName:'Synthetic Release Team',primaryColor:'#1b4965',secondaryColor:'#f4a261',appearance:theme}}}));
 await page.route('**/auth/session',route=>route.fulfill({json:{user:{role:'admin'}}}));await page.route('**/admin/setup/progress',route=>route.fulfill({json:{completedSteps:['branding','roster','pair-kiosk','fingerprint-test','confirm-attendance'].map(step=>({step}))}}));
 let enabled=false;const snapshot=()=>({revision:0,capabilities:[],modules:[{id:'hour-tracking',enabled,dependencies:[],capabilities:['hours.manage'],navigation:{label:'Hour Tracking',path:'/hours'}}]});
 await page.route('**/platform/modules',route=>route.fulfill({json:snapshot()}));await page.route('**/admin/modules',async route=>{expect(route.request().postDataJSON().enabled).toEqual(['hour-tracking']);enabled=true;await route.fulfill({json:snapshot()})});
 await page.goto('/settings/configuration');const region=page.getByRole('region',{name:'Modules',exact:true}),hours=region.getByLabel('Hour Tracking',{exact:true});await expect(hours).toBeVisible();await expect(region.getByText('Activity Documentation',{exact:true})).toHaveCount(0);
 await hours.focus();await page.keyboard.press('Space');await expect(hours).toBeChecked();await region.getByRole('button',{name:'Save modules',exact:true}).click();await expect(region.getByText('Module configuration saved. Current server settings are shown.')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`initial-profile-${theme}.png`),fullPage:true});
 await page.goto('/submit-documentation');await expect(page.getByRole('heading',{name:'Page unavailable'})).toBeVisible();await expect(page.getByRole('link',{name:'Submit hours'})).toBeVisible();await expect(page.locator('form')).toHaveCount(0);
});
