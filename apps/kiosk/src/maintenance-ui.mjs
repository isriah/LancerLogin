export const maintenanceHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#424a53"><title>LancerLogin maintenance</title><link rel="stylesheet" href="/maintenance.css"></head><body><main id="maintenance-main" class="locked"><header id="maintenance-header" hidden><div><p id="brand-subtitle">Local tools</p><h1 id="brand-title">Fingerprint maintenance</h1></div><a href="/">Return to kiosk</a></header><p id="message" role="status">Checking local access…</p><a id="locked-return" href="/">Return to kiosk</a><section id="unlock" class="card unlock-card" hidden><h2>Unlock maintenance</h2><p>Use the same local PIN that protects network settings.</p><form id="unlock-form"><label>Local settings PIN<input id="pin" class="pin-target" inputmode="none" pattern="[0-9]{6,12}" maxlength="12" required readonly></label><div id="pin-keypad" class="pin-keypad" aria-label="PIN keypad"></div><button class="primary" type="submit">Unlock for five minutes</button></form></section><div id="workspace" class="workspace" hidden><section class="card reader-card"><div class="card-heading"><div><h2>Reader</h2><p>Templates stay inside the R503.</p></div><button id="test-reader" type="button">Test</button></div><p id="reader-status">Reader status has not been tested.</p><article id="enroll-stage" class="enroll-stage stage-ready" aria-live="polite"><strong id="stage-title">Ready to enroll</strong><span id="stage-detail">Choose a member, finger, and slot.</span></article></section><section class="card enroll-card"><h2>Enroll fingerprint</h2><form id="enroll-form"><label>Roster member<input id="member" type="hidden" required><button id="member-picker" class="picker-button" type="button">Choose a member</button></label><div class="form-row"><label>Finger<button id="finger-picker" class="picker-button" type="button">right index</button><select id="finger" required hidden><option>right index</option><option>left index</option><option>right thumb</option><option>left thumb</option><option>right middle</option><option>left middle</option><option>other</option></select></label><label>Slot<input id="slot" class="numeric-target" inputmode="none" pattern="[0-9]{1,3}" maxlength="3" required readonly></label></div><p id="slot-help"></p><label class="check"><input id="replace" type="checkbox"><span>Replace occupied slot</span></label><button class="primary" id="begin-enroll" type="submit">Begin two-scan enrollment</button></form></section><section class="card mappings-card"><div class="card-heading"><div><h2>Mappings</h2><p>Removal keeps sensor templates.</p></div><button id="refresh" type="button">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Slot</th><th>Member</th><th>Finger</th><th></th></tr></thead><tbody id="mappings"></tbody></table></div></section></div><section id="member-sheet" class="sheet" hidden aria-labelledby="member-sheet-title"><div class="sheet-panel"><div class="card-heading member-heading"><h2 id="member-sheet-title">Choose member</h2><input id="member-search" type="search" placeholder="Search roster" aria-label="Search roster" inputmode="none" autocomplete="off" maxlength="100"><button id="toggle-search-keyboard" type="button" aria-controls="search-keyboard" aria-expanded="true">Hide keyboard</button><button id="close-member-sheet" type="button">Close</button></div><div class="member-content"><div id="member-options" class="option-list"></div><div id="search-keyboard" class="search-keyboard" aria-label="Roster search keyboard"></div></div></div></section><section id="finger-sheet" class="sheet" hidden aria-labelledby="finger-title"><div class="sheet-panel finger-panel"><div class="card-heading"><h2 id="finger-title">Choose finger</h2><button id="close-finger-sheet" type="button">Close</button></div><div id="finger-options" class="option-list"></div></div></section><section id="number-pad" class="sheet number-sheet" hidden aria-labelledby="number-pad-title"><div class="sheet-panel small"><div class="card-heading"><h2 id="number-pad-title">Enter slot</h2><button id="close-number-pad" type="button">Close</button></div><input id="number-display" class="pin-target" inputmode="none" readonly><p id="number-error" role="status"></p><div id="slot-keypad" class="pin-keypad" aria-label="Slot keypad"></div><button id="apply-number" class="primary" type="button">Use slot</button></div></section><section id="confirm-sheet" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div class="sheet-panel confirmation-panel"><h2 id="confirm-title">Confirm action</h2><p id="confirm-detail"></p><div class="confirmation-actions"><button id="cancel-action" type="button">Cancel</button><button id="accept-action" class="primary" type="button">Confirm</button></div></div></section></main><script type="module" src="/maintenance.js"></script></body></html>`;

export const maintenanceStyles = `:root{--primary:#b80100;--secondary:#f2c14e;--surface-bg:#424a53;--surface:#1a1d24;--text:#fff;--muted:#d3d8df;--line:#ffffff24;--success:#178f4f;--danger:#ff5b57;--notice:#f2c14e;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--surface-bg);color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--surface-bg)}[hidden]{display:none!important}button,input,select{font:inherit}main{width:100%;height:100vh;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:8px;padding:12px}main.locked{grid-template-rows:auto auto;place-content:center;padding:16px}main.locked>#message{justify-self:center;text-align:center}header,.card-heading{display:flex;align-items:start;justify-content:space-between;gap:10px}header{align-items:center}header p,header h1,.card h2,.card p{margin:0}h1{font-size:30px;line-height:1.05}h2{font-size:22px;line-height:1.1}header p,.card p,#message{color:var(--muted)}header a{min-height:42px;display:inline-grid;place-items:center;padding:0 12px;border:1px solid #ffffff33;border-radius:8px;color:#fff;text-decoration:none;font-weight:800}.card{min-height:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.workspace{min-height:0;display:grid;grid-template-columns:.95fr 1.15fr 1.25fr;gap:10px}.card form{display:grid;gap:8px}.card label{display:grid;gap:4px;font-size:16px;font-weight:800}.card input,.card select,.picker-button{min-height:40px;padding:6px 9px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff;font-size:16px}.card button{min-height:40px;padding:6px 10px;border:1px solid #ffffff33;border-radius:7px;background:#292e39;color:#fff;font-size:16px;font-weight:800}.card button.primary,.card form>button.primary,.sheet button.primary{border-color:var(--primary);background:var(--primary);color:#fff}.picker-button{text-align:left;font-weight:800}.numeric-target{caret-color:transparent}.numeric-target::-webkit-inner-spin-button,.numeric-target::-webkit-outer-spin-button{appearance:none;margin:0}.form-row{display:grid;grid-template-columns:1fr 72px;gap:8px}.check{grid-template-columns:auto 1fr!important;align-items:center}.check input{width:20px;min-height:20px}#message{min-height:22px;font-size:16px}.error{color:#ffb3bd!important}.table-wrap{height:100%;min-height:0;overflow:auto}table{width:100%;border-collapse:collapse;font-size:16px}th,td{padding:6px;text-align:left;border-bottom:1px solid #ffffff1f}td button{min-height:32px!important;padding:4px 7px!important}.reader-card{display:grid;grid-template-rows:auto auto 1fr;gap:10px}.enroll-stage{align-self:stretch;display:grid;place-items:center;text-align:center;gap:8px;padding:14px;border-radius:8px;background:#2a3039;border:2px solid #3d4652}.enroll-stage strong{font-size:32px;line-height:1}.enroll-stage span{font-size:19px;color:var(--muted)}.stage-enroll_wait_first,.stage-enroll_wait_second{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 18%,#2a3039)}.stage-enroll_scan_accepted,.stage-enroll_success{border-color:var(--success);background:color-mix(in srgb,var(--success) 24%,#2a3039)}.stage-enroll_failure{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 20%,#2a3039)}.unlock-card{width:min(430px,100%);justify-self:center;align-self:center}.pin-target{font-size:26px;letter-spacing:.28em;text-align:center}.pin-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.pin-keypad button{min-height:44px;font-size:22px}.pin-keypad .wide{grid-column:span 2}.sheet{position:fixed;z-index:20;inset:0;display:grid;place-items:end center;padding:10px;background:rgb(0 0 0 / 62%)}.sheet-panel{width:min(760px,100%);max-height:min(430px,92vh);display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 18px 60px rgb(0 0 0 / 45%)}.sheet-panel.small{width:min(330px,100%);grid-template-rows:auto auto auto auto}.sheet input{min-height:44px;padding:8px 10px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff;font-size:16px}.option-list{min-height:0;overflow:auto;display:grid;gap:6px;padding-right:2px;-webkit-overflow-scrolling:touch}.option-list button{min-height:56px;padding:8px 10px;border:1px solid #ffffff24;border-radius:7px;background:#292e39;color:#fff;text-align:left;font-size:16px;font-weight:800}.option-list button.selected{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 22%,#292e39)}@media(max-height:520px){main{padding:8px;gap:6px}main.locked{padding:8px}h1{font-size:26px}h2{font-size:20px}.card{padding:9px}.workspace{gap:8px}.enroll-stage strong{font-size:27px}.enroll-stage span{font-size:17px}.card input,.card select,.card button,.picker-button{min-height:34px}.card form{gap:5px}#message{font-size:15px}.table-wrap{max-height:294px}.sheet-panel{max-height:450px;padding:10px}.option-list button{min-height:50px}.pin-keypad button{min-height:40px}}
main.locked{grid-template-rows:auto auto minmax(0,1fr);place-content:stretch;justify-items:center}
#locked-return{color:var(--text);min-height:44px;padding:10px}
.unlock-card{max-height:100%;overflow:auto;align-self:center}
main:not(.locked)>#locked-return{display:none}
.workspace{grid-template-columns:minmax(0,.95fr) minmax(0,1.15fr) minmax(0,1.25fr)}
.card{min-width:0;overflow:auto}
.card,.table-wrap,.option-list,.sheet-panel{touch-action:pan-x pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.card button,.card input,.card select,.picker-button,header a,td button{min-height:44px!important}
.card-heading{flex-shrink:0}
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
#member-options{touch-action:pan-y;padding-right:22px}
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
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--secondary);outline-offset:-3px}
@media(max-height:400px){#member-sheet .sheet-panel{gap:6px;padding:8px}
.pin-keypad{gap:4px}
.number-sheet .sheet-panel.small{width:min(480px,calc(100vw - 16px));gap:4px}
.number-sheet .pin-keypad{grid-template-columns:repeat(6,minmax(0,1fr))}
.unlock-card{width:min(650px,100%)}
.unlock-card .pin-keypad{grid-template-columns:repeat(6,minmax(0,1fr))}
}

`;

export const maintenanceLayoutStyles = `.form-row{grid-template-columns:minmax(0,1fr) minmax(0,72px)}.form-row>*{min-width:0}.form-row input,.form-row select{width:100%;min-width:0}.pin-keypad button{width:100%;min-width:0}.number-sheet{padding:8px;overflow:hidden}.sheet-panel.small{width:min(310px,calc(100vw - 16px));max-width:100%;overflow:auto}`;

export const maintenanceApp = `
const byId = (id) => document.getElementById(id);
let members = [];
let mappings = {};
let stagePolling;
let selectedMember;
let numberTarget;
let confirmResolve;
let sessionPolling;

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
  byId("brand-title").textContent = brand.organizationName ? brand.organizationName + " fingerprints" : "Fingerprint maintenance";
}

function stage(id, title, detail) {
  const panel = byId("enroll-stage");
  panel.className = "enroll-stage stage-" + id;
  byId("stage-title").textContent = title;
  byId("stage-detail").textContent = detail;
}

function stageFromDisplay(display) {
  const id = display?.id || "ready";
  stage(id, display?.message || "Ready to enroll", display?.detail || "Choose a member, finger, and slot.");
}

async function pollStage() {
  try { stageFromDisplay((await call("/display-state")).display); } catch { /* Keep the last visible prompt. */ }
}

function startStagePolling() {
  clearInterval(stagePolling);
  void pollStage();
  stagePolling = setInterval(pollStage, 350);
}

function stopStagePolling() {
  clearInterval(stagePolling);
  stagePolling = undefined;
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
  try { applyBranding(await call("/display-state")); } catch { /* Branding may not be available before pairing. */ }
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
  stopStagePolling();
  clearInterval(sessionPolling);
  byId("workspace").hidden = true;
  byId("maintenance-header").hidden = true;
  for (const sheet of document.querySelectorAll(".sheet")) sheet.hidden = true;
  confirmResolve?.(false);
  confirmResolve = undefined;
  members = []; mappings = {}; selectedMember = undefined;
  byId("member-options").replaceChildren(); byId("mappings").replaceChildren();
  byId("member").value = ""; byId("member-search").value = ""; byId("pin").value = "";
  byId("maintenance-main").classList.add("locked");
  byId("unlock").hidden = false;
  message("Maintenance locked. Enter the local settings PIN.");
}

async function confirmAction(title, detail) {
  if (confirmResolve) return false;
  byId("confirm-title").textContent = title;
  byId("confirm-detail").textContent = detail;
  byId("confirm-sheet").hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
for (const [id, accepted] of [["cancel-action", false], ["accept-action", true]]) {
  byId(id).addEventListener("click", () => {
    byId("confirm-sheet").hidden = true;
    confirmResolve?.(accepted); confirmResolve = undefined;
  });
}

async function workspace() {
  const [roster, local] = await Promise.all([call("/maintenance/members"), call("/mappings")]);
  byId("unlock").hidden = true;
  byId("maintenance-main").classList.remove("locked");
  byId("maintenance-header").hidden = false;
  byId("workspace").hidden = false;
  clearInterval(sessionPolling);
  sessionPolling = setInterval(async () => {
    try { if (!(await call("/maintenance/session")).authorized) lockWorkspace(); }
    catch { lockWorkspace(); }
  }, 1000);
  members = roster.members;
  mappings = local.mappings;
  selectedMember = undefined;
  byId("member").value = "";
  byId("member-picker").textContent = "Choose a member";
  renderMemberOptions();
  renderMappings();
  suggestSlot();
  stage("ready", "Ready to enroll", "Choose a member, finger, and slot.");
  message("Maintenance unlocked for five minutes.");
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
  byId("member-picker").textContent = memberLabel(member);
  byId("member-sheet").hidden = true;
  renderMemberOptions();
}

function suggestSlot() {
  const used = new Set(Object.keys(mappings).map(Number));
  let slot = 0;
  while (used.has(slot) && slot < 200) slot += 1;
  byId("slot").value = String(Math.min(slot, 199));
  byId("slot-help").textContent = slot < 200 ? "Suggested next open slot: " + slot : "All sensor slots have local mappings.";
}

function renderMappings() {
  const body = byId("mappings");
  body.replaceChildren();
  for (const [slot, raw] of Object.entries(mappings).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const value = mappingValue(raw);
    const member = members.find((item) => item.memberId === value.memberId);
    const row = document.createElement("tr");
    for (const text of [slot, member ? member.firstName + " " + member.lastName : value.memberId, value.finger || "unspecified"]) {
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
    cell.colSpan = 4;
    cell.textContent = "No local fingerprint mappings.";
    row.append(cell);
    body.append(row);
  }
}

async function removeMapping(slot) {
  if (!await confirmAction("Remove mapping?", "Remove the local mapping for slot " + slot + "? The sensor template will remain stored.")) return;
  try {
    const result = await call("/mappings/" + encodeURIComponent(slot), { method: "DELETE" });
    if (byId("workspace").hidden) return;
    mappings = result.mappings;
    renderMappings();
    suggestSlot();
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

byId("test-reader").addEventListener("click", async () => {
  message("Testing reader…");
  try {
    const value = await call("/sensor/test", { method: "POST" });
    if (byId("workspace").hidden) return;
    byId("reader-status").textContent = value.readerOnline ? "Reader online · " + value.templateCount + " templates stored" : "Reader offline";
    message(value.readerOnline ? "Reader test passed." : "Reader did not respond.", !value.readerOnline);
  } catch (error) {
    message(friendlyError(error), true);
  }
});

byId("enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const slot = Number(byId("slot").value);
  if (mappings[String(slot)] && !byId("replace").checked) {
    message("Slot " + slot + " already has a mapping. Confirm replacement or choose another slot.", true);
    return;
  }
  if (!selectedMember) { message("Choose a roster member.", true); return; }
  if (!await confirmAction(mappings[String(slot)] ? "Replace occupied slot?" : "Begin enrollment?", "Slot " + slot + " · " + byId("member-picker").textContent + " · " + byId("finger").value + ". Present the same finger twice after confirming.")) return;
  const button = byId("begin-enroll");
  button.disabled = true;
  startStagePolling();
  stage("enroll_wait_first", "Place finger", "Enrollment scan 1 of 2");
  message("Enrollment is listening on the reader.");
  try {
    await call("/enroll", { method: "POST", body: JSON.stringify({ memberId: byId("member").value, finger: byId("finger").value, slot, replaceExisting: byId("replace").checked }) });
    const local = await call("/mappings");
    if (byId("workspace").hidden) return;
    mappings = local.mappings;
    renderMappings();
    suggestSlot();
    byId("replace").checked = false;
    await pollStage();
    message("Enrollment saved in sensor slot " + slot + ".");
  } catch (error) {
    await pollStage();
    message(friendlyError(error), true);
  } finally {
    stopStagePolling();
    button.disabled = false;
  }
});

byId("refresh").addEventListener("click", () => workspace().catch((error) => message(friendlyError(error), true)));
byId("member-picker").addEventListener("click", () => { byId("member-sheet").hidden = false; byId("member-search").focus(); renderMemberOptions(); });
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
function buildSearchKeyboard() {
  const input = byId("member-search");
  const rows = [[..."1234567890"], [..."qwertyuiop"], [..."asdfghjkl"], [..."zxcvbnm", "-", "'", "."], ["Space", "⌫", "Clear"]];
  for (const keys of rows) {
    const row = document.createElement("div");
    row.className = "search-keyboard-row";
    for (const key of keys) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = key;
      if (["Space", "⌫", "Clear"].includes(key)) button.className = "wide";
      if (key === "⌫") button.setAttribute("aria-label", "Backspace");
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        let start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        if (key === "Clear") input.value = "";
        else {
          if (key === "⌫" && start === end) start = Math.max(0, start - 1);
          const text = key === "⌫" ? "" : key === "Space" ? " " : key;
          if (input.value.length - (end - start) + text.length <= input.maxLength) input.setRangeText(text, start, end, "end");
        }
        input.focus({ preventScroll: true });
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      row.append(button);
    }
    byId("search-keyboard").append(row);
  }
}
function showSearchKeyboard(visible) {
  byId("search-keyboard").hidden = !visible;
  byId("toggle-search-keyboard").textContent = visible ? "Hide keyboard" : "Show keyboard";
  byId("toggle-search-keyboard").setAttribute("aria-expanded", String(visible));
}
byId("member-search").addEventListener("focus", () => showSearchKeyboard(true));
byId("toggle-search-keyboard").addEventListener("click", () => showSearchKeyboard(byId("search-keyboard").hidden));
// Leave native touch scrolling in charge; a drag must never activate a roster row.
let rosterPointer;
let rosterDragged = false;
const rosterList = byId("member-options");
rosterList.addEventListener("pointerdown", (event) => {
  rosterPointer = { x: event.clientX, y: event.clientY };
  rosterDragged = false;
}, true);
rosterList.addEventListener("pointermove", (event) => {
  if (rosterPointer && Math.hypot(event.clientX - rosterPointer.x, event.clientY - rosterPointer.y) > 8) rosterDragged = true;
}, true);
rosterList.addEventListener("pointercancel", () => { rosterDragged = true; rosterPointer = undefined; }, true);
rosterList.addEventListener("pointerup", () => { rosterPointer = undefined; }, true);
rosterList.addEventListener("click", (event) => {
  if (rosterDragged && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
for (const link of document.querySelectorAll('a[href="/"]')) link.addEventListener("click", async (event) => {
  event.preventDefault(); await call("/network/session", { method: "DELETE" }).catch(() => undefined); location.href = "/";
});
for (const option of byId("finger").options) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = option.value;
  button.addEventListener("click", () => {
    byId("finger").value = option.value;
    byId("finger-picker").textContent = option.value;
    byId("finger-sheet").hidden = true;
  });
  byId("finger-options").append(button);
}
byId("finger-picker").addEventListener("click", () => { byId("finger-sheet").hidden = false; });
byId("close-finger-sheet").addEventListener("click", () => { byId("finger-sheet").hidden = true; });
buildSearchKeyboard();
buildPinKeypad();
buildSlotKeypad();
await start();
`;
