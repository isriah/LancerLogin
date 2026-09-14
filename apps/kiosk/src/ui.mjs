export const kioskHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#101218"><title>LancerLogin kiosk</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/network.css"></head>
<body><main id="kiosk" class="kiosk-shell kiosk-shell-ready" aria-live="polite">
  <button id="network-status" class="network-status" type="button" aria-label="Network status" title="Network status"><span class="network-icon" aria-hidden="true"><i></i><i></i><i></i></span></button>
  <header id="brand" class="kiosk-brand" title="Hold for fingerprint maintenance"><span id="brand-name">LancerLogin</span><span id="brand-logo-frame" class="adaptive-logo backdrop-none" hidden><img id="brand-logo" alt=""></span><strong id="brand-subtitle"></strong></header>
  <section id="display" class="scan-panel scan-panel-ready" aria-labelledby="display-message"><div class="reader-mark" aria-hidden="true"></div><p id="display-kicker" hidden>Ready</p><h1 id="display-message">Place finger on reader</h1><p id="display-name" hidden></p><p id="display-detail">Attendance kiosk ready</p><p id="display-meeting" hidden></p></section>
  <footer class="debug-status"><span id="reader-status">Reader starting…</span><span id="queue-status">No scans waiting</span><span id="uptime">Uptime 0m</span></footer>
</main>
<section id="pairing-panel" class="pairing-overlay" aria-labelledby="pair-title">
  <form id="pair-form" class="pairing-card"><p class="eyebrow">One-time setup</p><h2 id="pair-title">Pair this kiosk</h2><p>Create a pairing key on the Kiosks page of your LancerLogin dashboard, then paste it here.</p><label for="pairing-key">One-time pairing key</label><textarea id="pairing-key" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea><button type="submit">Pair kiosk</button><p id="pair-result" role="status">Waiting for a pairing key.</p></form>
</section><script type="module" src="/app.js"></script><script type="module" src="/network.js"></script><script type="module" src="/recovery.js"></script></body></html>`;

export const kioskStyles = `:root{--page-bg:#f4f6f8;--surface-bg:#424a53;--text-color:#17202a;--on-surface-color:#ffffff;--on-primary-color:#ffffff;--muted-color:color-mix(in srgb,var(--on-surface-color),var(--surface-bg) 22%);--border-color:#d8dee6;--primary:#b80100;--secondary:#f2c14e;--primary-color:var(--primary);--accent-color:var(--secondary);--processing-sweep-color:#2388ff;--duplicate-flash-color:#8b5cf6;--success-pulse-color:#178f4f;--failure-flash-color:#ff2a24;--network-online-color:#33d17a;--network-queued-color:#f2c14e;--network-offline-color:#ff5b57;--network-unknown-color:color-mix(in srgb,var(--on-surface-color),var(--surface-bg) 42%);--idle-mark-color:color-mix(in srgb,var(--surface-bg),#000000 34%);--primary-dark:color-mix(in srgb,var(--primary-color),#000000 26%);--accent-dark:color-mix(in srgb,var(--accent-color),#000000 38%);--danger-color:color-mix(in srgb,var(--accent-color),#8b0000 58%);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--on-surface-color);background:var(--surface-bg);color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--surface-bg)}button,textarea{font:inherit}.kiosk-shell{position:relative;isolation:isolate;width:100%;height:100vh;min-height:100%;display:grid;grid-template-rows:auto 1fr auto;align-items:center;justify-items:center;padding:32px;overflow:hidden;background:var(--surface-bg)}.kiosk-shell::before{content:"";position:absolute;z-index:0;inset:0;pointer-events:none}.kiosk-shell>*{position:relative;z-index:1}.kiosk-shell-processing::before{width:62%;inset:0 auto 0 0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--processing-sweep-color),transparent 22%),transparent);transform:translateX(-105%);animation:processing-sweep 900ms ease-out 1}.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-enroll_success{animation:success-pulse 1100ms ease-out 2}.kiosk-shell-duplicate{animation:duplicate-flash 420ms ease-in-out 3}.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_failure{animation:failure-flash 360ms ease-in-out 4}.network-status{position:fixed;z-index:3;top:14px;left:14px;width:84px;height:84px;display:grid;place-items:center;border:0;background:transparent;color:var(--network-unknown-color);padding:0;cursor:default;touch-action:none;user-select:none;-webkit-user-select:none;line-height:1;font-size:48px}.network-status span{display:block;width:48px;height:48px;border:6px solid currentColor;border-radius:50%;font-size:0}.network-status span::after{content:"";position:absolute;right:8px;bottom:8px;width:13px;height:13px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px var(--surface-bg)}.network-status.online{color:var(--network-online-color)}.network-status.offline{color:var(--network-offline-color);animation:network-offline-pulse 900ms ease-in-out infinite}.kiosk-brand{width:min(720px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(76px,auto) minmax(0,1fr);align-items:center;gap:16px;color:var(--muted-color);font-size:21px;margin-bottom:20px;border-radius:12px;outline:0 solid transparent;transition:outline-color 180ms ease,outline-width 180ms ease}.kiosk-brand.holding{outline:6px solid color-mix(in srgb,var(--accent-color),transparent 28%);outline-offset:8px}.kiosk-brand #brand-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.kiosk-brand strong{color:var(--on-surface-color);font-size:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.adaptive-logo{height:60px;min-width:76px;max-width:180px;display:grid;place-items:center;padding:6px;border:1px solid rgb(255 255 255 / 32%);border-radius:12px}.adaptive-logo img{max-width:100%;max-height:100%;display:block;object-fit:contain}.adaptive-logo.backdrop-light{background:#fff}.adaptive-logo.backdrop-dark{background:#111315}.adaptive-logo.backdrop-none{padding:0;border-color:transparent;background:transparent}.scan-panel{width:min(720px,100%);min-height:320px;display:grid;justify-items:center;align-content:center;gap:24px;background:transparent;border:0;text-align:center}.reader-mark{width:132px;height:132px;border-radius:50%;border:14px solid var(--idle-mark-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-welcome .reader-mark,.scan-panel-goodbye .reader-mark,.scan-panel-enroll_scan_accepted .reader-mark,.scan-panel-enroll_success .reader-mark{border-color:var(--primary-dark);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-processing .reader-mark,.scan-panel-enroll_wait_first .reader-mark,.scan-panel-enroll_wait_second .reader-mark{border-color:var(--processing-sweep-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-duplicate .reader-mark{border-color:var(--duplicate-flash-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-offline .reader-mark{border-color:var(--success-pulse-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-rejected .reader-mark,.scan-panel-unknown .reader-mark,.scan-panel-reader_offline .reader-mark,.scan-panel-enroll_failure .reader-mark{border-color:var(--danger-color);box-shadow:inset 0 0 0 18px var(--accent-color)}h1{margin:0;font-size:52px;line-height:1.08;font-weight:800}p{margin:0;font-size:26px;color:var(--muted-color)}#display-name{color:var(--on-surface-color);font-size:32px;font-weight:800}#display-meeting{font-size:22px;color:var(--accent-color);font-weight:800}.debug-status{width:min(720px,100%);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;margin-top:20px;color:var(--muted-color);font-size:19px}.pairing-overlay{position:fixed;z-index:10;inset:0;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--surface-bg),#000 22%)}.pairing-overlay[hidden]{display:none}.pairing-card{width:min(680px,100%);display:grid;gap:14px;padding:30px;border-radius:22px;background:var(--page-bg);color:var(--text-color);box-shadow:0 18px 60px rgb(0 0 0 / 35%)}.pairing-card h2,.pairing-card p{margin:0}.pairing-card h2{font-size:38px}.eyebrow{color:color-mix(in srgb,var(--text-color),var(--page-bg) 35%);font-size:17px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.pairing-card label{font-weight:800}.pairing-card textarea{width:100%;min-height:116px;padding:12px;border:2px solid var(--border-color);border-radius:12px;background:#fff;color:var(--text-color);resize:none}.pairing-card button{min-height:58px;border:0;border-radius:12px;background:var(--primary-color);color:var(--on-primary-color);font-weight:900}.pairing-card textarea:focus-visible,.pairing-card button:focus-visible,.network-status:focus-visible{outline:4px solid #f7c948;outline-offset:3px}@media(max-height:520px){.kiosk-shell{padding:20px 32px}.kiosk-brand{font-size:19px;margin-bottom:10px}.kiosk-brand strong{font-size:21px}.adaptive-logo{height:54px;min-width:68px}.scan-panel{min-height:286px;gap:16px}.reader-mark{width:108px;height:108px;border-width:12px;box-shadow:inset 0 0 0 15px var(--accent-color)}h1{font-size:44px}p{font-size:23px}.debug-status{margin-top:10px;font-size:17px}.network-status{top:10px;left:10px;width:68px;height:68px}.network-status span{width:42px;height:42px}}@keyframes processing-sweep{from{transform:translateX(-105%)}to{transform:translateX(265%)}}@keyframes duplicate-flash{0%,100%{background:var(--surface-bg)}50%{background:var(--duplicate-flash-color)}}@keyframes success-pulse{0%,100%{background:var(--surface-bg)}45%{background:var(--success-pulse-color)}}@keyframes failure-flash{0%,100%{background:var(--surface-bg)}50%{background:var(--failure-flash-color)}}@keyframes network-offline-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.46;transform:scale(.88)}}@media(prefers-reduced-motion:reduce){.kiosk-shell-processing::before,.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-duplicate,.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_success,.kiosk-shell-enroll_failure,.network-status.offline{animation:none}.kiosk-shell-processing{box-shadow:inset 0 0 0 12px var(--processing-sweep-color)}.kiosk-shell-duplicate{box-shadow:inset 0 0 0 12px var(--duplicate-flash-color)}.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-enroll_success{box-shadow:inset 0 0 0 12px var(--success-pulse-color)}.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_failure{box-shadow:inset 0 0 0 12px var(--failure-flash-color)}.network-status.offline{opacity:1;transform:none}}`;

export const kioskStatusStyles = `.network-status .network-icon{position:relative;display:flex;width:42px;height:42px;align-items:end;justify-content:center;gap:4px;border:0;border-radius:0;font-size:inherit}.network-status .network-icon::after{display:none}.network-status .network-icon i{display:block;width:9px;border-radius:2px 2px 0 0;background:currentColor}.network-status .network-icon i:nth-child(1){height:14px}.network-status .network-icon i:nth-child(2){height:25px}.network-status .network-icon i:nth-child(3){height:36px}.network-status.ethernet .network-icon{display:block;width:43px;height:35px;border:4px solid currentColor;border-radius:4px}.network-status.ethernet .network-icon i{position:absolute;bottom:-10px;width:4px;height:12px;border-radius:0;background:currentColor}.network-status.ethernet .network-icon i:nth-child(1){left:8px}.network-status.ethernet .network-icon i:nth-child(2){left:16px}.network-status.ethernet .network-icon i:nth-child(3){left:24px}`;

export function kioskReaderStatus({ readerOnline = false, releaseVersion = "development" } = {}) {
  const version = typeof releaseVersion === "string" && releaseVersion.trim() ? releaseVersion.trim() : "development";
  return readerOnline ? `LancerLogin ${version}` : "Fingerprint reader offline";
}

export const kioskApp = `
${kioskReaderStatus.toString()}
const byId = (id) => document.getElementById(id);
let lastLogoSource = "";

async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { "content-type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function statusClass(display) {
  return display.id || display.tone || "ready";
}

function resolveBackdrop(backdrop, automatic) {
  return backdrop === "auto" ? automatic : backdrop || "none";
}

function setLogoBackdrop(backdrop) {
  const frame = byId("brand-logo-frame");
  frame.className = "adaptive-logo backdrop-" + backdrop;
}

function adaptLogo(src, requestedBackdrop, organizationName) {
  const frame = byId("brand-logo-frame");
  const logo = byId("brand-logo");
  frame.hidden = !src;
  if (!src) {
    lastLogoSource = "";
    logo.removeAttribute("src");
    setLogoBackdrop("none");
    return;
  }
  logo.alt = (organizationName || "Organization") + " logo";
  if (src === lastLogoSource) {
    setLogoBackdrop(resolveBackdrop(requestedBackdrop, frame.dataset.automaticBackdrop || "light"));
    return;
  }
  lastLogoSource = src;
  logo.src = src;
  setLogoBackdrop(resolveBackdrop(requestedBackdrop, "light"));
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width; let right = 0; let top = canvas.height; let bottom = 0; let light = 0; let samples = 0;
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const alpha = pixels.data[offset + 3];
      if (alpha < 18) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      light += (pixels.data[offset] * 0.2126 + pixels.data[offset + 1] * 0.7152 + pixels.data[offset + 2] * 0.0722) / 255;
      samples += 1;
    }
    if (lastLogoSource !== src) return;
    if (samples && right >= left && bottom >= top) {
      const cropped = document.createElement("canvas");
      cropped.width = right - left + 1;
      cropped.height = bottom - top + 1;
      cropped.getContext("2d")?.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
      logo.src = cropped.toDataURL("image/png");
    }
    const automatic = samples && light / samples > 0.58 ? "dark" : "light";
    frame.dataset.automaticBackdrop = automatic;
    setLogoBackdrop(resolveBackdrop(requestedBackdrop, automatic));
  };
  image.src = src;
}

function render(value) {
  const display = value.display || {};
  const brand = value.branding || {};
  const status = statusClass(display);
  byId("kiosk").className = "kiosk-shell kiosk-shell-" + status;
  byId("display").className = "scan-panel scan-panel-" + status;
  if (/^#[0-9a-f]{6}$/i.test(brand.primaryColor || "")) {
    document.documentElement.style.setProperty("--primary", brand.primaryColor);
    document.documentElement.style.setProperty("--primary-color", brand.primaryColor);
  }
  if (/^#[0-9a-f]{6}$/i.test(brand.secondaryColor || "")) {
    document.documentElement.style.setProperty("--secondary", brand.secondaryColor);
    document.documentElement.style.setProperty("--accent-color", brand.secondaryColor);
  }
  byId("brand-name").textContent = brand.organizationName || "LancerLogin";
  byId("brand-subtitle").textContent = brand.subtitle || "";
  adaptLogo(brand.logoData, brand.logoBackdrop || "auto", brand.organizationName);
  byId("display-kicker").textContent = display.id === "ready" ? "Ready" : display.id === "processing" ? "Scanning" : "Attendance";
  byId("display-message").textContent = display.message || "Place finger on reader";
  byId("display-detail").textContent = display.detail || "Attendance kiosk ready";
  const name = byId("display-name");
  name.textContent = display.name || "";
  name.hidden = !display.name;
  const meeting = byId("display-meeting");
  meeting.textContent = display.meetingTitle || "";
  meeting.hidden = !display.meetingTitle;
  byId("reader-status").textContent = kioskReaderStatus(value);
  byId("queue-status").textContent = value.pendingEvents ? value.pendingEvents + " scan" + (value.pendingEvents === 1 ? "" : "s") + " waiting" : "No scans waiting";
  uptime(value.uptimeSeconds);
  const network = byId("network-status");
  network.className = "network-status " + (value.cloudOnline ? "online" : "offline") + " " + (value.networkType === "ethernet" ? "ethernet" : "wifi");
  network.title = (value.networkType === "ethernet" ? "Ethernet" : "Wi-Fi") + (value.cloudOnline ? " and cloud connected" : " connection or cloud unavailable");
  if (value.kioskName) document.title = value.kioskName + " · LancerLogin";
}

async function refresh() {
  try {
    const health = await request("/health");
    byId("pairing-panel").hidden = health.paired;
    if (!health.paired) return;
    try {
      render(await request("/display-state"));
    } catch (error) {
      if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
        byId("display-message").textContent = "Continue on the kiosk display";
        byId("display-detail").textContent = "Pairing is complete. Attendance controls remain private to this device.";
      } else throw error;
    }
  } catch {
    byId("display-message").textContent = "Kiosk service unavailable";
    byId("display-detail").textContent = "Restart the LancerLogin kiosk service";
  }
}

byId("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  byId("pair-result").textContent = "Pairing securely…";
  try {
    const value = await request("/pair", { method: "POST", body: JSON.stringify({ pairingKey: byId("pairing-key").value.trim() }) });
    byId("pair-result").textContent = "Paired " + value.kioskName + ". Continue on the kiosk display.";
    byId("pairing-key").value = "";
    await refresh();
  } catch (error) {
    byId("pair-result").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

let maintenanceHold;
function clearMaintenanceHold() {
  clearTimeout(maintenanceHold);
  byId("brand").classList.remove("holding");
}
byId("brand").addEventListener("pointerdown", () => {
  byId("brand").classList.add("holding");
  maintenanceHold = setTimeout(() => { location.href = "/maintenance"; }, 3000);
});
for (const event of ["pointerup", "pointercancel", "pointerleave"]) byId("brand").addEventListener(event, clearMaintenanceHold);
function uptime(seconds) { const total = Math.max(0, Number(seconds) || 0); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); byId("uptime").textContent = "Uptime " + (hours ? hours + "h " : "") + minutes + "m"; }
uptime(0);
await refresh();
setInterval(refresh, 500);
`;
