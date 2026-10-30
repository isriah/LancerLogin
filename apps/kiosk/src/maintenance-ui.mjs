import { clockSetupHtml, clockSetupStyles, clockSetupApp } from "./clock-setup.mjs";
export const maintenanceHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#424a53"><title>LancerLogin maintenance</title><link rel="stylesheet" href="/maintenance.css"></head><body><main id="maintenance-main" class="locked"><header id="maintenance-header" hidden><div><p id="brand-subtitle">Local tools</p><h1 id="brand-title">Authentication maintenance</h1></div><a href="/">Return to kiosk</a></header><p id="message" role="status">Checking local access…</p><a id="locked-return" href="/">Return to kiosk</a><section id="unlock" class="card unlock-card" hidden><h2>Unlock maintenance</h2><p>Use the same local PIN that protects network settings.</p><form id="unlock-form"><label>Local settings PIN<input id="pin" class="pin-target" inputmode="none" pattern="[0-9]{6,12}" maxlength="12" required readonly></label><div id="pin-keypad" class="pin-keypad" aria-label="PIN keypad"></div><button class="primary" type="submit">Unlock for five minutes</button></form></section>${clockSetupHtml}<div id="workspace" class="workspace" hidden><section class="card reader-card" data-fingerprint><div class="card-heading"><div><h2>Fingerprint reader</h2><p>Templates stay inside the R503.</p></div><button id="test-reader" type="button">Test</button></div><p id="reader-status">Reader status has not been tested.</p><article id="enroll-stage" class="enroll-stage stage-ready" aria-live="polite"><strong id="stage-title">Ready to enroll</strong><span id="stage-detail">Choose a member and slot.</span></article></section><section class="card enroll-card" data-fingerprint><h2>Enroll fingerprint</h2><form id="enroll-form"><label>Roster member<input id="member" type="hidden" required><button id="member-picker" class="picker-button" type="button">Choose a member</button></label><div class="form-row"><label>Slot<input id="slot" class="numeric-target" inputmode="none" pattern="[0-9]{1,3}" maxlength="3" required readonly></label></div><p id="slot-help"></p><label class="check"><input id="replace" type="checkbox"><span>Replace occupied slot</span></label><button class="primary" id="begin-enroll" type="submit">Begin two-scan enrollment</button></form></section><section class="card mappings-card" data-fingerprint><div class="card-heading"><div><h2>Fingerprint mappings</h2><p>Removal keeps sensor templates.</p></div><button id="refresh" type="button">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Slot</th><th>Member</th><th></th></tr></thead><tbody id="mappings"></tbody></table></div></section><section id="credential-enroll-card" class="card credential-card" hidden><h2 id="credential-enroll-title">Register credential</h2><p>Credential values are transformed with a kiosk-local secret and are never sent to the dashboard.</p><form id="credential-form"><label>Roster member<input id="credential-member" type="hidden" required><button id="credential-member-picker" class="picker-button" type="button">Choose a member</button></label><label>Credential label<input id="credential-label" maxlength="60" placeholder="Optional badge or code label"></label><label>Scan or enter credential<input id="credential-value" type="password" inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" required></label><button class="primary" type="submit">Register credential</button></form></section><section id="credential-mappings-card" class="card mappings-card" hidden><div class="card-heading"><div><h2>Credential mappings</h2><p>Raw credentials are never displayed.</p></div><button id="credential-refresh" type="button">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Member</th><th></th></tr></thead><tbody id="credential-mappings"></tbody></table></div></section><section id="member-id-card" class="card member-id-card" hidden><h2>Member ID entry</h2><p>Active roster member IDs are accepted directly on the kiosk. No credential enrollment is needed.</p></section></div><section id="member-sheet" class="sheet" hidden aria-labelledby="member-sheet-title"><div class="sheet-panel"><div class="card-heading member-heading"><h2 id="member-sheet-title">Choose member</h2><input id="member-search" type="search" placeholder="Search roster" aria-label="Search roster" inputmode="none" autocomplete="off" maxlength="100"><button id="toggle-search-keyboard" type="button" aria-controls="search-keyboard" aria-expanded="true">Hide keyboard</button><button id="close-member-sheet" type="button">Close</button></div><div class="member-content"><div id="member-options" class="option-list"></div><div id="search-keyboard" class="search-keyboard" aria-label="Roster search keyboard"></div></div></div></section><section id="number-pad" class="sheet number-sheet" hidden aria-labelledby="number-pad-title"><div class="sheet-panel small"><div class="card-heading"><h2 id="number-pad-title">Enter slot</h2><button id="close-number-pad" type="button">Close</button></div><input id="number-display" class="pin-target" inputmode="none" readonly><p id="number-error" role="status"></p><div id="slot-keypad" class="pin-keypad" aria-label="Slot keypad"></div><button id="apply-number" class="primary" type="button">Use slot</button></div></section><section id="confirm-sheet" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div class="sheet-panel confirmation-panel"><h2 id="confirm-title">Confirm action</h2><p id="confirm-detail"></p><div class="confirmation-actions"><button id="cancel-action" type="button">Cancel</button><button id="accept-action" class="primary" type="button">Confirm</button></div></div></section></main><script type="module" src="/maintenance.js"></script></body></html>`;

export const maintenanceStyles = `:root{--primary:#b80100;--secondary:#f2c14e;--surface-bg:#424a53;--surface:#1a1d24;--text:#fff;--muted:#d3d8df;--line:#ffffff24;--success:#178f4f;--danger:#ff5b57;--notice:#f2c14e;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--surface-bg);color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--surface-bg)}[hidden]{display:none!important}button,input,select{font:inherit}main{width:100%;height:100vh;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:8px;padding:12px}main.locked{grid-template-rows:auto auto;place-content:center;padding:16px}main.locked>#message{justify-self:center;text-align:center}header,.card-heading{display:flex;align-items:start;justify-content:space-between;gap:10px}header{align-items:center}header p,header h1,.card h2,.card p{margin:0}h1{font-size:30px;line-height:1.05}h2{font-size:22px;line-height:1.1}header p,.card p,#message{color:var(--muted)}header a{min-height:42px;display:inline-grid;place-items:center;padding:0 12px;border:1px solid #ffffff33;border-radius:8px;color:#fff;text-decoration:none;font-weight:800}.card{min-height:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.workspace{min-height:0;display:grid;grid-template-columns:.95fr 1.15fr 1.25fr;gap:10px}.card form{display:grid;gap:8px}.card label{display:grid;gap:4px;font-size:16px;font-weight:800}.card input,.card select,.picker-button{min-height:40px;padding:6px 9px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff;font-size:16px}.card button{min-height:40px;padding:6px 10px;border:1px solid #ffffff33;border-radius:7px;background:#292e39;color:#fff;font-size:16px;font-weight:800}.card button.primary,.card form>button.primary,.sheet button.primary{border-color:var(--primary);background:var(--primary);color:#fff}.picker-button{text-align:left;font-weight:800}.numeric-target{caret-color:transparent}.numeric-target::-webkit-inner-spin-button,.numeric-target::-webkit-outer-spin-button{appearance:none;margin:0}.form-row{display:grid;grid-template-columns:1fr 72px;gap:8px}.check{grid-template-columns:auto 1fr!important;align-items:center}.check input{width:20px;min-height:20px}#message{min-height:22px;font-size:16px}.error{color:#ffb3bd!important}.table-wrap{height:100%;min-height:0;overflow:auto}table{width:100%;border-collapse:collapse;font-size:16px}th,td{padding:6px;text-align:left;border-bottom:1px solid #ffffff1f}td button{min-height:32px!important;padding:4px 7px!important}.reader-card{display:grid;grid-template-rows:auto auto 1fr;gap:10px}.enroll-stage{align-self:stretch;display:grid;place-items:center;text-align:center;gap:8px;padding:14px;border-radius:8px;background:#2a3039;border:2px solid #3d4652}.enroll-stage strong{font-size:32px;line-height:1}.enroll-stage span{font-size:19px;color:var(--muted)}.stage-enroll_wait_first,.stage-enroll_wait_second{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 18%,#2a3039)}.stage-enroll_scan_accepted,.stage-enroll_success{border-color:var(--success);background:color-mix(in srgb,var(--success) 24%,#2a3039)}.stage-enroll_failure{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 20%,#2a3039)}.unlock-card{width:min(430px,100%);justify-self:center;align-self:center}.pin-target{font-size:26px;letter-spacing:.28em;text-align:center}.pin-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.pin-keypad button{min-height:44px;font-size:22px}.pin-keypad .wide{grid-column:span 2}.sheet{position:fixed;z-index:20;inset:0;display:grid;place-items:end center;padding:10px;background:rgb(0 0 0 / 62%)}.sheet-panel{width:min(760px,100%);max-height:min(430px,92vh);display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 18px 60px rgb(0 0 0 / 45%)}.sheet-panel.small{width:min(330px,100%);grid-template-rows:auto auto auto auto}.sheet input{min-height:44px;padding:8px 10px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff;font-size:16px}.option-list{min-height:0;overflow:auto;display:grid;gap:6px;padding-right:2px;-webkit-overflow-scrolling:touch}.option-list button{min-height:56px;padding:8px 10px;border:1px solid #ffffff24;border-radius:7px;background:#292e39;color:#fff;text-align:left;font-size:16px;font-weight:800}.option-list button.selected{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 22%,#292e39)}@media(max-height:520px){main{padding:8px;gap:6px}main.locked{padding:8px}h1{font-size:26px}h2{font-size:20px}.card{padding:9px}.workspace{gap:8px}.enroll-stage strong{font-size:27px}.enroll-stage span{font-size:17px}.card input,.card select,.card button,.picker-button{min-height:34px}.card form{gap:5px}#message{font-size:15px}.table-wrap{max-height:294px}.sheet-panel{max-height:450px;padding:10px}.option-list button{min-height:50px}.pin-keypad button{min-height:40px}}
main.locked{grid-template-rows:auto auto minmax(0,1fr);place-content:stretch;justify-items:center}
#locked-return{color:var(--text);min-height:44px;padding:10px}
.unlock-card{max-height:100%;overflow:auto;align-self:center}
main:not(.locked)>#locked-return{display:none}
.workspace{grid-template-columns:minmax(0,.95fr) minmax(0,1.15fr) minmax(0,1.25fr)}
.workspace.auth-credentials{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)}
.workspace.auth-member-id{grid-template-columns:minmax(0,620px);justify-content:center}
.credential-card{display:grid;align-content:start;gap:10px}
.credential-card>p,.member-id-card p{font-size:16px}
.card{min-width:0;overflow:auto}
.card,.table-wrap,.option-list,.sheet-panel{touch-action:pan-x pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.card button,.card input,.card select,.picker-button,header a,td button{min-height:44px!important}
.card-heading{flex-shrink:0}
.table-wrap{touch-action:pan-x pan-y;user-select:none;-webkit-user-select:none;min-height:0;overflow:auto}.table-wrap button{touch-action:pan-x pan-y}
.mappings-card{display:flex;flex-direction:column;gap:8px}
.table-wrap{height:auto;flex:1;max-height:none;min-height:80px}
.reader-card{grid-template-rows:auto auto minmax(160px,1fr)}
.enroll-stage{min-height:160px;overflow-wrap:anywhere}
.sheet-panel{max-height:calc(100dvh - 20px);overflow:auto;min-height:0}
.sheet-panel.small{grid-template-rows:auto auto auto auto auto}
.number-sheet .sheet-panel.small{overflow:auto;max-height:calc(100dvh - 16px)}
.sheet button{min-height:44px;padding:6px;border:1px solid var(--line);border-radius:7px;background:#292e39;color:var(--text);font:inherit;font-weight:800}
.form-row{grid-template-columns:minmax(0,1fr) 72px}
.form-row>*{min-width:0}
.form-row input,.form-row select{width:100%;min-width:0}
.pin-keypad button{width:100%;min-width:0;min-height:44px}
.member-heading{display:grid;grid-template-columns:110px minmax(0,1fr) auto auto;align-items:center}
.member-heading h2{font-size:18px;margin:0}
.member-heading input{width:100%;min-width:0}
.member-content{display:grid;grid-template-columns:minmax(0,1fr) 476px;gap:10px;min-height:0}
.member-content:has(.search-keyboard[hidden]){grid-template-columns:minmax(0,1fr)}
#member-options{touch-action:pan-y;padding-right:22px;user-select:none;-webkit-user-select:none}
#member-options button{touch-action:pan-y}
.member-content .option-list{align-content:start;grid-auto-rows:max-content}
.option-list button{height:auto;min-height:56px;overflow-wrap:anywhere}
.search-keyboard{display:grid;gap:4px;align-content:start}
.search-keyboard-row{display:flex;justify-content:center;gap:4px}
.search-keyboard-row button{width:44px;height:44px;flex:0 0 44px}
.search-keyboard-row .wide{width:auto;flex:1 1 0}
.search-keyboard button{min-width:0;min-height:44px;padding:4px}
#member-sheet .sheet-panel{height:min(460px,calc(100dvh - 20px));grid-template-rows:auto minmax(0,1fr);overflow:hidden}
#number-error{margin:0;color:#ffb3bd;min-height:0}
.finger-panel{height:min(460px,calc(100dvh - 20px));grid-template-rows:auto minmax(0,1fr);width:min(500px,100%);overflow:hidden}
.confirmation-panel{grid-template-rows:auto minmax(0,1fr) auto;width:min(500px,100%)}
.confirmation-panel p{overflow:auto;touch-action:pan-y}
.confirmation-actions{display:flex;gap:10px;justify-content:end}
header{flex-wrap:wrap}header>div{flex:1 1 220px}
header button{min-height:44px;padding:8px 12px;border:1px solid var(--danger);border-radius:8px;background:var(--surface);color:var(--text);font-weight:800}
.sheet button.danger{background:var(--danger);border-color:var(--danger);color:#15171b}
#confirm-ack{display:flex;gap:10px;align-items:center;min-height:44px;font-size:16px}
#confirm-ack input{width:22px;height:22px;min-height:22px;flex:0 0 22px;accent-color:var(--primary)}
.confirmation-panel:has(#confirm-ack:not([hidden])){grid-template-rows:auto minmax(0,1fr) auto auto}
button:disabled{opacity:.5}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--secondary);outline-offset:-3px}
@media(max-height:400px){#member-sheet .sheet-panel{gap:6px;padding:8px}
.pin-keypad{gap:4px}
.number-sheet .sheet-panel.small{width:min(480px,calc(100vw - 16px));gap:4px}
.number-sheet .pin-keypad{grid-template-columns:repeat(6,minmax(0,1fr))}
.unlock-card{width:min(650px,100%)}
.unlock-card .pin-keypad{grid-template-columns:repeat(6,minmax(0,1fr))}
}


#member-sheet{padding:8px;place-items:center}
#member-sheet .sheet-panel{width:100%;height:100%;max-height:100%;padding:10px;gap:8px}
.member-heading{grid-template-columns:minmax(0,1fr) auto auto;gap:8px}
.member-heading h2{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.member-heading input{min-height:48px;font-size:22px}
.member-heading button{min-height:48px}
.member-content{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(56px,1fr) auto;gap:8px}
.member-content:has(.search-keyboard[hidden]){grid-template-rows:minmax(0,1fr)}
.search-keyboard{gap:5px}
.search-keyboard-row{gap:5px}
.search-keyboard-row button{flex:1 1 0;width:auto;height:50px;min-height:50px;font-size:23px}
.search-keyboard-row:nth-child(3){padding-inline:4%}
.search-keyboard-row .wide{flex:1.5 1 0;font-size:18px}
.search-keyboard-row .space{flex:5 1 0}
.search-keyboard button[aria-pressed="true"]{border-color:var(--secondary);background:#485062}
#member-options{padding-right:12px}
#member-options button{min-height:56px;font-size:19px}
#confirm-sheet.enrollment-confirmation{place-items:center;padding:16px}
.enrollment-confirmation .confirmation-panel{width:min(720px,100%);min-height:260px;padding:24px;gap:20px}
.enrollment-confirmation h2{font-size:32px;margin:0}
.enrollment-confirmation p{font-size:23px;line-height:1.35;margin:0}
.enrollment-confirmation .confirmation-actions{justify-content:stretch}
.enrollment-confirmation .confirmation-actions button{flex:1;min-height:56px;font-size:22px}
.enroll-card .form-row{grid-template-columns:minmax(0,1fr)}
.enroll-card .picker-button,.enroll-card #begin-enroll{min-height:56px!important;font-size:18px}
.enroll-card .check{min-height:48px}
header #exit-desktop{border-color:var(--line)}
#retry-maintenance{min-height:48px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font-weight:800}
@media(max-height:400px){#member-sheet .sheet-panel{padding:6px;gap:6px}.member-content{gap:6px;grid-template-columns:minmax(0,1fr) minmax(0,2.5fr);grid-template-rows:minmax(0,1fr)}.search-keyboard,.search-keyboard-row{gap:3px}.search-keyboard-row button{height:48px;min-height:48px}.enrollment-confirmation .confirmation-panel{min-height:0;padding:16px;gap:12px}}

` + fingerprintSyncStyles;

export const maintenanceLayoutStyles = `${clockSetupStyles}.form-row{grid-template-columns:minmax(0,1fr)}.form-row>*{min-width:0}.form-row input,.form-row select{width:100%;min-width:0}.pin-keypad button{width:100%;min-width:0}.number-sheet{padding:8px;overflow:hidden}.sheet-panel.small{width:min(310px,calc(100vw - 16px));max-width:100%;overflow:auto}`;

import { fingerprintSyncApp, fingerprintSyncStyles } from "./fingerprint-sync-ui.mjs";
export { fingerprintSyncStyles };

export const dashboardEnrollmentStyles = "\n/* Keep the reader track at its former three-column width. Enrollment and\n   mappings alternate in the remaining space. */\nmain:not(.locked):has(#maintenance-tabs:not([hidden])){grid-template-rows:auto auto auto minmax(0,1fr)}\n#maintenance-tabs{display:flex;gap:8px;justify-content:flex-end;min-height:44px}\n#maintenance-tabs button{min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:800}\n#maintenance-tabs button[aria-selected=true]{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 18%,var(--surface))}\n#maintenance-tabs button:focus-visible{outline:3px solid var(--secondary);outline-offset:2px}\n.workspace:not(.auth-credentials):not(.auth-member-id){--maintenance-gap:10px;grid-template-columns:minmax(0,calc((100% - 2 * var(--maintenance-gap)) * .95 / 3.35)) minmax(0,1fr);gap:var(--maintenance-gap)}\n.workspace>.reader-card{grid-column:1;grid-row:1}\n.workspace>.enroll-card,.workspace>.mappings-card[data-fingerprint],.dashboard-enrollment-card{grid-column:2;grid-row:1}\n.dashboard-enrollment-card{display:grid;align-content:start;gap:20px;font-size:22px}\n.dashboard-enrollment-card h2{font-size:28px}\n#dashboard-enrollment-member{font-size:28px;font-weight:800;overflow-wrap:anywhere}\n.dashboard-enrollment main:not(.locked),main.dashboard-enrollment{grid-template-rows:auto auto minmax(0,1fr)}\n@media(max-height:520px){.workspace:not(.auth-credentials):not(.auth-member-id){--maintenance-gap:8px}}\n";

export const maintenanceApp = `
import { createOperatorPresence } from "/operator-presence.js";
import { startDashboardEnrollment } from "/dashboard-enrollment.js";
const byId = (id) => document.getElementById(id);
${clockSetupApp}
let members = [];
let mappings = {};
let sensorSlots = [];
let slotsVerified = false;
let credentialMappings = [];
let authenticationMethod = "fingerprint";
let stagePolling;
let stagePollRevision = 0;
let selectedMember;
let numberTarget;
let confirmResolve, confirmReturnFocus;
let sessionPolling;
let workspaceRevision = 0;
let readerTest;
let enrolling = false;
let operatorReady = false;
const remoteEnrollmentId = new URLSearchParams(location.search).get("enrollment");
let enrollmentDiscoveryRunning = false;
if (!remoteEnrollmentId) setInterval(async () => {
  if (enrollmentDiscoveryRunning || !operatorReady) return;
  enrollmentDiscoveryRunning = true;
  try {
    const state = await call("/display-state"), id = state.enrollment?.id;
    if (typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      await call("/network/session", { method: "DELETE" }); await operatorPresence.leave();
      location.href = "/maintenance?enrollment=" + encodeURIComponent(id); return;
    }
  } catch { /* Discovery does not change the current local authorization. */ }
  finally { enrollmentDiscoveryRunning = false; }
}, 1000);
const maintenanceTabs = document.createElement("nav"); maintenanceTabs.id = "maintenance-tabs"; maintenanceTabs.hidden = true; maintenanceTabs.setAttribute("role", "tablist"); maintenanceTabs.setAttribute("aria-label", "Fingerprint maintenance");
const enrollmentPanel = document.querySelector(".enroll-card"), mappingPanel = document.querySelector(".mappings-card[data-fingerprint]");
enrollmentPanel.id = "fingerprint-enrollment-panel"; mappingPanel.id = "fingerprint-mappings-panel";
for (const [name, label, panel] of [["enrollment", "Enrollment", enrollmentPanel], ["mappings", "Fingerprint mappings", mappingPanel]]) {
  const button = document.createElement("button"); button.type = "button"; button.id = "maintenance-tab-" + name; button.textContent = label; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", panel.id);
  button.onclick = () => selectMaintenanceTab(name);
  panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", button.id); maintenanceTabs.append(button);
}
byId("workspace").before(maintenanceTabs);
function selectMaintenanceTab(name) {
  byId("workspace").dataset.tab = name;
  enrollmentPanel.hidden = name !== "enrollment"; mappingPanel.hidden = name !== "mappings";
  for (const button of maintenanceTabs.children) { const selected = button.id === "maintenance-tab-" + name; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; }
}
maintenanceTabs.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault(); const name = event.key === "Home" ? "enrollment" : event.key === "End" ? "mappings" : byId("workspace").dataset.tab === "enrollment" ? "mappings" : "enrollment";
  selectMaintenanceTab(name); byId("maintenance-tab-" + name).focus();
});
const presenceRetry = document.createElement("button");
presenceRetry.id = "retry-maintenance"; presenceRetry.type = "button"; presenceRetry.textContent = "Retry maintenance"; presenceRetry.hidden = true;
byId("message").after(presenceRetry);
const operatorPresence = createOperatorPresence({
  onState: state => { operatorReady = state.mode !== "attendance" && state.captureSuspended; presenceRetry.hidden = operatorReady; },
  onError: error => { operatorReady = false; lockWorkspace(); presenceRetry.hidden = false; message("Cannot pause attendance. " + friendlyError(error), true); }
});
presenceRetry.addEventListener("click", async () => {
  try { await operatorPresence.retry(); await start(); }
  catch { /* The presence callback exposes recovery guidance. */ }
});
const unpairButton = document.createElement("button");
unpairButton.id = "unpair-kiosk"; unpairButton.type = "button"; unpairButton.textContent = "Unpair kiosk";
byId("maintenance-header").append(unpairButton);
const exitButton = document.createElement("button");
exitButton.id = "exit-desktop"; exitButton.type = "button"; exitButton.textContent = "Exit to desktop";
byId("maintenance-header").append(exitButton);
exitButton.addEventListener("click", async () => {
  if (enrolling || !operatorReady) return;
  if (!await confirmAction("Exit to desktop?", "Close the kiosk window. Saved scans and background sync will continue.", { label: "Exit to desktop", returnFocus: exitButton })) return;
  exitButton.disabled = true;
  try {
    await operatorPresence.leave();
    await call("/maintenance/desktop/exit", { method: "POST", body: JSON.stringify({}) });
    message("Closing the kiosk window. Background sync remains active.");
  } catch (error) {
    await operatorPresence.enter("maintenance").catch(() => undefined);
    message(friendlyError(error), true);
  } finally { exitButton.disabled = false; }
});
// Short action labels retain readable touch targets on the kiosk display. Rejected scans still upload in the background,
// but they are reviewed from the dashboard's Debug tools, so maintenance no longer links to a review page.
for (const [selector, label, accessibleName] of [["a[href='/']", "Return", "Return to kiosk"]]) {
  const link = byId("maintenance-header").querySelector(selector);
  link.textContent = label; link.setAttribute("aria-label", accessibleName);
}
const confirmAck = document.createElement("label");
confirmAck.id = "confirm-ack"; confirmAck.hidden = true;
const confirmAckInput = document.createElement("input"); confirmAckInput.type = "checkbox";
const confirmAckText = document.createElement("span");
confirmAck.append(confirmAckInput, confirmAckText);
byId("confirm-detail").after(confirmAck);
confirmAckInput.addEventListener("change", () => { byId("accept-action").disabled = !confirmAckInput.checked; });

unpairButton.addEventListener("click", async () => {
  unpairButton.disabled = true;
  try {
    const pairing = await call("/maintenance/pairing");
    if (pairing.busy) throw new Error("Kiosk is busy. Try again after the current operation finishes.");
    if (!pairing.paired && !pairing.recoveryPending) throw new Error("This kiosk is already unpaired.");
    if (pairing.pendingEvents > 0) throw new Error(pairing.pendingEvents + " saved attendance scans are pending. Reconnect and sync them before unpairing.");
    const detail = (pairing.recoveryPending ? "Finish the interrupted installation switch. " : "Disconnect " + (pairing.kioskName || "this kiosk") + (pairing.installation ? " from " + pairing.installation : "") + ". ")
      + "Local attendance history, roster, mappings and fingerprint-sync trust will be archived, not reused. Reader fingerprints, Wi-Fi and your local PIN stay unchanged. The old dashboard entry remains until an Administrator retires it.";
    unpairButton.disabled = false;
    if (!await confirmAction(pairing.recoveryPending ? "Finish unpairing?" : "Unpair this kiosk?", detail, { label: "Unpair kiosk", returnFocus: unpairButton, acknowledgement: "I understand the new installation will need its own mappings and sync trust." })) return;
    unpairButton.disabled = true;
    await call("/maintenance/unpair", { method: "POST", body: JSON.stringify({ confirmation: "UNPAIR" }) });
    clearInterval(sessionPolling); stopStagePolling(); lockWorkspace(); byId("unlock").hidden = true;
    message("Unpaired. Restarting and returning to setup...");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { const health = await fetch("/health", { signal: AbortSignal.timeout(1000) }).then(response => response.json()); if (health.setupReady && !health.paired) { location.href = "/"; return; } } catch { /* The service briefly disconnects during its restart. */ }
    }
    message("Unpaired. Wait for the service to restart, then return to the kiosk setup screen.");
  } catch (error) { message(friendlyError(error), true); }
  finally { unpairButton.disabled = false; }
});

async function call(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { "content-type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403 || /Unlock network settings first/.test(body.error || "")) lockWorkspace();
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function message(value, error = false) {
  byId("message").textContent = value;
  byId("message").className = error ? "error" : "";
}

function friendlyError(error) {
  const text = error instanceof Error ? error.message : String(error || "Request failed");
  return text.replace(/R503 [^:]+: /, "");
}

function applyBranding(value) {
  const brand = value?.branding || {};
  if (/^#[0-9a-f]{6}$/i.test(brand.primaryColor || "")) document.documentElement.style.setProperty("--primary", brand.primaryColor);
  if (/^#[0-9a-f]{6}$/i.test(brand.secondaryColor || "")) document.documentElement.style.setProperty("--secondary", brand.secondaryColor);
  byId("brand-subtitle").textContent = brand.subtitle || "Local tools";
  byId("brand-title").textContent = (brand.organizationName ? brand.organizationName + " " : "") + "authentication";
}

function stage(id, title, detail) {
  const panel = byId("enroll-stage");
  panel.className = "enroll-stage stage-" + id;
  byId("stage-title").textContent = title;
  byId("stage-detail").textContent = detail;
}

function stageFromDisplay(display) {
  const id = display?.id || "ready";
  stage(id, display?.message || "Ready to enroll", display?.detail || "Choose a member and slot.");
}

async function pollStage(revision = stagePollRevision) {
  try {
    const display = (await call("/display-state")).display;
    if (revision === stagePollRevision) stageFromDisplay(display);
  } catch { /* Keep the last visible prompt. */ }
}

function startStagePolling() {
  clearInterval(stagePolling);
  const revision = ++stagePollRevision;
  void pollStage(revision);
  stagePolling = setInterval(() => pollStage(revision), 350);
}

function stopStagePolling() {
  clearInterval(stagePolling);
  stagePolling = undefined;
  stagePollRevision += 1;
}

function mappingValue(value) {
  return typeof value === "string" ? { memberId: value, finger: "unspecified" } : value;
}

function appendPin(digit) {
  const input = byId("pin");
  input.value = (input.value + digit).replace(/\\D/g, "").slice(0, 12);
  input.focus();
}

function buildPinKeypad() {
  const keypad = byId("pin-keypad");
  for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = digit;
    button.addEventListener("click", () => appendPin(digit));
    keypad.append(button);
  }
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "⌫";
  back.className = "wide";
  back.setAttribute("aria-label", "Backspace");
  back.addEventListener("click", () => { byId("pin").value = byId("pin").value.slice(0, -1); byId("pin").focus(); });
  keypad.append(back);
}

async function start() {
  if (!operatorReady) return;
  try { applyBranding(await call("/display-state")); } catch { /* Branding may not be available before pairing. */ }
  if (remoteEnrollmentId && /^[A-Za-z0-9._:-]{1,128}$/.test(remoteEnrollmentId)) {
    await startDashboardEnrollment({ id: remoteEnrollmentId, call, stage, message, confirmAction, cancelConfirmation: () => finishConfirmation(false), isReady: () => operatorReady }); return;
  }
  try {
    const session = await call("/maintenance/session");
    if (!session.configured) {
      byId("unlock").hidden = false;
      message("Create a local settings PIN from the kiosk network panel before opening maintenance.", true);
    } else if (session.authorized) await workspace();
    else {
      byId("unlock").hidden = false;
      message("Enter the local settings PIN.");
    }
  } catch (error) {
    message(error.message, true);
  }
}

function lockWorkspace() {
  byId("clock-setup").hidden = true;
  workspaceRevision += 1;
  stopStagePolling();
  clearInterval(sessionPolling);
  byId("workspace").hidden = true;
  maintenanceTabs.hidden = true;
  byId("maintenance-header").hidden = true;
  for (const sheet of document.querySelectorAll(".sheet")) sheet.hidden = true;
  confirmResolve?.(false);
  confirmResolve = undefined;
  confirmReturnFocus = undefined;
  members = []; mappings = {}; credentialMappings = []; selectedMember = undefined;
  byId("member-options").replaceChildren(); byId("mappings").replaceChildren(); byId("credential-mappings").replaceChildren();
  byId("member").value = ""; byId("credential-member").value = ""; byId("credential-value").value = ""; byId("credential-label").value = ""; byId("member-search").value = ""; byId("pin").value = "";
  byId("maintenance-main").classList.add("locked");
  byId("unlock").hidden = false;
  message("Maintenance locked. Enter the local settings PIN.");
}

async function confirmAction(title, detail, options = {}) {
  if (confirmResolve) return false;
  confirmReturnFocus = options.returnFocus || document.activeElement;
  byId("confirm-sheet").classList.toggle("enrollment-confirmation", Boolean(options.enrollment));
  byId("confirm-title").textContent = title;
  byId("confirm-detail").textContent = detail;
  confirmAck.hidden = !options.acknowledgement; confirmAckInput.checked = false;
  confirmAckText.textContent = options.acknowledgement || "";
  byId("accept-action").textContent = options.label || "Confirm";
  byId("accept-action").className = options.acknowledgement ? "danger" : "primary";
  byId("accept-action").disabled = Boolean(options.acknowledgement);
  byId("confirm-sheet").hidden = false;
  byId("cancel-action").focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function finishConfirmation(accepted) {
  if (accepted && byId("accept-action").disabled) return;
  byId("confirm-sheet").hidden = true;
  if (confirmReturnFocus?.isConnected && confirmReturnFocus.getClientRects().length) confirmReturnFocus.focus();
  confirmReturnFocus = undefined;
  confirmResolve?.(accepted); confirmResolve = undefined;
}
for (const [id, accepted] of [["cancel-action", false], ["accept-action", true]]) {
  byId(id).addEventListener("click", () => finishConfirmation(accepted));
}
byId("confirm-sheet").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishConfirmation(false); }
  if (event.key === "Tab") {
    const controls = [...byId("confirm-sheet").querySelectorAll("button,input")].filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

async function workspace() {
  const revision = ++workspaceRevision;
  byId("credential-value").value = ""; byId("credential-label").value = "";
  byId("unlock").hidden = true;
  byId("maintenance-main").classList.remove("locked");
  byId("maintenance-header").hidden = false;
  clearInterval(sessionPolling);
  sessionPolling = setInterval(async () => {
    try { if (!(await call("/maintenance/session")).authorized) lockWorkspace(); }
    catch { lockWorkspace(); }
  }, 1000);
  const displayState = await call("/display-state");
  if (revision !== workspaceRevision) return;
  if (displayState.clock?.verified === false) { showClockSetup(); return; }
  byId("clock-setup").hidden = true;
  authenticationMethod = displayState.authenticationMethod || "fingerprint";
  const fingerprint = authenticationMethod === "fingerprint";
  const mappedCredential = ["rfid", "nfc", "qr"].includes(authenticationMethod);
  for (const element of document.querySelectorAll("[data-fingerprint]")) element.hidden = !fingerprint;
  byId("credential-enroll-card").hidden = !mappedCredential;
  byId("credential-mappings-card").hidden = !mappedCredential;
  byId("member-id-card").hidden = authenticationMethod !== "member_id";
  byId("workspace").className = "workspace " + (mappedCredential ? "auth-credentials" : authenticationMethod === "member_id" ? "auth-member-id" : "");
  byId("credential-enroll-title").textContent = "Register " + authenticationMethod.toUpperCase() + (authenticationMethod === "qr" ? " code" : " badge");
  byId("workspace").hidden = false;
  maintenanceTabs.hidden = !fingerprint;
  if (fingerprint) selectMaintenanceTab("enrollment");
  clearEnrollmentSelection();
  byId("credential-member").value = "";
  byId("credential-member-picker").textContent = "Choose a member";
  stage("ready", "Ready to enroll", "Choose a member and slot.");
  message("Maintenance unlocked for five minutes.");
  // Test hardware even if the independent roster request is unavailable.
  const hardware = fingerprint ? Promise.resolve(readerTest).then(() => revision === workspaceRevision ? testReader() : undefined) : Promise.resolve();
  const results = await Promise.allSettled([
    call("/maintenance/members"),
    fingerprint ? call("/mappings") : Promise.resolve({ mappings: {} }),
    mappedCredential ? call("/credential-mappings") : Promise.resolve({ mappings: [] })
  ]);
  if (revision !== workspaceRevision) return;
  members = results[0].status === "fulfilled" ? results[0].value.members : [];
  mappings = results[1].status === "fulfilled" ? results[1].value.mappings : {};
  credentialMappings = results[2].status === "fulfilled" ? results[2].value.mappings : [];
  renderMemberOptions(); renderMappings(); renderCredentialMappings();
  await hardware;
  if (revision !== workspaceRevision) return;
  const failure = results.find(result => result.status === "rejected");
  if (failure) message(friendlyError(failure.reason), true);
  if (mappedCredential) byId("credential-value").focus({ preventScroll: true });
}

function clearEnrollmentSelection() {
  selectedMember = undefined;
  byId("member").value = "";
  byId("member-picker").textContent = "Choose a member";
  byId("member-search").value = "";
  byId("replace").checked = false;
  renderMemberOptions();
}

function memberLabel(member) {
  return member.lastName + ", " + member.firstName + " · " + member.memberId;
}

function renderMemberOptions() {
  const list = byId("member-options");
  const query = byId("member-search").value.trim().toLowerCase();
  list.replaceChildren();
  const filtered = members.filter((member) => memberLabel(member).toLowerCase().includes(query));
  for (const member of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = memberLabel(member);
    button.className = selectedMember === member.memberId ? "selected" : "";
    button.addEventListener("click", () => chooseMember(member));
    list.append(button);
  }
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.textContent = "No matching roster members.";
    list.append(empty);
  }
}

function chooseMember(member) {
  selectedMember = member.memberId;
  byId("member").value = member.memberId;
  byId("credential-member").value = member.memberId;
  byId("member-picker").textContent = memberLabel(member);
  byId("credential-member-picker").textContent = memberLabel(member);
  byId("member-sheet").hidden = true;
  renderMemberOptions();
}

function renderCredentialMappings() {
  const body = byId("credential-mappings"); body.replaceChildren();
  const visible = credentialMappings.filter((mapping) => mapping.method === authenticationMethod);
  for (const mapping of visible) {
    const member = members.find((item) => item.memberId === mapping.memberId); const row = document.createElement("tr");
    for (const text of [mapping.label, member ? member.firstName + " " + member.lastName : mapping.memberId]) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); }
    const actions = document.createElement("td"); const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove"; remove.addEventListener("click", () => removeCredentialMapping(mapping)); actions.append(remove); row.append(actions); body.append(row);
  }
  if (!visible.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 3; cell.textContent = "No local credential mappings."; row.append(cell); body.append(row); }
}

async function removeCredentialMapping(mapping) {
  if (!await confirmAction("Remove credential mapping?", "Remove " + mapping.label + " for member " + mapping.memberId + "?")) return;
  try { await call("/credential-mappings/" + encodeURIComponent(mapping.id), { method: "DELETE" }); credentialMappings = (await call("/credential-mappings")).mappings; renderCredentialMappings(); message("Credential mapping removed."); }
  catch (error) { message(friendlyError(error), true); }
}

async function suggestSlot() {
  const revision = workspaceRevision;
  slotsVerified = false;
  byId("begin-enroll").disabled = true;
  byId("slot").value = "";
  byId("slot-help").textContent = "Checking available sensor slots...";
  try {
    const result = await call("/sensor/slots");
    if (revision !== workspaceRevision || byId("workspace").hidden) return;
    if (!Array.isArray(result.occupiedSlots) || result.occupiedSlots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot > 199)) throw new Error("Invalid sensor slot response");
    sensorSlots = result.occupiedSlots;
    const used = new Set([...Object.keys(mappings).map(Number), ...sensorSlots]);
    let slot = 0;
    while (used.has(slot) && slot < 200) slot += 1;
    byId("slot").value = slot < 200 ? String(slot) : "";
    byId("slot-help").textContent = slot < 200 ? "Suggested next open slot: " + slot : "No empty slots. Replacing a fingerprint requires confirmation.";
    slotsVerified = true;
    byId("begin-enroll").disabled = false;
  } catch {
    if (revision !== workspaceRevision || byId("workspace").hidden) return;
    sensorSlots = [];
    byId("slot-help").textContent = "Cannot verify empty slots. Test the reader before enrolling.";
  }
}

function renderMappings() {
  const body = byId("mappings");
  body.replaceChildren();
  for (const [slot, raw] of Object.entries(mappings).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const value = mappingValue(raw);
    const member = members.find((item) => item.memberId === value.memberId);
    const row = document.createElement("tr");
    for (const text of [slot, member ? member.firstName + " " + member.lastName : value.memberId]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeMapping(slot));
    actions.append(remove);
    row.append(actions);
    body.append(row);
  }
  if (!Object.keys(mappings).length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "No local fingerprint mappings.";
    row.append(cell);
    body.append(row);
  }
}

async function removeMapping(slot) {
  if (!await confirmAction("Remove mapping?", "Remove access on this kiosk for slot " + slot + "? Cloud copies and other kiosks are unchanged. This copy will not be restored automatically. The sensor template remains stored.")) return;
  try {
    const result = await call("/mappings/" + encodeURIComponent(slot), { method: "DELETE" });
    if (byId("workspace").hidden) return;
    mappings = result.mappings;
    renderMappings();
    await suggestSlot();
    message("Mapping removed; sensor template retained.");
  } catch (error) {
    message(friendlyError(error), true);
  }
}

function appendNumber(digit) {
  const input = byId("number-display");
  input.value = (input.value + digit).replace(/\\D/g, "").slice(0, 3);
}

function openNumberPad(target) {
  numberTarget = target;
  byId("number-display").value = target.value;
  byId("number-error").textContent = "";
  byId("number-pad").hidden = false;
}

function buildSlotKeypad() {
  const keypad = byId("slot-keypad");
  for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = digit;
    button.addEventListener("click", () => appendNumber(digit));
    keypad.append(button);
  }
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "⌫";
  back.className = "wide";
  back.setAttribute("aria-label", "Backspace");
  back.addEventListener("click", () => { byId("number-display").value = byId("number-display").value.slice(0, -1); });
  keypad.append(back);
}

byId("unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await call("/network/unlock", { method: "POST", body: JSON.stringify({ pin: byId("pin").value }) });
    byId("pin").value = "";
    await workspace();
  } catch (error) {
    message(friendlyError(error), true);
  }
});

async function testReader() {
  if (readerTest || enrolling || authenticationMethod !== "fingerprint") return readerTest;
  const revision = workspaceRevision;
  byId("test-reader").disabled = true;
  byId("reader-status").textContent = "Testing reader...";
  readerTest = (async () => {
    try {
      const value = await call("/sensor/test", { method: "POST" });
      if (revision !== workspaceRevision || byId("workspace").hidden) return;
      byId("reader-status").textContent = value.readerOnline ? "Reader online · " + value.templateCount + " templates stored" : "Reader offline. Check the connection and retry.";
      if (value.readerOnline) await suggestSlot();
      else { slotsVerified = false; byId("begin-enroll").disabled = true; }
    } catch (error) {
      if (revision !== workspaceRevision || byId("workspace").hidden) return;
      slotsVerified = false; byId("begin-enroll").disabled = true;
      byId("reader-status").textContent = "Reader test failed. " + friendlyError(error);
    } finally {
      readerTest = undefined;
      if (revision === workspaceRevision) byId("test-reader").disabled = enrolling;
    }
  })();
  return readerTest;
}
byId("test-reader").addEventListener("click", testReader);

byId("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!operatorReady) { message("Retry maintenance before enrolling.", true); return; }
  const slot = Number(byId("slot").value);
  if (!slotsVerified || byId("slot").value === "") { message("Choose a verified sensor slot before enrolling.", true); return; }
  const occupied = Boolean(mappings[String(slot)]) || sensorSlots.includes(slot);
  if (occupied && !byId("replace").checked) {
    message("Slot " + slot + " already contains a fingerprint or mapping. Confirm replacement or choose another slot.", true);
    return;
  }
  if (!selectedMember) { message("Choose a roster member.", true); return; }
  if (!await confirmAction(occupied ? "Replace occupied slot?" : "Begin enrollment?", "Slot " + slot + " · " + byId("member-picker").textContent + ". Present the same finger twice, lifting when prompted.", { enrollment: true, label: occupied ? "Replace and begin" : "Begin enrollment" })) return;
  const button = byId("begin-enroll");
  button.disabled = true;
  enrolling = true;
  exitButton.disabled = true;
  byId("test-reader").disabled = true;
  startStagePolling();
  stage("enroll_wait_first", "Place finger", "Enrollment scan 1 of 2");
  message("Enrollment is listening on the reader.");
  try {
    await call("/enroll", { method: "POST", body: JSON.stringify({ memberId: byId("member").value, slot, replaceExisting: byId("replace").checked }) });
    clearEnrollmentSelection();
    slotsVerified = false;
    const local = await call("/mappings");
    if (byId("workspace").hidden) return;
    mappings = local.mappings;
    renderMappings();
    await suggestSlot();
    byId("replace").checked = false;
    stopStagePolling();
    await pollStage();
    message("Enrollment saved in sensor slot " + slot + ".");
  } catch (error) {
    stopStagePolling();
    await pollStage();
    message(friendlyError(error), true);
  } finally {
    stopStagePolling();
    enrolling = false;
    exitButton.disabled = false;
    byId("test-reader").disabled = Boolean(readerTest);
    button.disabled = !slotsVerified;
  }
});

byId("credential-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedMember) { message("Choose a roster member.", true); return; }
  const credential = byId("credential-value").value;
  if (!credential.trim()) { message("Scan or enter the credential.", true); return; }
  const payload = { memberId: selectedMember, credential, label: byId("credential-label").value };
  try {
    let result;
    try { result = await call("/credential-mappings", { method: "POST", body: JSON.stringify(payload) }); }
    catch (error) {
      if (!/already mapped/.test(error.message) || !await confirmAction("Replace credential mapping?", "This credential is already registered. Replace its member mapping?")) throw error;
      result = await call("/credential-mappings", { method: "POST", body: JSON.stringify({ ...payload, replaceExisting: true }) });
    }
    byId("credential-value").value = ""; byId("credential-label").value = "";
    credentialMappings = (await call("/credential-mappings")).mappings; renderCredentialMappings();
    message(result.mapping.label + " registered without storing or displaying the raw credential.");
  } catch (error) { message(friendlyError(error), true); }
  finally { byId("credential-value").value = ""; }
});

byId("refresh").addEventListener("click", () => workspace().catch((error) => message(friendlyError(error), true)));
byId("credential-refresh").addEventListener("click", () => workspace().catch((error) => message(friendlyError(error), true)));
byId("member-picker").addEventListener("click", () => { byId("member-sheet").hidden = false; byId("member-search").focus(); renderMemberOptions(); });
byId("credential-member-picker").addEventListener("click", () => { byId("member-sheet").hidden = false; byId("member-search").focus(); renderMemberOptions(); });
byId("close-member-sheet").addEventListener("click", () => { byId("member-sheet").hidden = true; });
byId("member-search").addEventListener("input", renderMemberOptions);
byId("slot").addEventListener("click", () => openNumberPad(byId("slot")));
byId("slot").addEventListener("focus", () => openNumberPad(byId("slot")));
byId("close-number-pad").addEventListener("click", () => { byId("number-pad").hidden = true; });
byId("apply-number").addEventListener("click", () => {
  const raw = byId("number-display").value;
  const value = raw ? Number(raw) : NaN;
  if (numberTarget && Number.isInteger(value) && value >= 0 && value <= 199) {
    numberTarget.value = String(value);
    byId("number-pad").hidden = true;
  } else byId("number-error").textContent = "Enter a sensor slot from 0 to 199.";
});
let searchSymbols = false;
let searchUppercase = false;
function buildSearchKeyboard() {
  const input = byId("member-search"), keyboard = byId("search-keyboard");
  keyboard.replaceChildren();
  const rows = [
    [..."1234567890"],
    ...(searchSymbols
      ? [[..."@#_-()/&'"], [..."[]{}<>+=$"], [...".,?!:;%", "⌫"]]
      : [[..."qwertyuiop"], [..."asdfghjkl"], ["Shift", ..."zxcvbnm", "⌫"]]),
    [searchSymbols ? "ABC" : "123", "Space", "Clear"],
  ];
  for (const keys of rows) {
    const row = document.createElement("div"); row.className = "search-keyboard-row";
    for (const key of keys) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = key.length === 1 && searchUppercase && !searchSymbols ? key.toUpperCase() : key;
      if (["Space", "⌫", "Clear", "Shift", "123", "ABC"].includes(key)) button.className = key === "Space" ? "space" : "wide";
      if (key === "⌫") button.setAttribute("aria-label", "Backspace");
      if (key === "Shift") button.setAttribute("aria-pressed", String(searchUppercase));
      button.addEventListener("pointerdown", event => event.preventDefault());
      button.addEventListener("click", () => {
        if (key === "Shift") { searchUppercase = !searchUppercase; buildSearchKeyboard(); return; }
        if (key === "123" || key === "ABC") { searchSymbols = !searchSymbols; buildSearchKeyboard(); return; }
        let start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        if (key === "Clear") input.value = "";
        else {
          if (key === "⌫" && start === end) start = Math.max(0, start - 1);
          const text = key === "⌫" ? "" : key === "Space" ? " " : button.textContent;
          if (input.value.length - (end - start) + text.length <= input.maxLength) input.setRangeText(text, start, end, "end");
        }
        input.focus({ preventScroll: true });
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      row.append(button);
    }
    keyboard.append(row);
  }
}
function showSearchKeyboard(visible) {
  byId("search-keyboard").hidden = !visible;
  byId("toggle-search-keyboard").textContent = visible ? "Hide keyboard" : "Show keyboard";
  byId("toggle-search-keyboard").setAttribute("aria-expanded", String(visible));
}
byId("member-search").addEventListener("focus", () => showSearchKeyboard(true));
byId("toggle-search-keyboard").addEventListener("click", () => showSearchKeyboard(byId("search-keyboard").hidden));
// Preserve native touch scrolling and support displays that report swipes as mouse input.
function enableListScrolling(rosterList) {
let rosterPointer;
let rosterDragged = false;
rosterList.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  const bounds = rosterList.getBoundingClientRect();
  if (event.clientX >= bounds.left + rosterList.clientLeft + rosterList.clientWidth) return;
  rosterPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, top: rosterList.scrollTop, left: rosterList.scrollLeft, manual: event.pointerType !== "touch" };
  rosterDragged = false;
}, true);
rosterList.addEventListener("pointermove", (event) => {
  if (!rosterPointer || event.pointerId !== rosterPointer.id) return;
  if (Math.hypot(event.clientX - rosterPointer.x, event.clientY - rosterPointer.y) > 8) rosterDragged = true;
  if (rosterDragged && rosterPointer.manual) {
    event.preventDefault();
    if (!rosterList.hasPointerCapture(event.pointerId)) rosterList.setPointerCapture(event.pointerId);
    rosterList.scrollTop = rosterPointer.top + rosterPointer.y - event.clientY;
    rosterList.scrollLeft = rosterPointer.left + rosterPointer.x - event.clientX;
  }
}, true);
function endRosterPointer(event) {
  if (!rosterPointer || event.pointerId !== rosterPointer.id) return;
  if (event.type !== "pointerup") rosterDragged = true;
  const id = rosterPointer.id; rosterPointer = undefined;
  if (rosterList.hasPointerCapture(id)) rosterList.releasePointerCapture(id);
}
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) rosterList.addEventListener(name, endRosterPointer, true);
rosterList.addEventListener("dragstart", event => event.preventDefault());
rosterList.addEventListener("click", (event) => {
  if (rosterDragged && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
}
for (const list of [byId("member-options"), ...document.querySelectorAll(".table-wrap")]) enableListScrolling(list);
for (const link of document.querySelectorAll('a[href="/"]')) link.addEventListener("click", async (event) => {
  event.preventDefault();
  try { await operatorPresence.leave(); await call("/network/session", { method: "DELETE" }).catch(() => undefined); location.href = "/"; }
  catch (error) { message(friendlyError(error), true); }
});
buildSearchKeyboard();
buildPinKeypad();
buildSlotKeypad();
` + fingerprintSyncApp + `
try { await operatorPresence.enter("maintenance"); await start(); } catch { /* Retry remains available. */ }
`;
