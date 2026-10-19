import { fingerprintDiagnosticMessages } from "./fingerprint-diagnostics.mjs";

export const fingerprintSyncStyles = `
.sync-reader-heading{flex-wrap:wrap}.sync-sheet{z-index:19}.sync-panel{grid-template-rows:auto minmax(0,1fr);width:min(720px,100%);max-height:92vh}
.sync-content{min-height:0;overflow:auto;display:grid;gap:12px;touch-action:pan-y}.sync-content p{margin:0}.sync-content code{display:block;overflow-wrap:anywhere;white-space:normal;font-size:16px;line-height:1.5;color:var(--text)}
.sync-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.sync-peers,#sync-diagnostics{display:grid;gap:10px}.sync-peer{display:grid;gap:8px;border:1px solid var(--line);border-radius:8px;padding:10px}#fingerprint-sync-sheet button{min-height:48px!important}.sync-fingerprint{padding:8px;background:var(--surface-bg);border-radius:8px}
`;

// Appended to the maintenance module so requests share its PIN session and lock
// handling. Remote names/fingerprints are inserted as text, never HTML.
export const fingerprintSyncApp = `
(() => {
  const openButton = document.createElement("button"); openButton.id = "open-fingerprint-sync";
  openButton.type = "button"; openButton.textContent = "Sync"; openButton.setAttribute("aria-label", "Fingerprint sync");
  const heading = byId("test-reader").parentElement; heading.classList.add("sync-reader-heading"); heading.append(openButton);
  heading.querySelector("p").textContent = "Local fingerprints and encrypted cloud sync.";
  const sheet = document.createElement("section"); sheet.id = "fingerprint-sync-sheet"; sheet.className = "sheet sync-sheet";
  sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "sync-title");
  sheet.innerHTML = '<div class="sheet-panel card sync-panel"><div class="card-heading"><h2 id="sync-title">Cloud fingerprint sync</h2><button type="button" id="close-sync">Close</button></div><div class="sync-content"><p id="sync-message" role="status"></p><div class="sync-actions"><button type="button" id="refresh-sync">Refresh</button></div><p>Cloud storage is managed on the dashboard. Existing reader copies remain available offline.</p><section id="sync-diagnostics" aria-label="Fingerprint sync health"></section></div></div>';
  byId("maintenance-main").append(sheet);
  const diagnosticMessages = ${JSON.stringify(fingerprintDiagnosticMessages)};
  function renderDiagnostics(value) {
    const target = byId("sync-diagnostics"); target.replaceChildren();
    for (const [component, label] of [["reset", "Reset recovery"], ["vault", "Cloud storage"]]) {
      const entry = value?.[component];
      const row = document.createElement("div"); row.className = "sync-peer";
      const title = document.createElement("strong"); title.textContent = label;
      const message = document.createElement("p"); message.textContent = Object.hasOwn(diagnosticMessages, entry?.reasonCode) ? diagnosticMessages[entry.reasonCode] : diagnosticMessages.unavailable;
      row.append(title, message);
      if (component === "vault") {
        for (const [key, label] of [["pendingUploads", "Uploads waiting"], ["pendingDownloads", "Downloads waiting"], ["reviewRequired", "Records needing attention"], ["locallyRemoved", "Locally suppressed deliveries"]]) {
          if (Number.isSafeInteger(entry?.[key]) && entry[key] >= 0) {
            const count = document.createElement("p"); count.textContent = label + ": " + Math.min(entry[key], 1000000); row.append(count);
          }
        }
      }
      if (Number.isSafeInteger(entry?.missingIdentityMappings) && entry.missingIdentityMappings > 0) {
        const count = document.createElement("p"); count.textContent = component === "vault" ? Math.min(entry.missingIdentityMappings, 1000000) + " mapping(s) are not eligible for cloud upload." : Math.min(entry.missingIdentityMappings, 1000000) + " enrollment(s) need fresh enrollment with a verified roster identity."; row.append(count);
      }
      if (Number.isSafeInteger(entry?.unshareableMappings) && entry.unshareableMappings > (entry.missingIdentityMappings || 0)) {
        const count = document.createElement("p"); count.textContent = Math.min(entry.unshareableMappings, 1000000) + " mapping(s) cannot currently be shared. Review membership and mappings."; row.append(count);
      }
      if (typeof entry?.lastSuccessAt === "string" && Number.isFinite(Date.parse(entry.lastSuccessAt))) {
        const checked = document.createElement("p"); checked.textContent = "Last successful check: " + new Date(entry.lastSuccessAt).toLocaleString() + ". This does not confirm every fingerprint was delivered."; row.append(checked);
      }
      target.append(row);
    }
  }
  function close() { sheet.hidden = true; openButton.focus(); }
  async function refresh() {
    byId("refresh-sync").disabled = true;
    byId("sync-message").textContent = "Checking cloud sync...";
    try {
      const diagnostics = await call("/fingerprint-diagnostics");
      if (byId("workspace").hidden || sheet.hidden) return;
      renderDiagnostics(diagnostics);
      byId("sync-message").textContent = "Cloud sync and reset recovery status";
    } catch { renderDiagnostics(undefined); byId("sync-message").textContent = "Sync status is unavailable. Refresh to retry."; }
    finally { byId("refresh-sync").disabled = false; }
  }
  openButton.addEventListener("click", () => { sheet.hidden = false; byId("close-sync").focus(); void refresh(); });
  byId("close-sync").addEventListener("click", close);
  byId("refresh-sync").addEventListener("click", () => void refresh());
  sheet.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const buttons = [...sheet.querySelectorAll("button:not(:disabled)")], first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
})();
`;
