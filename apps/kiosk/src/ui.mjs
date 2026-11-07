export const kioskHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#101218"><title>LancerLogin kiosk</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/network.css"></head>
<body><main id="kiosk" class="kiosk-shell kiosk-shell-ready" aria-live="polite">
  <button id="network-status" class="network-status" type="button" aria-label="Network status" title="Network status"><span class="network-icon" aria-hidden="true"><i></i><i></i><i></i></span></button>
  <header id="brand" class="kiosk-brand" role="button" tabindex="0" aria-label="Authentication maintenance" title="Hold for authentication maintenance"><span id="brand-name">LancerLogin</span><span id="brand-logo-frame" class="adaptive-logo backdrop-none" hidden><img id="brand-logo" alt=""></span><strong id="brand-subtitle"></strong></header>
  <section id="display" class="scan-panel scan-panel-ready" aria-labelledby="display-message"><div class="reader-mark" aria-hidden="true"></div><p id="display-kicker" hidden>Ready</p><h1 id="display-message">Starting attendance...</h1><p id="display-name" hidden></p><p id="display-detail">Connecting to the local service</p><p id="display-meeting" hidden></p><p id="display-notice" hidden></p><form id="identity-entry" class="identity-entry" hidden><label id="identity-label" for="identity-value">Credential</label><input id="identity-value" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="none" maxlength="256" required><div id="member-results" class="member-results" hidden aria-live="polite"></div><div id="member-id-keyboard" class="member-id-keyboard" hidden aria-label="Member ID keyboard"></div><div id="member-id-keypad" class="member-id-keypad" hidden aria-label="Member ID keypad"></div><button class="identity-submit" type="submit">Continue</button></form><div id="member-flow" class="member-flow" hidden aria-live="polite"><div class="member-flow-text"><h2 id="member-flow-title"></h2><p id="member-flow-name" hidden></p><p id="member-flow-detail" hidden></p><p id="member-flow-dots" class="member-flow-dots" aria-label="PIN digits entered" hidden></p><p id="member-flow-note" hidden></p><div id="member-flow-actions" class="member-flow-actions"></div></div><div id="member-flow-keypad" class="member-flow-keypad" aria-label="PIN keypad" hidden></div></div></section>
  <aside id="attendance-warning" role="status" hidden></aside>
  <footer class="debug-status"><span class="kiosk-identity"><strong id="kiosk-name" hidden></strong><span id="kiosk-version"></span><span id="reader-status">Reader starting…</span></span><span id="queue-status">No scans waiting</span><span id="uptime">Uptime 0m</span></footer>
</main>
<section id="pairing-panel" class="pairing-overlay" aria-labelledby="pair-title">
  <form id="pair-form" class="pairing-card"><div class="pairing-intro"><p class="eyebrow">One-time setup</p><h2 id="pair-title">Pair this kiosk</h2><p class="pairing-instructions">Create a pairing key on the Kiosks page of your LancerLogin dashboard, then paste it here.</p><p id="setup-code-hint" hidden></p></div><div class="pairing-fields"><label for="pairing-key">One-time pairing key</label><textarea id="pairing-key" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" required></textarea><label id="setup-code-label" for="setup-code" hidden>Setup code shown on the kiosk screen</label><input id="setup-code" inputmode="numeric" maxlength="7" autocomplete="off" hidden><button type="submit">Pair kiosk</button><p id="pair-result" role="status">Waiting for a pairing key.</p></div></form>
</section><script type="module" src="/app.js"></script><script type="module" src="/network.js"></script><script type="module" src="/recovery.js"></script></body></html>`;

export const kioskStyles = `:root{--page-bg:#f4f6f8;--surface-bg:#424a53;--text-color:#17202a;--on-surface-color:#ffffff;--on-primary-color:#ffffff;--muted-color:color-mix(in srgb,var(--on-surface-color),var(--surface-bg) 22%);--border-color:#d8dee6;--primary:#b80100;--secondary:#f2c14e;--primary-color:var(--primary);--accent-color:var(--secondary);--processing-sweep-color:#2388ff;--duplicate-flash-color:#8b5cf6;--success-pulse-color:#178f4f;--failure-flash-color:#ff2a24;--network-online-color:#33d17a;--network-queued-color:#f2c14e;--network-offline-color:#ff5b57;--network-unknown-color:color-mix(in srgb,var(--on-surface-color),var(--surface-bg) 42%);--idle-mark-color:color-mix(in srgb,var(--surface-bg),#000000 34%);--primary-dark:color-mix(in srgb,var(--primary-color),#000000 26%);--accent-dark:color-mix(in srgb,var(--accent-color),#000000 38%);--danger-color:color-mix(in srgb,var(--accent-color),#8b0000 58%);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--on-surface-color);background:var(--surface-bg);color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--surface-bg)}button,textarea,input{font:inherit}.kiosk-shell{position:relative;isolation:isolate;width:100%;height:100vh;min-height:100%;display:grid;grid-template-rows:auto 1fr auto;align-items:center;justify-items:center;padding:32px;overflow:hidden;background:var(--surface-bg)}.kiosk-shell::before{content:"";position:absolute;z-index:0;inset:0;pointer-events:none}.kiosk-shell>*{position:relative;z-index:1}.kiosk-shell-processing::before{width:62%;inset:0 auto 0 0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--processing-sweep-color),transparent 22%),transparent);transform:translateX(-105%);animation:processing-sweep 900ms ease-out 1}.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-enroll_success{animation:success-pulse 1100ms ease-out 2}.kiosk-shell-duplicate{animation:duplicate-flash 420ms ease-in-out 3}.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_failure{animation:failure-flash 360ms ease-in-out 4}.network-status{position:fixed;z-index:3;top:14px;left:14px;width:84px;height:84px;display:grid;place-items:center;border:0;background:transparent;color:var(--network-unknown-color);padding:0;cursor:default;touch-action:none;user-select:none;-webkit-user-select:none;line-height:1;font-size:48px}.network-status span{display:block;width:48px;height:48px;border:6px solid currentColor;border-radius:50%;font-size:0}.network-status span::after{content:"";position:absolute;right:8px;bottom:8px;width:13px;height:13px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px var(--surface-bg)}.network-status.online{color:var(--network-online-color)}.network-status.offline{color:var(--network-offline-color);animation:network-offline-pulse 900ms ease-in-out infinite}.kiosk-brand{width:min(720px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(76px,auto) minmax(0,1fr);align-items:center;gap:16px;color:var(--muted-color);font-size:21px;margin-bottom:20px;border-radius:12px;outline:0 solid transparent;transition:outline-color 180ms ease,outline-width 180ms ease}.kiosk-brand.holding{outline:6px solid color-mix(in srgb,var(--accent-color),transparent 28%);outline-offset:8px}.kiosk-brand #brand-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}.kiosk-brand strong{color:var(--on-surface-color);font-size:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.adaptive-logo{height:60px;min-width:76px;max-width:180px;display:grid;place-items:center;padding:6px;border:1px solid rgb(255 255 255 / 32%);border-radius:12px}.adaptive-logo img{max-width:100%;max-height:100%;display:block;object-fit:contain}.adaptive-logo.backdrop-light{background:#fff}.adaptive-logo.backdrop-dark{background:#111315}.adaptive-logo.backdrop-none{padding:0;border-color:transparent;background:transparent}.scan-panel{width:min(720px,100%);min-height:320px;display:grid;justify-items:center;align-content:center;gap:24px;background:transparent;border:0;text-align:center}.reader-mark{width:132px;height:132px;border-radius:50%;border:14px solid var(--idle-mark-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-identity{gap:8px}.scan-panel-identity .reader-mark{display:none}.scan-panel-welcome .reader-mark,.scan-panel-goodbye .reader-mark,.scan-panel-enroll_scan_accepted .reader-mark,.scan-panel-enroll_success .reader-mark{border-color:var(--primary-dark);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-processing .reader-mark,.scan-panel-enroll_wait_first .reader-mark,.scan-panel-enroll_wait_second .reader-mark{border-color:var(--processing-sweep-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-duplicate .reader-mark{border-color:var(--duplicate-flash-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-offline .reader-mark{border-color:var(--success-pulse-color);box-shadow:inset 0 0 0 18px var(--accent-color)}.scan-panel-rejected .reader-mark,.scan-panel-unknown .reader-mark,.scan-panel-reader_offline .reader-mark,.scan-panel-enroll_failure .reader-mark{border-color:var(--danger-color);box-shadow:inset 0 0 0 18px var(--accent-color)}h1{margin:0;font-size:52px;line-height:1.08;font-weight:800}p{margin:0;font-size:26px;color:var(--muted-color)}#display-name{color:var(--on-surface-color);font-size:32px;font-weight:800}#display-meeting{font-size:22px;color:var(--accent-color);font-weight:800}.identity-entry{width:min(620px,100%);display:grid;grid-template-columns:1fr auto;gap:8px;text-align:left}.identity-entry label{grid-column:1/-1;font-size:17px;font-weight:800}.identity-entry input{min-height:48px;min-width:0;padding:8px 12px;border:2px solid var(--border-color);border-radius:10px;background:#fff;color:var(--text-color)}.identity-submit,.member-id-keyboard button{min-height:44px;border:1px solid rgb(255 255 255 / 32%);border-radius:8px;background:var(--primary-color);color:var(--on-primary-color);font-weight:900}.identity-submit{padding:8px 18px}.member-id-keyboard{grid-column:1/-1;display:grid;gap:4px}.member-id-keyboard-row{display:flex;justify-content:center;gap:4px}.member-id-keyboard button{width:48px;padding:4px;background:color-mix(in srgb,var(--surface-bg),#fff 12%)}.member-id-keyboard button.wide{width:auto;min-width:96px}.identity-entry input:focus-visible,.identity-submit:focus-visible,.member-id-keyboard button:focus-visible{outline:4px solid #f7c948;outline-offset:2px}.debug-status{width:min(720px,100%);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;margin-top:20px;color:var(--muted-color);font-size:19px}.kiosk-identity{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;max-width:100%;overflow-wrap:anywhere}#kiosk-name{color:var(--on-surface-color)}.pairing-overlay{position:fixed;z-index:10;inset:0;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--surface-bg),#000 22%)}.pairing-overlay[hidden]{display:none}.pairing-card{width:min(680px,100%);display:grid;gap:14px;padding:30px;border-radius:22px;background:var(--page-bg);color:var(--text-color);box-shadow:0 18px 60px rgb(0 0 0 / 35%)}.pairing-card h2,.pairing-card p{margin:0}.pairing-card h2{font-size:38px}.eyebrow{color:color-mix(in srgb,var(--text-color),var(--page-bg) 35%);font-size:17px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.pairing-card label{font-weight:800}.pairing-card textarea{width:100%;min-height:116px;padding:12px;border:2px solid var(--border-color);border-radius:12px;background:#fff;color:var(--text-color);resize:none}.pairing-card button{min-height:58px;border:0;border-radius:12px;background:var(--primary-color);color:var(--on-primary-color);font-weight:900}.pairing-card textarea:focus-visible,.pairing-card button:focus-visible,.network-status:focus-visible{outline:4px solid #f7c948;outline-offset:3px}@media(max-height:520px){.kiosk-shell{padding:12px 32px}.kiosk-brand{font-size:19px;margin-bottom:4px}.kiosk-brand strong{font-size:21px}.adaptive-logo{height:48px;min-width:62px}.scan-panel{min-height:286px;gap:12px}.scan-panel-identity{gap:4px}.scan-panel-identity h1{font-size:36px}.scan-panel-identity p{font-size:19px}.reader-mark{width:108px;height:108px;border-width:12px;box-shadow:inset 0 0 0 15px var(--accent-color)}h1{font-size:44px}p{font-size:23px}.member-id-keyboard button{min-height:40px;width:44px}.debug-status{margin-top:4px;font-size:17px}.network-status{top:10px;left:10px;width:68px;height:68px}.network-status span{width:42px;height:42px}}@keyframes processing-sweep{from{transform:translateX(-105%)}to{transform:translateX(265%)}}@keyframes duplicate-flash{0%,100%{background:var(--surface-bg)}50%{background:var(--duplicate-flash-color)}}@keyframes success-pulse{0%,100%{background:var(--surface-bg)}45%{background:var(--success-pulse-color)}}@keyframes failure-flash{0%,100%{background:var(--surface-bg)}50%{background:var(--failure-flash-color)}}@keyframes network-offline-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.46;transform:scale(.88)}}@media(prefers-reduced-motion:reduce){.kiosk-shell-processing::before,.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-duplicate,.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_success,.kiosk-shell-enroll_failure,.network-status.offline{animation:none}.kiosk-shell-processing{box-shadow:inset 0 0 0 12px var(--processing-sweep-color)}.kiosk-shell-duplicate{box-shadow:inset 0 0 0 12px var(--duplicate-flash-color)}.kiosk-shell-welcome,.kiosk-shell-goodbye,.kiosk-shell-offline,.kiosk-shell-enroll_success{box-shadow:inset 0 0 0 12px var(--success-pulse-color)}.kiosk-shell-rejected,.kiosk-shell-unknown,.kiosk-shell-enroll_failure{box-shadow:inset 0 0 0 12px var(--failure-flash-color)}.network-status.offline{opacity:1;transform:none}}.kiosk-shell{grid-template-columns:minmax(0,1fr)}.debug-status{width:100%;min-width:0;max-width:100%;flex-wrap:nowrap;gap:8px;white-space:nowrap;font-size:17px}.debug-status>span{flex-shrink:0}.debug-status>.kiosk-identity{flex:1 1 auto;min-width:0;display:flex;flex-wrap:nowrap;gap:8px;overflow:hidden}#kiosk-name{flex:1 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#kiosk-version,#reader-status{flex:0 0 auto}.kiosk-brand{touch-action:none;user-select:none;-webkit-user-select:none}.kiosk-brand:focus-visible{outline:3px solid var(--accent-color);outline-offset:4px}.presence-paused .reader-mark{display:none}#retry-attendance{min-height:56px;padding:12px 24px}.debug-status{width:calc(100% + 32px);max-width:none;gap:0;font-size:14px}.debug-status>.kiosk-identity{gap:0}#kiosk-name{min-width:128px;min-height:36px;display:block;line-height:34px;padding:0 8px;border:1px solid rgb(255 255 255 / 40%);border-radius:6px;background:color-mix(in srgb,var(--surface-bg),#fff 10%);font-size:17px}#kiosk-name[hidden]{display:none}#kiosk-version,#reader-status,#queue-status,#uptime{display:flex;align-items:center;min-height:36px;padding:0 4px;border-inline-start:1px solid rgb(255 255 255 / 35%)}#kiosk-version{max-width:340px;font-size:12px;overflow:hidden;text-overflow:ellipsis;display:block;line-height:36px}#uptime{padding-inline-end:0}.pairing-card input{min-height:52px;padding:8px 12px;border:2px solid var(--border-color);border-radius:12px;background:#fff;color:var(--text-color);font-size:24px;letter-spacing:.2em}.pairing-card input:focus-visible{outline:4px solid #f7c948;outline-offset:3px}.pairing-overlay{overflow:auto;place-items:start}.pairing-overlay>.pairing-card{margin:auto}.pairing-intro,.pairing-fields{display:grid;gap:14px;align-content:start;min-width:0}.pairing-card p:not(.eyebrow){color:color-mix(in srgb,var(--text-color),var(--page-bg) 18%)}#setup-code-hint{padding:12px 14px;border-left:6px solid var(--primary-color);border-radius:10px;background:#fff;color:var(--text-color);font-weight:700}#setup-code-hint strong{font-size:1.25em;font-weight:900;letter-spacing:.12em;white-space:nowrap}@media(max-height:520px){.pairing-overlay{padding:12px}.pairing-card{gap:10px 22px;padding:20px 22px;border-radius:18px}.pairing-intro,.pairing-fields{gap:8px}.eyebrow{font-size:14px}.pairing-card h2{font-size:30px;line-height:1.1}.pairing-card p{font-size:18px;line-height:1.3}.pairing-card textarea{min-height:92px;padding:10px}.pairing-card button{min-height:52px}.pairing-card input{min-height:46px;font-size:22px}#setup-code-hint{padding:10px 12px}}@media(max-height:520px) and (min-width:640px){.pairing-card{width:min(760px,100%);grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}}`;

export const kioskStatusStyles = `#display-notice{max-width:32ch;margin:8px auto 0;padding:6px 12px;border:2px solid var(--accent-color);border-radius:8px;font-size:18px;font-weight:700;line-height:1.3}.kiosk-shell-rescan{box-shadow:inset 0 0 0 12px var(--accent-color)}.scan-panel-rescan .reader-mark{border-color:var(--accent-color);box-shadow:inset 0 0 0 18px var(--accent-color)}#attendance-warning{position:absolute;bottom:58px;left:16px;right:16px;padding:8px 12px;border:2px solid #f2c14e;border-radius:8px;background:#292e39;color:#fff;text-align:center;font-size:14px;line-height:1.3}#attendance-warning[hidden]{display:none}.network-status .network-icon{position:relative;display:flex;width:42px;height:42px;align-items:end;justify-content:center;gap:4px;border:0;border-radius:0;font-size:inherit}.network-status .network-icon::after{display:none}.network-status .network-icon i{display:block;width:9px;border-radius:2px 2px 0 0;background:currentColor}.network-status .network-icon i:nth-child(1){height:14px}.network-status .network-icon i:nth-child(2){height:25px}.network-status .network-icon i:nth-child(3){height:36px}.network-status.ethernet .network-icon{display:block;width:43px;height:35px;border:4px solid currentColor;border-radius:4px}.network-status.ethernet .network-icon i{position:absolute;bottom:-10px;width:4px;height:12px;border-radius:0;background:currentColor}.network-status.ethernet .network-icon i:nth-child(1){left:8px}.network-status.ethernet .network-icon i:nth-child(2){left:16px}.network-status.ethernet .network-icon i:nth-child(3){left:24px}`;


// Member ID keypad, Member search results, and the confirm and PIN steps that replace the scan panel while they run.
const memberFlowStyles = `.member-id-keypad,.member-flow-keypad{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.member-id-keypad{grid-column:1/-1;grid-row:3;width:min(360px,100%);justify-self:center}.member-id-keypad button,.member-flow-keypad button,.member-flow-actions button,.member-results button{min-height:52px;border:1px solid rgb(255 255 255 / 32%);border-radius:10px;background:color-mix(in srgb,var(--surface-bg),#fff 12%);color:var(--on-surface-color);font-weight:900}.member-id-keypad button,.member-flow-keypad button{padding:4px;font-size:24px}.identity-entry.member-keypad .member-id-keyboard{display:none}.identity-entry.member-search{grid-template-columns:minmax(0,1fr) minmax(0,236px);column-gap:12px}.identity-entry.member-search label,.identity-entry.member-search input{grid-column:1}.identity-entry.member-search input{grid-row:2}.identity-entry.member-search .member-id-keyboard{grid-column:1;grid-row:3}.identity-entry.member-search .member-id-keyboard button{width:42px}.identity-entry.member-search .identity-submit{display:none}.member-results{grid-column:2;grid-row:1/4;display:grid;align-content:start;gap:6px;min-width:0;overflow:hidden}.member-results button{display:grid;min-height:44px;padding:4px 10px;text-align:left}.member-results button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px}.member-results button small{font-size:14px;color:var(--muted-color)}.member-results p{margin:0;font-size:16px}.scan-panel.member-flow-active>:not(#member-flow){display:none!important}.member-flow{width:min(720px,100%);display:grid;grid-template-columns:minmax(0,1fr);gap:12px 28px;align-items:center;text-align:center}.member-flow.with-keypad{grid-template-columns:minmax(0,1fr) minmax(0,290px);text-align:left}.member-flow-text{display:grid;gap:10px;justify-items:center;min-width:0}.member-flow.with-keypad .member-flow-text{justify-items:start}#member-flow-title{margin:0;font-size:42px;line-height:1.1;font-weight:800}#member-flow-name{color:var(--on-surface-color);font-size:30px;font-weight:800;overflow-wrap:anywhere}#member-flow-detail,#member-flow-note{font-size:21px}#member-flow-note{color:var(--accent-color);font-weight:700}.member-flow-dots{min-height:40px;color:var(--on-surface-color);font-size:32px;letter-spacing:.3em}.member-flow-actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:4px}.member-flow.with-keypad .member-flow-actions{justify-content:start}.member-flow-actions button{min-width:140px;padding:8px 22px;font-size:22px}.member-flow-actions button.primary{background:var(--primary-color);color:var(--on-primary-color)}.member-flow-actions button:disabled{opacity:.45}.member-flow-keypad button{min-height:58px}.member-id-keypad button:focus-visible,.member-flow-keypad button:focus-visible,.member-flow-actions button:focus-visible,.member-results button:focus-visible{outline:4px solid #f7c948;outline-offset:2px}@media(max-height:520px){#member-flow-title{font-size:34px}#member-flow-name{font-size:26px}#member-flow-detail,#member-flow-note{font-size:18px}.member-flow-text{gap:6px}.member-flow-keypad button{min-height:52px}.member-id-keypad button{min-height:46px}}`;
export const kioskIdentityStyles = `[hidden]{display:none!important}.identity-submit{grid-column:2;grid-row:2}.member-id-keyboard{grid-row:3}@media(max-height:520px){.scan-panel-identity #display-detail{display:none}.member-id-keyboard button{min-height:44px;width:44px}}` + memberFlowStyles;

export function kioskReaderStatus({ readerOnline = false, releaseVersion = "development", authenticationMethod = "fingerprint" } = {}) {
  const version = typeof releaseVersion === "string" && releaseVersion.trim() ? releaseVersion.trim() : "development";
  if (authenticationMethod === "fingerprint") return readerOnline ? `LancerLogin ${version}` : "Fingerprint reader offline";
  const label = authenticationMethod === "member_id" ? "Member ID" : String(authenticationMethod).toUpperCase();
  return readerOnline ? `LancerLogin ${version} · ${label} input selected` : `${label} input unavailable`;
}

export function kioskAttendanceNotice(value) {
  const clockPending = value.attendance?.clockPending ?? 0;
  return value.clock?.verified === false || clockPending ? "Clock needs confirmation. Open maintenance to confirm date and time, or reconnect to synchronize." : "";
}

function installHoldGesture(target, activate) {
  let hold, pointer;
  target.addEventListener("dragstart", event => event.preventDefault());
  const cancel = () => {
    clearTimeout(hold); hold = undefined;
    const previous = pointer; pointer = undefined;
    target.classList.remove("holding");
    if (previous && target.hasPointerCapture(previous.id)) target.releasePointerCapture(previous.id);
  };
  target.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || pointer) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    target.setPointerCapture(event.pointerId); target.classList.add("holding");
    hold = setTimeout(() => { cancel(); void activate(); }, 3000);
  });
  target.addEventListener("pointermove", event => {
    if (pointer && event.pointerId === pointer.id && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 24) cancel();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) target.addEventListener(name, cancel);
  window.addEventListener("blur", cancel);
  target.addEventListener("click", event => { if (event.detail === 0) { cancel(); void activate(); } });
  target.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) { event.preventDefault(); cancel(); void activate(); }
  });
}

export const kioskApp = `
import { createOperatorPresence } from "/operator-presence.js";
${installHoldGesture.toString()}
${kioskReaderStatus.toString()}
${kioskAttendanceNotice.toString()}
const byId = (id) => document.getElementById(id);
let lastLogoSource = "";
let lastAuthenticationMethod = "";
let lastEntryMode = "";
let identityEntryWasInteractive = false;
// Member ID kiosks: entry or search, Require PIN, and a keypad when every member ID is a number (from /display-state).
let memberLookup = "entry", requirePin = false, memberIdKeypad = false;
let memberFlow = { step: "entry" }, memberFlowGeneration = 0, memberFlowTimer, memberFlowTick, pinRequestPoll;
let searchResults = [], searchSequence = 0, searchTimer;
const confirmTimeoutMs = 15000, pinIdleMs = 60000, messageMs = 6000, pinRequestPollMs = 3000;
let presenceState;
let presenceError;
let attendanceRecoveryRequired = false;
const presenceRetry = document.createElement("button");
presenceRetry.id = "retry-attendance"; presenceRetry.type = "button"; presenceRetry.className = "identity-submit"; presenceRetry.textContent = "Retry attendance"; presenceRetry.hidden = true;
byId("display").append(presenceRetry);
const clockMaintenance = document.createElement("button");
clockMaintenance.id="clock-maintenance"; clockMaintenance.type="button"; clockMaintenance.className="identity-submit"; clockMaintenance.textContent="Open maintenance"; clockMaintenance.hidden=true;
byId("display").append(clockMaintenance);
clockMaintenance.addEventListener("click",async()=>{try{await operatorPresence?.leave();location.href="/maintenance";}catch{}});
const localDisplay = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const operatorPresence = localDisplay ? createOperatorPresence({
  onState: state => {
    presenceState = state; presenceError = undefined;
    if (state.mode === "attendance") attendanceRecoveryRequired = false;
    presenceRetry.hidden = state.reason !== "presence_lost" && !attendanceRecoveryRequired;
    if (state.mode !== "attendance" || state.captureSuspended) pausePresentation();
    void refresh();
  },
  onError: error => { presenceState = undefined; presenceError = error.message; attendanceRecoveryRequired = true; presenceRetry.hidden = false; pausePresentation(); }
}) : undefined;
function pausePresentation() {
  byId("display").classList.add("presence-paused");
  byId("display-message").textContent = presenceState?.reason === "operator_active" && !attendanceRecoveryRequired ? "Attendance paused" : "Attendance needs attention";
  byId("display-detail").textContent = presenceError || (presenceState?.reason === "operator_active" && !attendanceRecoveryRequired ? "Return from maintenance or network settings to resume." : "Use Retry attendance to reconnect this screen.");
  byId("display-name").hidden = true; byId("display-meeting").hidden = true;
  byId("identity-entry").hidden = true;
  resetMemberFlow();
  byId("identity-value").value = "";
  identityEntryWasInteractive = false;
}
presenceRetry.addEventListener("click", async () => { try { await operatorPresence.enter("attendance"); } catch { /* Callback shows the failure. */ } });

async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { "content-type": "application/json" } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function call(path, options) {
  try {
    const response = await fetch(path, { ...options, headers: { ...(options?.body ? { "content-type": "application/json" } : {}), ...options?.headers } });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
  } catch { return { ok: false, status: 0, body: { error: "The kiosk service is not answering. Try again." } }; }
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

function entryMode(method) {
  if (method !== "member_id") return method;
  return memberLookup === "search" ? "search" : memberIdKeypad ? "keypad" : "keyboard";
}

function configureIdentityEntry(method, displayId) {
  const form = byId("identity-entry");
  const input = byId("identity-value");
  const keyboard = byId("member-id-keyboard");
  const interactive = presenceState?.mode === "attendance" && !presenceState.captureSuspended && method !== "fingerprint" && displayId === "ready" && memberFlow.step === "entry";
  const becameInteractive = interactive && !identityEntryWasInteractive;
  identityEntryWasInteractive = interactive;
  form.hidden = !interactive;
  byId("display").classList.toggle("scan-panel-identity", interactive);
  // A member who is confirming keeps their search text for Back to search.
  if (!interactive) { if (memberFlow.step === "entry") { input.value = ""; showSearchResults([]); } return; }
  const memberEntry = method === "member_id";
  const mode = entryMode(method);
  if (method !== lastAuthenticationMethod || mode !== lastEntryMode) {
    lastAuthenticationMethod = method; lastEntryMode = mode;
    input.value = "";
    keyboard.hidden = !memberEntry || mode === "keypad";
    byId("member-id-keypad").hidden = mode !== "keypad";
    byId("member-results").hidden = mode !== "search";
    form.classList.toggle("member-search", mode === "search");
    form.classList.toggle("member-keypad", mode === "keypad");
    input.readOnly = false;
    input.inputMode = memberEntry ? "text" : "none";
    input.type = memberEntry ? "text" : "password";
    input.maxLength = memberEntry ? 100 : 256;
    input.placeholder = mode === "search" ? "Name, ID or email" : "";
    byId("identity-label").textContent = mode === "search" ? "Search by name, member ID or email" : memberEntry ? "Member ID" : method === "qr" ? "QR scanner input" : method.toUpperCase() + " badge input";
    byId("identity-entry").querySelector("button[type=submit]").textContent = memberEntry ? "Submit member ID" : "Read credential";
    showSearchResults([]);
  }
  if (!memberEntry && (becameInteractive || document.activeElement !== input)) input.focus({ preventScroll: true });
}

// ---- Member search, the confirm step and member PINs ----
const memberName = (member) => ((member.firstName || "") + " " + (member.lastName || "")).trim();

function showSearchResults(members) {
  searchResults = members;
  const list = byId("member-results");
  const query = byId("identity-value").value.trim();
  list.replaceChildren();
  for (const member of members) {
    const button = document.createElement("button"); button.type = "button";
    const name = document.createElement("span"); name.textContent = memberName(member);
    const id = document.createElement("small"); id.textContent = member.memberId;
    button.append(name, id); button.setAttribute("aria-label", memberName(member) + ", member ID " + member.memberId);
    button.addEventListener("click", () => startConfirm(member));
    list.append(button);
  }
  if (!members.length) { const empty = document.createElement("p"); empty.textContent = query ? "No matches. Check the spelling, or ask an operator." : "Type your name, member ID or email."; list.append(empty); }
}
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); }
async function runSearch() {
  const query = byId("identity-value").value; const sequence = ++searchSequence;
  if (!query.trim()) { showSearchResults([]); return; }
  const result = await call("/identity/search", { method: "POST", body: JSON.stringify({ query }) });
  if (sequence !== searchSequence || lastEntryMode !== "search") return;
  showSearchResults(result.ok && Array.isArray(result.body.members) ? result.body.members : []);
}

function clearMemberFlowTimers() { clearTimeout(memberFlowTimer); clearInterval(memberFlowTick); clearTimeout(pinRequestPoll); memberFlowTimer = memberFlowTick = pinRequestPoll = undefined; }
function resetMemberFlow({ keepSearch = false } = {}) {
  const wasActive = memberFlow.step !== "entry";
  clearMemberFlowTimers(); memberFlowGeneration++;
  memberFlow = { step: "entry" };
  if (wasActive && !keepSearch) { byId("identity-value").value = ""; showSearchResults([]); }
  renderMemberFlow();
}
function setMemberFlow(next, { timeoutMs } = {}) {
  clearMemberFlowTimers(); memberFlowGeneration++;
  memberFlow = next;
  if (next.step === "confirm") {
    const until = Date.now() + confirmTimeoutMs; memberFlow.until = until;
    memberFlowTick = setInterval(renderMemberFlow, 250);
    memberFlowTimer = setTimeout(() => resetMemberFlow(), confirmTimeoutMs);
  } else if (timeoutMs) memberFlowTimer = setTimeout(() => resetMemberFlow(), timeoutMs);
  renderMemberFlow();
  return memberFlowGeneration;
}
function startConfirm(member) { setMemberFlow({ step: "confirm", member: { memberId: member.memberId, firstName: member.firstName, lastName: member.lastName } }); }

function flowButton(label, action, { primary = false, disabled = false } = {}) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = label;
  if (primary) button.className = "primary"; button.disabled = disabled;
  button.addEventListener("click", action); return button;
}
function lockLine(lockedUntil) {
  const time = new Date(lockedUntil); return Number.isFinite(time.getTime()) ? time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "later";
}
function renderMemberFlow() {
  const flow = memberFlow; const panel = byId("member-flow"); const active = flow.step !== "entry";
  panel.hidden = !active; byId("display").classList.toggle("member-flow-active", active);
  if (!active) return;
  const keypad = ["pin", "choose", "choose_again"].includes(flow.step);
  panel.classList.toggle("with-keypad", keypad); byId("member-flow-keypad").hidden = !keypad;
  const text = (id, value) => { const element = byId(id); element.textContent = value || ""; element.hidden = !value; };
  let title = "", name = flow.member ? memberName(flow.member) : "", detail = "", note = "", actions = [];
  const cancel = () => resetMemberFlow();
  if (flow.step === "confirm") {
    title = "Is this you?"; detail = "Member ID " + flow.member.memberId;
    note = "Returns to start in " + Math.max(0, Math.ceil((flow.until - Date.now()) / 1000)) + " s";
    actions = [flowButton(memberLookup === "search" ? "Back to search" : "Not me", () => resetMemberFlow({ keepSearch: memberLookup === "search" })), flowButton("Confirm", () => void confirmMember(), { primary: true })];
  } else if (flow.step === "pin" || flow.step === "choose" || flow.step === "choose_again") {
    title = flow.step === "pin" ? "Enter your PIN" : flow.step === "choose" ? "Choose a PIN" : "Type your PIN again";
    detail = flow.step === "pin" ? "Then tap Enter" : "4 to 6 digits";
    note = flow.note || "";
    const ready = flow.digits.length >= 4;
    actions = [flowButton("Cancel", cancel), flowButton(flow.step === "pin" ? "Enter" : flow.step === "choose" ? "Next" : "Save PIN", () => void submitDigits(), { primary: true, disabled: !ready })];
  } else if (flow.step === "sending") {
    title = flow.title || "Recording attendance";
  } else if (flow.step === "wrong_pin") {
    title = "Wrong PIN"; detail = "Try again, or ask an Operator to reset it.";
    note = flow.lockedUntil ? "Your PIN is locked until " + lockLine(flow.lockedUntil) + "." : Number.isInteger(flow.attemptsLeft) ? flow.attemptsLeft + (flow.attemptsLeft === 1 ? " try" : " tries") + " left before your PIN locks." : "";
    actions = flow.lockedUntil ? [flowButton("OK", cancel, { primary: true })] : [flowButton("Cancel", cancel), flowButton("Try again", () => setMemberFlow({ step: "pin", member: flow.member, digits: "" }, { timeoutMs: pinIdleMs }), { primary: true })];
  } else if (flow.step === "locked") {
    title = "PIN locked"; detail = "Too many wrong tries."; note = "Try again after " + lockLine(flow.lockedUntil) + ", or ask an Operator to unlock it.";
    actions = [flowButton("OK", cancel, { primary: true })];
  } else if (flow.step === "no_pin") {
    title = "You don't have a PIN yet"; detail = "An Operator approves your new PIN. Then you choose it here.";
    actions = [flowButton("Cancel", cancel), flowButton("Ask for approval", () => void askForApproval(), { primary: true })];
  } else if (flow.step === "waiting") {
    title = "Waiting for approval"; detail = "Ask an Operator to approve it on the dashboard's Manage kiosk page.";
    note = "An Operator can also set your PIN from this kiosk's maintenance screen.";
    actions = [flowButton("Cancel", cancel)];
  } else if (flow.step === "message") {
    title = flow.title; name = flow.name || ""; detail = flow.detail;
    actions = [flowButton("OK", cancel, { primary: true })];
  }
  text("member-flow-title", title); text("member-flow-name", name); text("member-flow-detail", detail); text("member-flow-note", note);
  const dots = byId("member-flow-dots"); dots.hidden = !keypad; dots.textContent = keypad ? "●".repeat(flow.digits.length) || " " : "";
  byId("member-flow-actions").replaceChildren(...actions);
}

function showFlowMessage(title, detail, member) { setMemberFlow({ step: "message", title, detail, member }, { timeoutMs: messageMs }); }
async function confirmMember() {
  const member = memberFlow.member;
  if (requirePin) {
    // The kiosk says whether the member has a PIN yet, so a member without one is not asked to type it.
    const generation = setMemberFlow({ step: "sending", member, title: "One moment" });
    const result = await call("/identity", { method: "POST", body: JSON.stringify({ method: "member_id", memberId: member.memberId, confirmed: true }) });
    if (generation !== memberFlowGeneration) return;
    if (result.body.code === "pin_required") setMemberFlow({ step: "pin", member, digits: "" }, { timeoutMs: pinIdleMs });
    else pinOutcome(member, result);
    return;
  }
  const generation = setMemberFlow({ step: "sending", member });
  const result = await call("/identity", { method: "POST", body: JSON.stringify({ method: "member_id", memberId: member.memberId, confirmed: true }) });
  if (generation !== memberFlowGeneration) return;
  if (result.ok) resetMemberFlow(); else showFlowMessage("Input not accepted", result.body.error || "Ask an operator for help.");
}
function pinOutcome(member, result) {
  const code = result.body.code;
  if (result.ok) { resetMemberFlow(); return; }
  if (code === "pin_incorrect") setMemberFlow({ step: "wrong_pin", member, attemptsLeft: result.body.attemptsLeft, lockedUntil: result.body.lockedUntil }, { timeoutMs: pinIdleMs });
  else if (code === "pin_locked") setMemberFlow({ step: "locked", member, lockedUntil: result.body.lockedUntil }, { timeoutMs: pinIdleMs });
  else if (code === "pin_not_set") setMemberFlow({ step: "no_pin", member }, { timeoutMs: pinIdleMs });
  else if (code === "pin_throttled") showFlowMessage("Please wait", result.body.error || "Too many wrong PINs. Try again in a few minutes.", member);
  else showFlowMessage("Input not accepted", result.body.error || "Ask an operator for help.");
}
async function submitDigits() {
  const flow = memberFlow; const pin = flow.digits;
  if (pin.length < 4) return;
  if (flow.step === "choose") { setMemberFlow({ step: "choose_again", member: flow.member, request: flow.request, first: pin, digits: "" }, { timeoutMs: pinIdleMs }); return; }
  if (flow.step === "choose_again" && pin !== flow.first) { setMemberFlow({ step: "choose", member: flow.member, request: flow.request, digits: "", note: "The two PINs don't match. Choose a PIN again." }, { timeoutMs: pinIdleMs }); return; }
  const generation = setMemberFlow({ step: "sending", member: flow.member, title: flow.step === "pin" ? "Checking your PIN" : "Saving your PIN" });
  const result = flow.step === "pin"
    ? await call("/identity", { method: "POST", body: JSON.stringify({ method: "member_id", memberId: flow.member.memberId, confirmed: true, pin }) })
    : await call("/identity/pin-requests/" + encodeURIComponent(flow.request.id) + "/pin", { method: "POST", body: JSON.stringify({ memberId: flow.member.memberId, pin }) });
  if (generation !== memberFlowGeneration) return;
  if (flow.step === "choose_again" && result.body.code === "pin_request_not_approved") { showFlowMessage("Approval ran out", "Ask for approval again.", flow.member); return; }
  pinOutcome(flow.member, result);
}
async function askForApproval() {
  const member = memberFlow.member;
  const generation = setMemberFlow({ step: "sending", member, title: "Asking for approval" });
  const result = await call("/identity/pin-requests", { method: "POST", body: JSON.stringify({ memberId: member.memberId }) });
  if (generation !== memberFlowGeneration) return;
  if (result.body.code === "pin_already_set") { setMemberFlow({ step: "pin", member, digits: "", note: "You already have a PIN." }, { timeoutMs: pinIdleMs }); return; }
  if (!result.ok || !result.body.request?.id) { showFlowMessage("Couldn't ask for approval", result.body.error || "Ask an operator for help.", member); return; }
  waitForApproval(member, result.body.request);
}
function waitForApproval(member, pinRequest) {
  const generation = setMemberFlow({ step: "waiting", member, request: pinRequest });
  const poll = async () => {
    const result = await call("/identity/pin-requests/" + encodeURIComponent(pinRequest.id));
    if (generation !== memberFlowGeneration) return;
    const status = result.ok ? result.body.request?.status : undefined;
    if (status === "approved") setMemberFlow({ step: "choose", member, request: pinRequest, digits: "" }, { timeoutMs: pinIdleMs });
    else if (status === "declined") showFlowMessage("Request declined", "Ask an Operator for help.", member);
    else if (status === "expired" || status === "used") showFlowMessage("Request expired", "Ask for approval again.", member);
    else pinRequestPoll = setTimeout(poll, pinRequestPollMs);
  };
  pinRequestPoll = setTimeout(poll, pinRequestPollMs);
}
function pressPinKey(key) {
  if (!["pin", "choose", "choose_again"].includes(memberFlow.step)) return;
  const digits = key === "Clear" ? "" : key === "⌫" ? memberFlow.digits.slice(0, -1) : memberFlow.digits.length < 6 ? memberFlow.digits + key : memberFlow.digits;
  memberFlow = { ...memberFlow, digits, note: key === "Clear" || key === "⌫" ? memberFlow.note : "" };
  // Typing restarts the idle timeout.
  clearTimeout(memberFlowTimer); memberFlowTimer = setTimeout(() => resetMemberFlow(), pinIdleMs);
  renderMemberFlow();
}
function buildDigitPad(container, onKey) {
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "⌫"]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = key;
    if (key === "⌫") button.setAttribute("aria-label", "Backspace");
    button.addEventListener("click", () => onKey(key));
    container.append(button);
  }
}
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (["pin", "choose", "choose_again"].includes(memberFlow.step)) {
    if (/^[0-9]$/.test(event.key)) pressPinKey(event.key);
    else if (event.key === "Backspace") pressPinKey("⌫");
    else if (event.key === "Enter") void submitDigits();
    else if (event.key === "Escape") resetMemberFlow();
    else return;
    event.preventDefault();
  } else if (memberFlow.step === "confirm") {
    if (event.key === "Enter") void confirmMember();
    else if (event.key === "Escape") resetMemberFlow({ keepSearch: memberLookup === "search" });
    else return;
    event.preventDefault();
  }
});

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
  const notice = byId("display-notice");
  notice.textContent = display.notice || "";
  notice.hidden = !display.notice;
  const method = value.authenticationMethod || "fingerprint";
  const nextLookup = value.memberLookup === "search" ? "search" : "entry", nextRequirePin = value.requirePin === true;
  // A changed mode, method or screen ends a member's confirm or PIN step; the service decides what is shown.
  if (memberFlow.step !== "entry" && (method !== "member_id" || nextLookup !== memberLookup || nextRequirePin !== requirePin || (display.id || "ready") !== "ready")) resetMemberFlow();
  memberLookup = nextLookup; requirePin = nextRequirePin; memberIdKeypad = value.memberIdKeypad === true;
  configureIdentityEntry(method, display.id || "ready");
  renderMemberFlow();
  clockMaintenance.hidden = display.id !== "clock_required";
  const kioskName = typeof value.kioskName === "string" ? value.kioskName.trim() : "";
  byId("kiosk-name").textContent = kioskName;
  byId("kiosk-name").hidden = !kioskName;
  byId("kiosk-name").title = kioskName;
  const fullVersion = value.releaseVersion || "development";
  byId("kiosk-version").textContent = "Kiosk " + (fullVersion === "development" ? fullVersion : "v" + fullVersion);
  byId("kiosk-version").title = "Kiosk software version " + fullVersion;
  byId("kiosk-version").setAttribute("aria-label", "Kiosk software version " + fullVersion);
  byId("reader-status").title = kioskReaderStatus(value);
  byId("reader-status").textContent = value.authenticationMethod && value.authenticationMethod !== "fingerprint" ? (value.authenticationMethod === "member_id" ? "Member ID" : value.authenticationMethod.toUpperCase()) + (value.readerOnline ? " ready" : " unavailable") : value.readerOnline ? "Reader online" : "Reader offline";
  byId("queue-status").textContent = value.pendingEvents ? value.pendingEvents + " queued" : "0 queued";
  const attendanceNotice = kioskAttendanceNotice(value);
  byId("attendance-warning").textContent = attendanceNotice;
  byId("attendance-warning").hidden = !attendanceNotice;
  uptime(value.uptimeSeconds);
  const network = byId("network-status");
  network.className = "network-status " + (value.cloudOnline ? "online" : "offline") + " " + (value.networkType === "ethernet" ? "ethernet" : "wifi");
  network.title = (value.networkType === "ethernet" ? "Ethernet" : "Wi-Fi") + (value.cloudOnline ? " and cloud connected" : " connection or cloud unavailable");
  if (value.kioskName) document.title = value.kioskName + " · LancerLogin";
  if (!presenceState || presenceState.mode !== "attendance" || presenceState.captureSuspended) pausePresentation();
  else byId("display").classList.remove("presence-paused");
}

let refreshSequence = 0;
let lastRenderedRefresh = 0;
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const health = await request("/health");
    if (sequence < lastRenderedRefresh) return;
    byId("pairing-panel").hidden = health.paired;
    if (!health.paired) {
      // The kiosk screen shows the setup code; another device must enter it.
      const hint = byId("setup-code-hint");
      hint.hidden = !health.setupCode;
      hint.textContent = health.setupCode ? "To pair from a phone or laptop on the same network, open this kiosk's network address there and enter setup code " : "";
      if (health.setupCode) { const code = document.createElement("strong"); code.textContent = health.setupCode; hint.append(code, "."); }
      const remote = health.setupCodeRequired === true;
      byId("setup-code").hidden = !remote; byId("setup-code-label").hidden = !remote; byId("setup-code").required = remote;
      lastRenderedRefresh = sequence; return;
    }
    try {
      const state = await request("/display-state");
      if (state.enrollment?.id && location.pathname === "/" && (location.hostname === "127.0.0.1" || location.hostname === "localhost")) { await operatorPresence?.leave(); location.href = "/maintenance?enrollment=" + encodeURIComponent(state.enrollment.id); return; }
      if (sequence < lastRenderedRefresh) return;
      render(state);
      lastRenderedRefresh = sequence;
    } catch (error) {
      if (sequence < lastRenderedRefresh) return;
      lastRenderedRefresh = sequence;
      if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
        byId("display-message").textContent = "Continue on the kiosk display";
        byId("display-detail").textContent = "Pairing is complete. Attendance controls remain private to this device.";
      } else throw error;
    }
  } catch {
    if (sequence < lastRenderedRefresh) return;
    lastRenderedRefresh = sequence;
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
    const setupCode = byId("setup-code");
    const value = await request("/pair", { method: "POST", body: JSON.stringify({ pairingKey: byId("pairing-key").value.trim(), ...(setupCode.hidden ? {} : { setupCode: setupCode.value.trim() }) }) });
    byId("pair-result").textContent = "Paired " + value.kioskName + ". Continue on the kiosk display.";
    byId("pairing-key").value = ""; byId("setup-code").value = "";
    await refresh();
  } catch (error) {
    byId("pair-result").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

byId("identity-entry").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("identity-value");
  const method = lastAuthenticationMethod;
  const value = input.value;
  if (!value.trim()) return;
  // Member search: Enter picks the first result.
  if (method === "member_id" && lastEntryMode === "search") { if (searchResults[0]) startConfirm(searchResults[0]); return; }
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/identity", { method: "POST", body: JSON.stringify(method === "member_id" ? { method, memberId: value } : { method, credential: value }) });
    // A known member ID answers with the member to confirm; nothing is recorded until they tap Confirm.
    if (method === "member_id" && result.confirm?.memberId) startConfirm(result.confirm);
    input.value = "";
  } catch (error) {
    byId("display-message").textContent = "Input not accepted";
    byId("display-detail").textContent = error.message;
  } finally {
    button.disabled = false;
    if (method !== "member_id") input.value = "";
    if (method !== "member_id") input.focus({ preventScroll: true });
  }
});

function buildMemberIdKeyboard() {
  const input = byId("identity-value");
  let lowerCase = false;
  const rows = [[..."1234567890"], [..."QWERTYUIOP"], [..."ASDFGHJKL"], [..."ZXCVBNM", "-", ".", "_"], ["a/A", "Space", "⌫", "Clear"]];
  for (const keys of rows) {
    const row = document.createElement("div"); row.className = "member-id-keyboard-row";
    for (const key of keys) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = key;
      if (["a/A", "Space", "⌫", "Clear"].includes(key)) button.className = "wide";
      if (key === "⌫") button.setAttribute("aria-label", "Backspace");
      button.addEventListener("click", () => {
        if (key === "a/A") { lowerCase = !lowerCase; for (const letter of byId("member-id-keyboard").querySelectorAll("button[data-letter]")) letter.textContent = lowerCase ? letter.dataset.letter.toLowerCase() : letter.dataset.letter; }
        else if (key === "Clear") input.value = "";
        else if (key === "⌫") input.value = input.value.slice(0, -1);
        else if (input.value.length < input.maxLength) input.value += key === "Space" ? " " : lowerCase && /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      if (/^[A-Z]$/.test(key)) button.dataset.letter = key;
      row.append(button);
    }
    byId("member-id-keyboard").append(row);
  }
}
buildMemberIdKeyboard();
buildDigitPad(byId("member-id-keypad"), (key) => {
  const input = byId("identity-value");
  input.value = key === "Clear" ? "" : key === "⌫" ? input.value.slice(0, -1) : input.value.length < input.maxLength ? input.value + key : input.value;
});
buildDigitPad(byId("member-flow-keypad"), pressPinKey);
byId("identity-value").addEventListener("input", () => { if (lastEntryMode === "search") scheduleSearch(); });

installHoldGesture(byId("brand"), async () => {
  if (!operatorPresence) return;
  try { await operatorPresence.leave(); location.href = "/maintenance"; }
  catch { /* Presence callback keeps attendance paused and exposes retry. */ }
});
function uptime(seconds) { const total = Math.max(0, Number(seconds) || 0); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); byId("uptime").textContent = "Uptime " + (hours ? hours + "h " : "") + minutes + "m"; }
uptime(0);
try { if (operatorPresence) await operatorPresence.enter("attendance"); } catch { /* Retry remains available. */ }
await refresh();
setInterval(refresh, 500);
export { installHoldGesture, operatorPresence };
`;
