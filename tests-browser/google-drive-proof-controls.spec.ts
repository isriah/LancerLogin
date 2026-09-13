import {test,expect,type Page} from '@playwright/test';
import {dashboardConformanceReferences as reference} from '../apps/dashboard/src/design-conformance';
const scope='https://www.googleapis.com/auth/drive.file';
const area=(page:Page)=>page.getByRole('region',{name:'Staged synthetic Drive proof'});
async function setup(page:Page,theme='light'){
 await page.addInitScript(value=>localStorage.setItem('lancerlogin-theme',value),theme);
 await page.route('**/setup/status',route=>route.fulfill({json:{configured:true,installation:{authMode:'local'},settings:{organizationName:'Synthetic Picker Team',primaryColor:reference.brand.primary,secondaryColor:reference.brand.secondary,appearance:theme}}}));
 await page.route('**/admin/connections/google/storage',route=>route.fulfill({json:{configured:false,revision:0,rootId:null,rootName:null,verifiedAt:null,verifiedForConnection:false}}));
 await page.route('**/admin/integrations',route=>route.fulfill({json:{integrations:[]}}));
 await page.route('**/admin/integrations/discord/channel-manager',route=>route.fulfill({json:{enabled:false,contestWindowHours:24}}));
 await page.route('**/admin/integrations/discord/anomaly-reports',route=>route.fulfill({json:{enabled:false,channelId:''}}));
 await page.route('**/admin/connections/google',route=>route.fulfill({json:{revision:1,mode:'shared',active:{generation:'synthetic',loginEnabled:false,loginVerified:false,calendarEnabled:false,driveEnabled:true,organizationAuthorized:true,grantedScopes:[scope],calendarReady:false,driveReady:true,calendarSelected:false},candidate:null,callbackUri:'https://fixture.test/api/admin/connections/google/callback',loginCallbackUri:'https://fixture.test/api/auth/google/callback'}}));
}
const savedKey='lancerlogin-drive-proof-run-ids';
const runId='00000000-0000-4000-8000-000000000139';
const summary=(id=runId)=>({id,revision:0,status:'ready',stage:'folders',pending:false,offset:0,published:false,verified:false,publicUrl:null});
async function source(page:Page,selected=true){await page.route('**/admin/connections/google/drive/status',route=>route.fulfill({json:{revision:1,configRevision:1,configured:true,rootName:'Synthetic private root',intent:selected?{id:'synthetic-source',purpose:'source',status:'selected'}:null}}));}
const confirm=(page:Page)=>area(page).getByRole('checkbox');

test('staged proof persists identity before create and requires separate explicit publication and replacement',async({page})=>{
 await setup(page);await source(page);let run:any,posts:any[]=[];
 await page.route('**/admin/connections/google/drive/feasibility-runs**',async route=>{
  const request=route.request();if(request.method()==='POST'){
   const body=request.postDataJSON();posts.push(body);
   if(body.runId){expect(JSON.parse(await page.evaluate(key=>localStorage.getItem(key)!,savedKey))).toContain(body.runId);expect(body).toEqual({revision:1,runId:body.runId,sourceIntentId:'synthetic-source',confirmation:'RUN SYNTHETIC DRIVE PROOF'});run=summary(body.runId);}
   else{expect(body).toEqual({revision:1,runRevision:run.revision,confirmation:'CONTINUE SYNTHETIC DRIVE PROOF'});const stages=['folders','copy','private-upload','public-upload','publish','replace','verify','complete'];run={...run,revision:run.revision+2,stage:stages[stages.indexOf(run.stage)+1]};if(['replace','verify','complete'].includes(run.stage)){run.published=true;run.publicUrl='https://drive.google.com/file/d/synthetic-public/view';}if(run.stage==='complete'){run.verified=true;run.status='verified';}}
  }await route.fulfill({json:run});
 });
 await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();const view=area(page),create=view.getByRole('button',{name:'Create synthetic proof run'});await expect(create).toBeDisabled();await confirm(page).check();await create.click();await expect(view).toContainText('Stage: folders');expect(posts).toHaveLength(1);await expect(view.getByRole('status')).toBeFocused();
 for(const name of ['Create private test folders','Copy the selected synthetic source','Upload the private synthetic PDF','Upload the public PDF candidate privately','Publish the synthetic PDF','Replace the published synthetic PDF','Verify private and published versions']){
  const button=view.getByRole('button',{name,exact:true});await expect(button).toBeDisabled();if(name==='Publish the synthetic PDF')await expect(view).toContainText('Grant anyone with the link reader access');if(name==='Replace the published synthetic PDF')await expect(view).toContainText('same file ID and link');await confirm(page).check();await button.click();await expect(confirm(page)).not.toBeChecked();
 }
 await expect(view).toContainText('Provider checks complete');expect(posts).toHaveLength(8);await expect(view.getByRole('link',{name:'Open synthetic published PDF'})).toHaveAttribute('href','https://drive.google.com/file/d/synthetic-public/view');expect(await page.evaluate(key=>localStorage.getItem(key),savedKey)).toBe(JSON.stringify([run.id]));
});

test('lost responses retain UUID and require readback; expired source does not prevent resume',async({page})=>{
 await setup(page);await source(page);let run:any,creates=0,resumes=0,reads=0;
 await page.route('**/admin/connections/google/drive/feasibility-runs**',async route=>{
  if(route.request().method()==='GET'){reads++;return route.fulfill({json:run});}
  const body=route.request().postDataJSON();if(body.runId){creates++;run=summary(body.runId);}else{resumes++;run={...run,revision:run.revision+1,status:'pending',pending:true};}return route.abort();
 });
 await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await confirm(page).check();await area(page).getByRole('button',{name:'Create synthetic proof run'}).click();await expect(area(page)).toContainText('outcome could not be confirmed');await expect(area(page).getByRole('button',{name:'Create synthetic proof run'})).toHaveCount(0);
 await source(page,false);await page.reload();await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await expect(area(page)).toContainText('Saved identity retained');expect(creates).toBe(1);expect(reads).toBe(0);await area(page).getByRole('button',{name:'Read proof status'}).click();await confirm(page).check();await area(page).getByRole('button',{name:'Create private test folders',exact:true}).click();await expect(area(page)).toContainText('outcome could not be confirmed');expect(resumes).toBe(1);await area(page).getByRole('button',{name:'Read proof status'}).click();await expect(area(page).getByRole('button',{name:'Reconcile pending proof step'})).toBeDisabled();expect(creates).toBe(1);expect(resumes).toBe(1);
});

test('malformed summaries and unavailable ID storage cannot authorize a mutation',async({page})=>{
 await setup(page);await source(page);await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify(['00000000-0000-4000-8000-000000000139'])),savedKey);let posts=0;
 await page.route('**/admin/connections/google/drive/feasibility-runs**',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({json:{...summary(),stage:'replace',published:true,publicUrl:'https://untrusted.invalid/synthetic-private'}});});
 await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await area(page).getByRole('button',{name:'Read proof status'}).click();await expect(area(page)).toContainText('outcome could not be confirmed');await expect(area(page).getByRole('link')).toHaveCount(0);await expect(area(page).getByRole('button',{name:'Replace the published synthetic PDF'})).toHaveCount(0);expect(posts).toBe(0);

});

for(const theme of ['light','dark'])for(const width of [1280,390])test(`proof publish review geometry ${theme} ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});await page.emulateMedia({reducedMotion:'reduce'});await setup(page,theme);await source(page,false);await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify(['00000000-0000-4000-8000-000000000139'])),savedKey);
 await page.route('**/admin/connections/google/drive/feasibility-runs/**',route=>route.fulfill({json:{...summary(),stage:'publish'}}));await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();const view=area(page);await view.getByRole('button',{name:'Read proof status'}).click();await expect(view.getByRole('status')).toBeFocused();await expect(view).toContainText('Grant anyone with the link reader access');await confirm(page).focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');await expect(view.getByRole('button',{name:'Publish the synthetic PDF',exact:true})).toBeFocused();for(const button of await view.getByRole('button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.locator('.skip-link').evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThan(0);await page.screenshot({path:`.provision/drive-proof-viewport-${theme}-${width}.png`});await view.screenshot({path:`.provision/drive-proof-${theme}-${width}.png`});expect(await page.locator('.skip-link').evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThan(0);
});

test('blocked identity storage prevents all proof writes',async({page})=>{
 await setup(page);await source(page);let posts=0;await page.addInitScript(key=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw Error('synthetic blocked storage');return original.call(this,k,v);};},savedKey);
 await page.route('**/admin/connections/google/drive/feasibility-runs**',route=>{posts++;return route.fulfill({json:summary()});});await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await confirm(page).check();await area(page).getByRole('button',{name:'Create synthetic proof run'}).click();await expect(area(page)).toContainText('outcome could not be confirmed');expect(posts).toBe(0);await expect(confirm(page)).toBeDisabled();
});

test('duplicate clicks dispatch once; changed connection requires readback; reload releases local busy state',async({page})=>{
 await setup(page);let revision=1,posts=0,run:any,release:()=>void=()=>{};
 await page.route('**/admin/connections/google/drive/status',route=>route.fulfill({json:{revision,configRevision:1,configured:true,rootName:'Synthetic private root',intent:{id:'synthetic-source',purpose:'source',status:'selected'}}}));
 await page.route('**/admin/connections/google/drive/feasibility-runs**',async route=>{if(route.request().method()==='POST'){posts++;if(route.request().postDataJSON().runId)run=summary(route.request().postDataJSON().runId);await new Promise<void>(resolve=>{release=resolve;});}await route.fulfill({json:run}).catch(()=>{});});
 await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await confirm(page).check();await area(page).getByRole('button',{name:'Create synthetic proof run'}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});await expect.poll(()=>posts).toBe(1);release();await expect(area(page)).toContainText('Stage: folders');
 revision=2;await page.getByRole('button',{name:'Reload Drive selection',exact:true}).click();await expect(area(page)).toContainText('Read proof status to obtain the current run revision');await expect(area(page).getByRole('button',{name:'Create private test folders',exact:true})).toHaveCount(0);
 await page.reload();await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();await expect(area(page).getByRole('button',{name:'Read proof status'})).toBeEnabled();await area(page).getByRole('button',{name:'Read proof status'}).click();await expect(area(page)).toContainText('Stage: folders');expect(posts).toBe(1);await confirm(page).check();await area(page).getByRole('button',{name:'Create private test folders',exact:true}).click();await expect.poll(()=>posts).toBe(2);await page.reload();await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();release();await expect(area(page).getByRole('button',{name:'Read proof status'})).toBeEnabled();await expect(area(page)).toContainText('Saved identity retained');expect(posts).toBe(2);
});
