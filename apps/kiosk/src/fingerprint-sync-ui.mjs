export const fingerprintSyncStyles = `
.sync-reader-heading{flex-wrap:wrap}.sync-sheet{z-index:19}.sync-panel{grid-template-rows:auto minmax(0,1fr);width:min(720px,100%);max-height:92vh}
.sync-content{min-height:0;overflow:auto;display:grid;gap:12px;touch-action:pan-y}.sync-content p{margin:0}.sync-content code{display:block;overflow-wrap:anywhere;white-space:normal;font-size:16px;line-height:1.5;color:var(--text)}
.sync-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.sync-peers{display:grid;gap:10px}.sync-peer{display:grid;gap:8px;border:1px solid var(--line);border-radius:8px;padding:10px}.sync-panel button{min-height:44px}.sync-fingerprint{padding:8px;background:var(--surface-bg);border-radius:8px}
`;

// Appended to the maintenance module so requests share its PIN session and lock
// handling. Remote names/fingerprints are inserted as text, never HTML.
export const fingerprintSyncApp = `
(() => {
  const openButton = document.createElement("button"); openButton.id = "open-fingerprint-sync";
  openButton.type = "button"; openButton.textContent = "Sync"; openButton.setAttribute("aria-label", "Fingerprint sync");
  const heading = byId("test-reader").parentElement; heading.classList.add("sync-reader-heading"); heading.append(openButton);
  heading.querySelector("p").textContent = "Local fingerprints and optional encrypted sync.";
  const sheet = document.createElement("section"); sheet.id = "fingerprint-sync-sheet"; sheet.className = "sheet sync-sheet";
  sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "sync-title");
  sheet.innerHTML = '<div class="sheet-panel card sync-panel"><div class="card-heading"><h2 id="sync-title">Fingerprint sync</h2><button type="button" id="close-sync">Close</button></div><div class="sync-content"><p id="sync-message" role="status"></p><div class="sync-actions"><button type="button" id="toggle-sync" class="primary" disabled>Enable on this kiosk</button><button type="button" id="refresh-sync">Refresh</button></div><p>Approve only kiosks you control. Compare the device fingerprint shown here with the one on the other kiosk before approving.</p><div id="sync-local-fingerprint" class="sync-fingerprint" hidden><strong>This kiosk device fingerprint</strong><code id="sync-fingerprint-value"></code></div><p>New enrollments sync across networks after both kiosks approve each other. Existing unidentified fingerprints are not exported. Disabling sync or revoking trust does not erase fingerprints already stored on readers.</p><div id="sync-peers" class="sync-peers"></div></div></div>';
  byId("maintenance-main").append(sheet);
  let state, busy = false;
  const fingerprint = value => String(value || "").match(/.{1,4}/g)?.join(" ") || "Unavailable";
  function notice(text, failed = false) { byId("sync-message").textContent = text; byId("sync-message").className = failed ? "error" : ""; }
  function controls() {
    for (const button of sheet.querySelectorAll("button")) button.disabled = button.id !== "close-sync" && busy;
    byId("toggle-sync").disabled = busy || !state || (!state.installationEnabled && !state.enabled);
  }
  function close() { sheet.hidden = true; openButton.focus(); }
  function render() {
    byId("toggle-sync").textContent = state.enabled ? "Disable on this kiosk" : "Enable on this kiosk";
    byId("sync-local-fingerprint").hidden = !state.fingerprint;
    byId("sync-fingerprint-value").textContent = fingerprint(state.fingerprint);
    const target = byId("sync-peers"); target.replaceChildren();
    if (!state.installationEnabled) notice(state.offline ? "The relay is unavailable. Transfers are paused; you can still disable local sync or revoke peer trust." : "An Admin must first enable Fingerprint sync on the dashboard's Kiosks page.");
    else notice(!state.enabled ? "Sync is off on this kiosk." : state.diagnostics?.status === "needs_attention" || state.diagnostics?.status === "unavailable" ? "Sync needs attention. Check both readers, network access, active membership, and peer approval, then refresh." : "Sync is enabled. Approved peers can exchange new enrollments.");
    const candidates = state.candidates || [];
    const peers = [...candidates, ...(state.peers || []).filter(peer => !candidates.some(candidate => candidate.kioskId === peer.kioskId))];
    for (const peer of peers) {
      const trusted = (state.peers || []).find(item => item.kioskId === peer.kioskId);
      const same = trusted?.fingerprint === peer.fingerprint && trusted?.pairingId === peer.pairingId;
      const row = document.createElement("div"); row.className = "sync-peer";
      const title = document.createElement("strong"); title.textContent = peer.name || peer.kioskId;
      const code = document.createElement("code"); code.textContent = fingerprint(peer.fingerprint);
      const status = document.createElement("p"); status.textContent = same ? "Approved locally" : trusted ? "Device identity changed. Revoke old trust before approving." : "Not approved";
      const button = document.createElement("button"); button.type = "button"; button.textContent = trusted ? "Revoke trust" : "Compare and approve";
      button.addEventListener("click", async () => {
        if (!await confirmAction(trusted ? "Revoke kiosk trust?" : "Do device fingerprints match?", trusted ? "Stop future transfers with this kiosk. Existing reader fingerprints remain." : "On the other kiosk, open Fingerprint sync and compare its full device fingerprint: " + fingerprint(peer.fingerprint) + ". Approve only if every group matches.")) return;
        await change(() => call(trusted ? "/fingerprint-sync/peers/" + encodeURIComponent(peer.kioskId) : "/fingerprint-sync/peers", { method: trusted ? "DELETE" : "POST", ...(trusted ? {} : { body: JSON.stringify({ kioskId: peer.kioskId, fingerprint: peer.fingerprint }) }) }));
      });
      row.append(title, code, status, button); target.append(row);
    }
    if (state.enabled && !peers.length) { const empty = document.createElement("p"); empty.textContent = "Enable sync on another kiosk, then refresh to compare its identity."; target.append(empty); }
  }
  async function refresh() {
    busy = true; controls(); notice("Loading sync settings…");
    try { state = await call("/fingerprint-sync"); if (!byId("workspace").hidden) render(); }
    catch (error) { state = undefined; notice(friendlyError(error), true); }
    finally { busy = false; controls(); if (!sheet.hidden && !sheet.contains(document.activeElement)) byId("close-sync").focus(); }
  }
  async function change(operation) {
    busy = true; controls();
    try { await operation(); await refresh(); }
    catch (error) { notice(friendlyError(error), true); }
    finally { busy = false; controls(); if (!sheet.hidden && !sheet.contains(document.activeElement)) byId("close-sync").focus(); }
  }
  openButton.addEventListener("click", () => { sheet.hidden = false; byId("close-sync").focus(); void refresh(); });
  byId("close-sync").addEventListener("click", close); byId("refresh-sync").addEventListener("click", () => void refresh());
  byId("toggle-sync").addEventListener("click", async () => {
    if (!state || !await confirmAction(state.enabled ? "Disable fingerprint sync?" : "Enable fingerprint sync?", state.enabled ? "Stop transfers from this kiosk. Existing reader fingerprints remain." : "Newly enrolled fingerprint templates may leave this reader as encrypted messages for approved kiosks. Enable only with your organization's permission.")) return;
    await change(() => call("/fingerprint-sync", { method: "PATCH", body: JSON.stringify({ enabled: !state.enabled }) }));
  });
  sheet.addEventListener("keydown", event => {
    if (!byId("confirm-sheet").hidden) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const buttons = [...sheet.querySelectorAll("button:not(:disabled)")];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
})();
`;
