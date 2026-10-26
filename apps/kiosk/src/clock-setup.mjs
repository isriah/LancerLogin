export const clockSetupHtml = `<section id="clock-setup" class="card clock-setup" hidden aria-labelledby="clock-title"><h2 id="clock-title">Confirm current date and time</h2><p>This kiosk started without a verified clock. Check a trusted clock before continuing.</p><form id="clock-form"><div class="clock-fields"><label>Current date<input id="clock-date" type="date" min="2020-01-01" max="2099-12-31" required></label><label>Current time<input id="clock-time" type="time" step="60" required></label></div><p id="clock-zone"></p><p id="clock-preview">Enter the current local date and time.</p><p id="clock-error" role="alert"></p><button id="clock-confirm" class="primary" type="submit">Confirm time and return to kiosk</button></form><p>Saved scans keep their timestamps through a reboot. Another offline reboot will ask you to confirm the time again.</p></section>`;

export const clockSetupStyles = `.clock-setup{width:min(680px,100%);justify-self:center;overflow:auto;display:grid;gap:8px;align-content:start}.clock-setup[hidden]{display:none}.clock-setup h2,.clock-setup p{margin:0}.clock-setup form{display:grid;gap:10px}.clock-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.clock-fields label{display:grid;gap:4px}.clock-fields input{width:100%;min-width:0;min-height:48px;font:inherit;padding:8px}.clock-setup #clock-error:empty{display:none}.clock-setup>p:last-child{font-size:14px}`;

export const clockSetupApp = `
function showClockSetup() {
  byId("workspace").hidden = true; maintenanceTabs.hidden = true;
  byId("clock-setup").hidden = false;
  byId("clock-zone").textContent = "Time zone: " + Intl.DateTimeFormat().resolvedOptions().timeZone;
  message("Confirm the clock to resume attendance.");
}
function selectedClockTime() {
  const date = byId("clock-date").value, time = byId("clock-time").value;
  if (!date || !time) return;
  const value = new Date(date + "T" + time + ":00");
  if (!Number.isFinite(value.getTime())) return;
  const local = value.getFullYear() + "-" + String(value.getMonth()+1).padStart(2,"0") + "-" + String(value.getDate()).padStart(2,"0");
  if (local !== date || String(value.getHours()).padStart(2,"0")+":"+String(value.getMinutes()).padStart(2,"0") !== time) return;
  return value;
}
for (const id of ["clock-date", "clock-time"]) byId(id).addEventListener("input", () => {
  const value = selectedClockTime();
  byId("clock-preview").textContent = value ? "Confirm: " + value.toLocaleString(undefined,{dateStyle:"full",timeStyle:"short"}) : "Enter the current local date and time.";
});
byId("clock-form").addEventListener("submit", async event => {
  event.preventDefault(); const value = selectedClockTime();
  if (!value) { byId("clock-error").textContent = "Enter a valid current local date and time."; return; }
  byId("clock-confirm").disabled = true; byId("clock-error").textContent = "";
  try {
    await call("/maintenance/clock",{method:"POST",body:JSON.stringify({currentTime:value.toISOString()})});
    await operatorPresence.leave(); location.href = "/";
  } catch(error) { byId("clock-error").textContent = error.message; }
  finally { byId("clock-confirm").disabled = false; }
});
`;
