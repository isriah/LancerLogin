export const maintenanceHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#424a53"><title>LancerLogin maintenance</title><link rel="stylesheet" href="/maintenance.css"></head><body><main id="maintenance-main" class="locked"><header id="maintenance-header" hidden><div><p id="brand-subtitle">Local tools</p><h1 id="brand-title">Fingerprint maintenance</h1></div><a href="/">Return to kiosk</a></header><p id="message" role="status">Checking local access…</p><section id="unlock" class="card unlock-card" hidden><h2>Unlock maintenance</h2><p>Use the same local PIN that protects network settings.</p><form id="unlock-form"><label>Local settings PIN<input id="pin" class="pin-target" inputmode="none" pattern="[0-9]{6,12}" maxlength="12" required readonly></label><div id="pin-keypad" class="pin-keypad" aria-label="PIN keypad"></div><button class="primary" type="submit">Unlock for five minutes</button></form></section><div id="workspace" class="workspace" hidden><section class="card reader-card"><div class="card-heading"><div><h2>Reader</h2><p>Templates stay inside the R503.</p></div><button id="test-reader" type="button">Test</button></div><p id="reader-status">Reader status has not been tested.</p><article id="enroll-stage" class="enroll-stage stage-ready" aria-live="polite"><strong id="stage-title">Ready to enroll</strong><span id="stage-detail">Choose a member, finger, and slot.</span></article></section><section class="card enroll-card"><h2>Enroll fingerprint</h2><form id="enroll-form"><label>Roster member<input id="member" type="hidden" required><button id="member-picker" class="picker-button" type="button">Choose a member</button></label><div class="form-row"><label>Finger<select id="finger" required><option>right index</option><option>left index</option><option>right thumb</option><option>left thumb</option><option>right middle</option><option>left middle</option><option>other</option></select></label><label>Slot<input id="slot" class="numeric-target" inputmode="none" pattern="[0-9]{1,3}" maxlength="3" required readonly></label></div><p id="slot-help"></p><label class="check"><input id="replace" type="checkbox"><span>Replace occupied slot</span></label><button class="primary" id="begin-enroll" type="submit">Begin two-scan enrollment</button></form></section><section class="card mappings-card"><div class="card-heading"><div><h2>Mappings</h2><p>Removal keeps sensor templates.</p></div><button id="refresh" type="button">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Slot</th><th>Member</th><th>Finger</th><th></th></tr></thead><tbody id="mappings"></tbody></table></div></section></div><section id="member-sheet" class="sheet" hidden aria-labelledby="member-sheet-title"><div class="sheet-panel"><div class="card-heading"><h2 id="member-sheet-title">Choose member</h2><button id="close-member-sheet" type="button">Close</button></div><input id="member-search" type="search" placeholder="Search roster" autocomplete="off"><div id="member-options" class="option-list"></div></div></section><section id="number-pad" class="sheet number-sheet" hidden aria-labelledby="number-pad-title"><div class="sheet-panel small"><div class="card-heading"><h2 id="number-pad-title">Enter slot</h2><button id="close-number-pad" type="button">Close</button></div><input id="number-display" class="pin-target" inputmode="none" readonly><div id="slot-keypad" class="pin-keypad" aria-label="Slot keypad"></div><button id="apply-number" class="primary" type="button">Use slot</button></div></section></main><script type="module" src="/maintenance.js"></script></body></html>`;

export const maintenanceStyles = `:root{--primary:#b80100;--secondary:#f2c14e;--surface-bg:#424a53;--surface:#1a1d24;--text:#fff;--muted:#d3d8df;--line:#ffffff24;--success:#178f4f;--danger:#ff5b57;--notice:#f2c14e;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--surface-bg);color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--surface-bg)}[hidden]{display:none!important}button,input,select{font:inherit}main{width:100%;height:100vh;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:8px;padding:12px}main.locked{grid-template-rows:auto auto;place-content:center;padding:16px}main.locked>#message{justify-self:center;text-align:center}header,.card-heading{display:flex;align-items:start;justify-content:space-between;gap:10px}header{align-items:center}header p,header h1,.card h2,.card p{margin:0}h1{font-size:28px;line-height:1.05}h2{font-size:20px;line-height:1.1}header p,.card p,#message{color:var(--muted)}header a{min-height:42px;display:inline-grid;place-items:center;padding:0 12px;border:1px solid #ffffff33;border-radius:8px;color:#fff;text-decoration:none;font-weight:800}.card{min-height:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}.workspace{min-height:0;display:grid;grid-template-columns:.95fr 1.15fr 1.25fr;gap:10px}.card form{display:grid;gap:8px}.card label{display:grid;gap:4px;font-size:14px;font-weight:800}.card input,.card select,.picker-button{min-height:40px;padding:6px 9px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff}.card button{min-height:40px;padding:6px 10px;border:1px solid #ffffff33;border-radius:7px;background:#292e39;color:#fff;font-weight:800}.card button.primary,.card form>button.primary,.sheet button.primary{border-color:var(--primary);background:var(--primary);color:#fff}.picker-button{text-align:left;font-weight:800}.numeric-target{caret-color:transparent}.numeric-target::-webkit-inner-spin-button,.numeric-target::-webkit-outer-spin-button{appearance:none;margin:0}.form-row{display:grid;grid-template-columns:1fr 72px;gap:8px}.check{grid-template-columns:auto 1fr!important;align-items:center}.check input{width:20px;min-height:20px}#message{min-height:22px;font-size:15px}.error{color:#ffb3bd!important}.table-wrap{height:100%;min-height:0;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px;text-align:left;border-bottom:1px solid #ffffff1f}td button{min-height:32px!important;padding:4px 7px!important}.reader-card{display:grid;grid-template-rows:auto auto 1fr;gap:10px}.enroll-stage{align-self:stretch;display:grid;place-items:center;text-align:center;gap:8px;padding:14px;border-radius:8px;background:#2a3039;border:2px solid #3d4652}.enroll-stage strong{font-size:30px;line-height:1}.enroll-stage span{font-size:18px;color:var(--muted)}.stage-enroll_wait_first,.stage-enroll_wait_second{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 18%,#2a3039)}.stage-enroll_scan_accepted,.stage-enroll_success{border-color:var(--success);background:color-mix(in srgb,var(--success) 24%,#2a3039)}.stage-enroll_failure{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 20%,#2a3039)}.unlock-card{width:min(430px,100%);justify-self:center;align-self:center}.pin-target{font-size:24px;letter-spacing:.28em;text-align:center}.pin-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.pin-keypad button{min-height:44px;font-size:20px}.pin-keypad .wide{grid-column:span 2}.sheet{position:fixed;z-index:20;inset:0;display:grid;place-items:end center;padding:10px;background:rgb(0 0 0 / 62%)}.sheet-panel{width:min(760px,100%);max-height:min(430px,92vh);display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 18px 60px rgb(0 0 0 / 45%)}.sheet-panel.small{width:min(330px,100%);grid-template-rows:auto auto auto auto}.sheet input{min-height:44px;padding:8px 10px;border:1px solid #757b88;border-radius:7px;background:#0e1015;color:#fff}.option-list{min-height:0;overflow:auto;display:grid;gap:6px;padding-right:2px;-webkit-overflow-scrolling:touch}.option-list button{min-height:56px;padding:8px 10px;border:1px solid #ffffff24;border-radius:7px;background:#292e39;color:#fff;text-align:left;font-weight:800}.option-list button.selected{border-color:var(--secondary);background:color-mix(in srgb,var(--secondary) 22%,#292e39)}@media(max-height:520px){main{padding:8px;gap:6px}main.locked{padding:8px}h1{font-size:24px}h2{font-size:18px}.card{padding:9px}.workspace{gap:8px}.enroll-stage strong{font-size:25px}.enroll-stage span{font-size:16px}.card input,.card select,.card button,.picker-button{min-height:34px}.card form{gap:5px}#message{font-size:14px}.table-wrap{max-height:294px}.sheet-panel{max-height:450px;padding:10px}.option-list button{min-height:50px}.pin-keypad button{min-height:40px}}`;

export const maintenanceApp = `
const byId = (id) => document.getElementById(id);
let members = [];
let mappings = {};
let stagePolling;
let selectedMember;
let numberTarget;

async function call(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { "content-type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
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

async function workspace() {
  byId("unlock").hidden = true;
  byId("maintenance-main").classList.remove("locked");
  byId("maintenance-header").hidden = false;
  byId("workspace").hidden = false;
  const [roster, local] = await Promise.all([call("/maintenance/members"), call("/mappings")]);
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
  if (!confirm("Remove the local mapping for slot " + slot + "? The sensor template will remain stored.")) return;
  try {
    const result = await call("/mappings/" + encodeURIComponent(slot), { method: "DELETE" });
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
  const button = byId("begin-enroll");
  button.disabled = true;
  startStagePolling();
  stage("enroll_wait_first", "Place finger", "Enrollment scan 1 of 2");
  message("Enrollment is listening on the reader.");
  try {
    await call("/enroll", { method: "POST", body: JSON.stringify({ memberId: byId("member").value, finger: byId("finger").value, slot, replaceExisting: byId("replace").checked }) });
    mappings = (await call("/mappings")).mappings;
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

byId("refresh").addEventListener("click", workspace);
byId("member-picker").addEventListener("click", () => { byId("member-sheet").hidden = false; byId("member-search").focus(); renderMemberOptions(); });
byId("close-member-sheet").addEventListener("click", () => { byId("member-sheet").hidden = true; });
byId("member-search").addEventListener("input", renderMemberOptions);
byId("slot").addEventListener("click", () => openNumberPad(byId("slot")));
byId("slot").addEventListener("focus", () => openNumberPad(byId("slot")));
byId("close-number-pad").addEventListener("click", () => { byId("number-pad").hidden = true; });
byId("apply-number").addEventListener("click", () => {
  const value = Number(byId("number-display").value);
  if (numberTarget && Number.isInteger(value) && value >= 0 && value <= 199) {
    numberTarget.value = String(value);
    byId("number-pad").hidden = true;
  } else message("Enter a sensor slot from 0 to 199.", true);
});
buildPinKeypad();
buildSlotKeypad();
await start();
`;
