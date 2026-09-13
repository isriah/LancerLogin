import {test,expect,type Page} from '@playwright/test';
import {dashboardConformanceReferences as reference} from '../apps/dashboard/src/design-conformance';
const scope='https://www.googleapis.com/auth/drive.file';
const area=(page:Page)=>page.getByRole('region',{name:'Drive selection feasibility'});
async function setup(page:Page,theme='light'){
 await page.addInitScript(value=>localStorage.setItem('lancerlogin-theme',value),theme);
 await page.route('**/setup/status',route=>route.fulfill({json:{configured:true,installation:{authMode:'local'},settings:{organizationName:'Synthetic Picker Team',primaryColor:reference.brand.primary,secondaryColor:reference.brand.secondary,appearance:theme}}}));
 await page.route('**/admin/connections/google/storage',route=>route.fulfill({json:{configured:false,revision:0,rootId:null,rootName:null,verifiedAt:null,verifiedForConnection:false}}));
 await page.route('**/admin/integrations',route=>route.fulfill({json:{integrations:[]}}));
 await page.route('**/admin/integrations/discord/channel-manager',route=>route.fulfill({json:{enabled:false,contestWindowHours:24}}));
 await page.route('**/admin/integrations/discord/anomaly-reports',route=>route.fulfill({json:{enabled:false,channelId:''}}));
 await page.route('**/admin/connections/google',route=>route.fulfill({json:{revision:1,mode:'shared',active:{generation:'synthetic',loginEnabled:false,loginVerified:false,calendarEnabled:false,driveEnabled:true,organizationAuthorized:true,grantedScopes:[scope],calendarReady:false,driveReady:true,calendarSelected:false},candidate:null,callbackUri:'https://fixture.test/api/admin/connections/google/callback',loginCallbackUri:'https://fixture.test/api/auth/google/callback'}}));
}
test('Picker configuration read-back, isolated claim and server-verified selection',async({page})=>{
 await setup(page);let state:any={revision:1,configRevision:0,configured:false,rootName:null,intent:null};let claims=0;const selections:any[]=[];
 await page.route('**/admin/connections/google/drive/status',route=>route.fulfill({json:state}));
 await page.route('**/admin/connections/google/drive/configuration',async route=>{expect(route.request().postDataJSON().projectNumber).toBe('123456');state={...state,configRevision:1,configured:true,intent:{id:'synthetic-intent',purpose:'root',status:'ready'}};await route.fulfill({json:{saved:true}});});
 await page.route('**/admin/connections/google/drive/picker/claim',async route=>{claims++;state={...state,intent:{...state.intent,status:'claimed'}};await route.fulfill({json:{intentId:'synthetic-intent',purpose:'root',scope,accessToken:'synthetic-drive-only-token',expiresAt:Date.now()+60000,projectNumber:'123456',browserKey:'synthetic_browser_key_0000'}});});
 await page.route('**/admin/connections/google/drive/selection',async route=>{selections.push(route.request().postDataJSON());state={...state,rootName:'Synthetic private root',intent:{...state.intent,status:'selected'}};await route.fulfill({json:{selected:true}});});
 await page.addInitScript(()=>{
  class View{setMode(){return this;}setIncludeFolders(){return this;}setSelectFolderEnabled(){return this;}setMimeTypes(){return this;}}
  class Builder{callback:any;setOAuthToken(value:string){if(value!=='synthetic-drive-only-token')throw Error('wrong token');return this;}addView(){return this;}setDeveloperKey(){return this;}setAppId(){return this;}setOrigin(){return this;}setCallback(value:any){this.callback=value;return this;}build(){const callback=this.callback;return {dispose(){},setVisible(show:boolean){if(show)setTimeout(()=>callback({action:'picked',docs:[{id:'synthetic-root'}]}),0);}};}}
  (window as any).gapi={load(_name:string,options:any){options.callback();}};(window as any).google={picker:{DocsView:View,DocsViewMode:{LIST:'list'},PickerBuilder:Builder,Action:{PICKED:'picked',CANCEL:'cancel'}}};
 });
 await page.goto('/settings/integrations');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();const view=area(page);await expect(view.getByLabel('Google Cloud project number')).toBeEnabled();await view.getByLabel('Google Cloud project number').fill('123456');await view.getByLabel('Restricted Picker browser key').fill('synthetic_browser_key_0000');await view.getByRole('button',{name:'Save Picker configuration'}).click();await expect(view.getByLabel('Restricted Picker browser key')).toHaveValue('');await expect(view.getByRole('status')).toBeFocused();await view.getByRole('button',{name:'Open Google Picker'}).click();await expect(view).toContainText('Synthetic private root');expect(claims).toBe(1);expect(selections).toEqual([{revision:1,intentId:'synthetic-intent',fileId:'synthetic-root'}]);await expect(view.getByRole('status')).toBeFocused();expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('synthetic-drive-only-token');
});
for(const theme of ['light','dark'])for(const width of [1280,390])test(`Picker failure/reload and geometry ${theme} ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:900});await setup(page,theme);await page.emulateMedia({reducedMotion:'reduce'});let malformed=false;
 await page.route('**/admin/connections/google/drive/status',route=>route.fulfill({json:malformed?{configured:true}:{revision:1,configRevision:1,configured:true,rootName:'Synthetic private root',intent:{id:'synthetic-intent',purpose:'root',status:'exchanging',diagnostic:{stage:'token_validation',reason:'scope_mismatch'}}}}));
 await page.goto('/settings/integrations?drivePicker=failed');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();const view=area(page);await expect(view).toContainText('Google did not return access limited to selected Drive files.');await expect(view.getByRole('status')).toBeFocused();await expect(view.getByRole('button',{name:'Open Google Picker'})).toHaveCount(0);await view.scrollIntoViewIfNeeded();await expect(view.getByRole('button',{name:'Authorize private folder selection'})).toBeEnabled();
 await view.getByRole('button',{name:'Reload Drive selection'}).focus();await page.keyboard.press('Tab');await expect(view.getByLabel('Google Cloud project number')).toBeFocused();
 for(const button of await view.getByRole('button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);const box=await view.boundingBox();expect(box!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await view.screenshot({path:`.provision/picker-${theme}-${width}.png`});
 malformed=true;await view.getByRole('button',{name:'Reload Drive selection'}).click();await expect(view.getByRole('button',{name:'Authorize private folder selection'})).toBeDisabled();await expect(view.getByRole('status')).toBeFocused();
});

test('Picker diagnostic pairs render fixed guidance; malformed or stale diagnostics are omitted',async({page})=>{
 await setup(page);let diagnostic:unknown={stage:'identity_validation',reason:'subject_mismatch'},intentStatus='exchanging',writes=0;
 await page.route('**/admin/connections/google/drive/**',route=>{if(route.request().method()!=='GET')writes++;return route.fulfill({json:{revision:1,configRevision:1,configured:true,rootName:null,intent:{id:'synthetic-intent',purpose:'root',status:intentStatus,diagnostic}}});});
 await page.goto('/settings/integrations?drivePicker=failed');await page.getByRole('button',{name:'Development feasibility controls',exact:true}).click();const view=area(page);
 await expect(view.getByRole('status')).toContainText('Google token information could not confirm the organizational account.');
 for(const [stage,reason,text] of [
  ['admission','code_missing','Google returned without an authorization code.'],
  ['code_exchange','provider_unconfirmed','Google did not confirm the authorization-code exchange.'],
  ['token_information','provider_unconfirmed','Google did not confirm the selection-token information.'],
  ['identity_validation','scope_mismatch','Google token information did not confirm access limited to selected Drive files.'],
  ['identity_validation','expiry_shape','Google token information did not confirm a valid access lifetime.'],
  ['drive_identity','account_mismatch','The selected Drive account did not match the organizational connection.'],
  ['drive_identity','identity_invalid','Google did not return a usable Drive account identity.'],
  ['drive_identity','provider_unconfirmed','Google did not confirm Drive account ownership.'],
  ['drive_identity','connection_changed','The shared Google connection changed while Drive ownership was checked.'],
  ['persistence','write_unconfirmed','Selection authorization could not be saved'],
 ]){diagnostic={stage,reason};await view.getByRole('button',{name:'Reload Drive selection'}).click();await expect(view.getByRole('status')).toContainText(text);await expect(view.getByRole('status')).toBeFocused();}
 for(const bad of [null,[],{stage:'token_validation',reason:'subject_mismatch'},{stage:'__proto__',reason:'toString'},{stage:'identity_validation',reason:'synthetic-private-response'},{stage:'identity_validation',reason:'scope_mismatch',detail:'synthetic-private-response'},{stage:12,reason:'scope_mismatch'}]){
  diagnostic=bad;await view.getByRole('button',{name:'Reload Drive selection'}).click();await expect(view.getByRole('status')).toHaveText('Current Drive selection status loaded. A claimed Picker session cannot be recovered after reload; authorize another selection if needed.');await expect(view).not.toContainText('synthetic-private-response');
 }
 diagnostic={stage:'token_validation',reason:'scope_mismatch'};intentStatus='pending';await view.getByRole('button',{name:'Reload Drive selection'}).click();await expect(view).not.toContainText('Picker access was blocked');expect(writes).toBe(0);
});
