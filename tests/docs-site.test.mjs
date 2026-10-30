import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";

const pages = ["index.html", "setup.html", "first-run.html", "kiosk.html", "operations.html", "updates.html", "troubleshooting.html", "privacy.html", "releases.html", "technical.html"];
const navigation = ["index.html", "setup.html", "first-run.html", "kiosk.html", "operations.html", "updates.html", "troubleshooting.html", "technical.html"];
const read = (page) => readFile(`docs-site/${page}`, "utf8");

test("public docs share the fixed brand, device palettes, focus, and motion contract", async () => {
  const styles = await readFile("docs-site/styles.css", "utf8");
  assert.match(styles, /--brand-primary:\s*#B80100;/);
  assert.match(styles, /--brand-secondary:\s*#EEB822;/);
  assert.match(styles, /color-scheme:\s*light dark;/);
  assert.match(styles, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /--control-min-block-size:\s*2\.75rem;/);
  assert.match(styles, /\.credential-table[\s\S]*overflow-x:\s*auto;/);
  assert.match(styles, /\.annotated > \.callouts \{ margin-top: var\(--space-5\); \}/);
  assert.match(styles, /\.callouts > \.field-help \{ grid-column: 1 \/ -1; margin: 0; \}/);
  assert.match(styles, /\.nav \{[^}]*flex-wrap: wrap;/);

  for (const page of pages) {
    const html = await read(page);
    assert.match(html, /<meta name="color-scheme" content="light dark">/, `${page} should set its first-paint palette`);
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/, `${page} should use the shared presentation`);
    assert.equal(html.match(/<h1(?:\s|>)/g)?.length, 1, `${page} should keep one page heading`);
  }
});

test("public docs are task-first, keyboard-navigable, and consistently linked", async () => {
  for (const page of pages) {
    const html = await read(page);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /class="skip" href="#main"/);
    assert.match(html, /<main id="main"/);
    assert.match(html, /aria-label="Documentation"/);
    assert.match(html, /robolancers@gmail\.com|Apache-2\.0/);
    assert.doesNotMatch(html, /target="_blank"/);
    assert.doesNotMatch(html, /\u2014/, `${page} should not use em dashes`);
    const nav = html.match(/<nav class="nav" aria-label="Documentation">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]), navigation, `${page} should share the documentation navigation`);
    const current = [...nav.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map((match) => match[1]);
    assert.deepEqual(current, navigation.includes(page) ? [page] : [], `${page} should mark only itself as current`);
  }
  const home = await read("index.html");
  assert.ok(home.indexOf("Choose what you need to do") < home.indexOf("Release boundaries"));
});

test("internal links, anchors, and images resolve", async () => {
  const ids = new Map();
  const used = new Set();
  for (const page of pages) ids.set(page, new Set([...(await read(page)).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));
  for (const page of pages) {
    const html = await read(page);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:)/.test(href) || href === "styles.css") continue;
      const [file, anchor] = href.split("#");
      const target = file || page;
      assert.ok(ids.has(target), `${page} links to missing page ${href}`);
      if (anchor) assert.ok(ids.get(target).has(anchor), `${page} links to missing anchor ${href}`);
    }
    for (const [, src] of html.matchAll(/<img [^>]*src="([^"]+)"/g)) {
      used.add(src.replace(/^assets\//, ""));
      assert.ok((await stat(`docs-site/${src}`)).size > (src.endsWith(".png") ? 20_000 : 1_000), `${page} image ${src} should be a rendered image`);
    }
    for (const [, alt] of html.matchAll(/<img [^>]*alt="([^"]*)"/g)) assert.ok(alt.length >= 30, `${page} image needs descriptive alt text`);
    assert.doesNotMatch(html, /<!-- (?:verify-label|screenshot:)/, `${page} should have no unresolved placeholders`);
  }
  // Every shipped asset is used, and the retired mock-ups are gone.
  assert.deepEqual((await readdir("docs-site/assets")).filter((file) => !used.has(file)), []);
  for (const retired of ["dashboard-cloudflare-setup.png", "google-oauth-setup.png", "integration-controls.png", "kiosk-touch-ui.png"]) {
    await assert.rejects(stat(`docs-site/assets/${retired}`), `${retired} should be removed`);
  }
  // The dashboard links to this anchor from the first-Admin form and Settings > Integrations.
  assert.ok(ids.get("setup.html").has("google-oauth"));
});

test("each guide shows the real screenshots for its steps", async () => {
  const expected = {
    "setup.html": ["github-template-create-repo", "github-environment-create", "cloudflare-token-chooser", "cloudflare-token-start-from-scratch", "cloudflare-token-review", "cloudflare-account-id", "github-environment-secret", "github-environment-secrets", "github-run-workflow", "github-workflow-summary", "google-oauth-client"],
    "first-run.html": ["first-run-create-installation", "first-run-choose-modules", "first-run-attendance-setup", "first-run-roster-step", "first-run-input-step", "first-run-attendance-ready"],
    "kiosk.html": ["kiosk-add-kiosk-dialog", "kiosk-pairing-page", "kiosk-attendance-screen", "r503-uart-pinout"],
    "operations.html": ["settings-integrations"],
    "updates.html": ["github-fine-grained-token", "github-fine-grained-token-permissions"],
  };
  for (const [page, images] of Object.entries(expected)) {
    const html = await read(page);
    for (const image of images) assert.match(html, new RegExp(`src="assets/${image}\\.(?:png|svg)"`), `${page} should show ${image}`);
  }
  assert.doesNotMatch(await read("updates.html"), /settings-updates/, "Settings > Updates has no screenshot by product decision");
});

test("release notes point to GitHub Releases instead of missing note files", async () => {
  const releases = await read("releases.html");
  assert.match(releases, /https:\/\/github\.com\/isriah\/LancerLogin\/releases/);
  assert.match(releases, /LancerLogin 2/);
  assert.doesNotMatch(releases, /blob\/main\/docs\/releases\/v0\./);
  assert.match(releases, /LancerLogin 2\.0\.0/);
  // These versions have no GitHub release, so they must not be linked as tags.
  assert.doesNotMatch(releases, /releases\/tag\/v(?:0\.5\.0|0\.9\.0|0\.24\.0|1\.0\.0)"/);
  assert.doesNotMatch(releases, /release-summary/);
  assert.doesNotMatch(releases, /Community telemetry|Community Edition/);
});

test("install guide covers the private repository, Cloudflare token, secrets, and workflow", async () => {
  for (const asset of ["github-environment-create.png", "cloudflare-account-id.png"]) {
    assert.ok((await stat(`docs-site/assets/${asset}`)).size > 20_000, `${asset} should be a rendered image`);
  }
  const setup = await read("setup.html");
  assert.match(setup, /github\.com\/new\?template_name=LancerLogin&amp;template_owner=isriah&amp;visibility=private/);
  assert.match(setup, /<code>production<\/code>/);
  assert.match(setup, /Start from scratch/);
  assert.match(setup, /"Legacy"/);
  assert.match(setup, /Entire Account/);
  assert.match(setup, /Workers Scripts Write, D1 Write, Pages Write, Account Settings Read/);
  assert.match(setup, /<code>cfat_<\/code>/);
  assert.match(setup, /Copy account ID/);
  assert.match(setup, /Settings.*Environments/s);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "LANCERLOGIN_SETUP_CODE", "LANCERLOGIN_WEB_UPDATE_TOKEN", "LANCERLOGIN_INSTALLATION_SLUG", "LANCERLOGIN_DATABASE_ID", "LANCERLOGIN_API_URL"]) assert.match(setup, new RegExp(name));
  assert.doesNotMatch(setup, /WEB_UPDATE_TOKEN_EXPIRES_AT|MODULE_SELECTION_TOKEN_EXPIRES_AT/);
  assert.match(setup, /3 to 41/);
  assert.match(setup, /&lt;slug&gt;-api.*&lt;slug&gt;-data.*&lt;slug&gt;-dashboard/s);
  assert.match(setup, /operation <code>resume<\/code>/);
  assert.match(setup, /https:\/\/dash\.cloudflare\.com\//);
  assert.match(setup, /id="google-oauth"/);
  assert.match(setup, /Google Auth Platform/);
  assert.match(setup, /Branding.*Audience.*Clients.*Data Access.*Verification Center/s);
  assert.match(setup, /<strong>Internal<\/strong>/);
  assert.match(setup, /<strong>External<\/strong>/);
  assert.match(setup, /<code>openid<\/code>.*<code>email<\/code>.*<code>profile<\/code>/s);
  assert.match(setup, /https:\/\/&lt;slug&gt;-dashboard\.pages\.dev\/api\/auth\/google\/callback/);
  assert.match(setup, /Google's Verification Center and LancerLogin's integration verification are separate/);
  assert.doesNotMatch(setup, /client-secret-[A-Za-z0-9_-]+|[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/i);
  assert.doesNotMatch(setup, /Guided Setup|Community telemetry|Go to Dashboard/);
});

test("troubleshooting lists every installer error code", async () => {
  const troubleshooting = await read("troubleshooting.html");
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  // dispatch_credential_expiry_required applies only to releases before LancerLogin 2.0.0.
  const codes = new Set([...workflow.matchAll(/::error title=([a-z_]+)::/g)].map((match) => match[1]).filter((code) => code !== "dispatch_credential_expiry_required"));
  assert.ok(codes.size > 15);
  for (const code of codes) assert.match(troubleshooting, new RegExp(`<code>${code}</code>`), `troubleshooting.html should explain ${code}`);
  const setup = await read("setup.html");
  assert.match(setup, /"Write" here/);
  assert.match(setup, /<code>workers\.dev<\/code> subdomain/);
});

test("first sign-in guide follows the module and Attendance setup flow", async () => {
  const firstRun = await read("first-run.html");
  for (const label of ["Create your installation", "One-time setup code", "Organization name", "Time zone", "Dashboard sign-in", "Username and password", "Google OAuth", "Both methods", "Admin username", "Confirm Admin password", "Create first Admin", "Choose modules", "Built-in", "Plugin", "Recommended", "Continue", "Attendance setup", "Step 1 of 6", "of 4 required steps complete", "Attendance rules", "Late scan minutes", "First meeting", "Roster", "Import CSV", "Add member", "Verified attendance input", "Calendar integration", "Discord integration", "Open Integrations settings", "Set up later and continue", "Finish setup later", "Attendance is ready", "Go to Meetings", "Open Attendance setup"]) {
    assert.match(firstRun, new RegExp(label), `first-run.html should cover ${label}`);
  }
  assert.match(firstRun, /at least 12 characters/);
  assert.match(firstRun, /Settings <span>›<\/span> Modules <span>›<\/span> Attendance <span>›<\/span> Attendance setup/);
  assert.doesNotMatch(firstRun, /Guided Setup|Go to Dashboard/);
});

test("operations guide matches the current navigation and recovery paths", async () => {
  const operations = await read("operations.html");
  assert.match(operations, /<strong>Meetings<\/strong>/);
  for (const page of ["Organization", "Modules", "Access", "Integrations", "Data", "Updates"]) assert.match(operations, new RegExp(`<td>${page}</td>`));
  assert.match(operations, /Attendance rules, Labels, Meeting configuration, Fingerprint sharing, Fingerprint recovery, and Attendance setup/);
  assert.match(operations, /Add to or update the current roster/);
  assert.match(operations, /Replace the active roster/);
  assert.match(operations, /Sync configured calendars/);
  assert.match(operations, /Excusing or marking absent requires a reason/);
  assert.match(operations, /spreadsheet formulas as text/);
  assert.match(operations, /id="discord-commands"/);
  assert.match(operations, /No manual HTTP request or command payload is required/);
  assert.match(operations, /creates or updates exactly the guild-scoped <code>\/pair<\/code>, <code>\/attendance-report<\/code>, <code>\/label<\/code>, <code>\/outreach-submit<\/code>, and <code>\/outreach-correction<\/code> commands/);
  assert.doesNotMatch(operations, /POST \/applications|"name": "member-id"/);
  assert.match(operations, /ephemeral responses/);
  assert.match(operations, /Exact submission retries reuse the same receipt/);
  assert.match(operations, /id="recover-access"/);
  assert.match(operations, /npm run reset-password -- --database &lt;slug&gt;-data --username/);
  assert.match(operations, /passwords_reset: 1/);
  assert.match(operations, /Fingerprint recovery<\/span>/);
  assert.doesNotMatch(operations, /Guided Setup|Reset onboarding|Settings → Attendance/);
});

test("update guide gives one dashboard procedure and separate kiosk and plugin steps", async () => {
  const updates = await read("updates.html");
  assert.equal(updates.match(/Back up and begin update/g)?.length, 1, "the web-update procedure should appear once");
  assert.match(updates, /Reload updated dashboard/);
  assert.match(updates, /github\.com\/settings\/personal-access-tokens\/new/);
  assert.match(updates, /Only select repositories/);
  assert.match(updates, /<strong>Actions<\/strong> to <strong>Read and write<\/strong>/);
  assert.match(updates, /Refresh web update credential/);
  assert.match(updates, /operation <code>upgrade<\/code>/);
  assert.match(updates, /id="kiosk-updates"/);
  assert.match(updates, /Update kiosk/);
  assert.match(updates, /switches back to the previous release/);
  assert.match(updates, /id="plugins"/);
  assert.match(updates, /LANCERLOGIN_MODULE_SELECTION_TOKEN/);
  assert.doesNotMatch(updates, /EXPIRES_AT/);
  for (const page of pages.filter((name) => name !== "updates.html")) {
    assert.doesNotMatch(await read(page), /Back up and begin update/, `${page} should link to the update guide instead of repeating it`);
  }
});

test("kiosk guide covers hardware, installation, pairing, and fixed recovery commands", async () => {
  assert.ok((await stat("docs-site/assets/r503-uart-pinout.svg")).size > 1_000);
  const kiosk = await read("kiosk.html");
  assert.match(kiosk, /cad\.onshape\.com\/documents\/255122503ddb0de539e7c548/);
  assert.match(kiosk, /r503-uart-pinout\.svg/);
  assert.match(kiosk, /VCC to 3\.3-volt pin 1/);
  assert.match(kiosk, /GPIO 15 \/ RXD/);
  assert.match(kiosk, /\/usr\/bin\/node/);
  assert.match(kiosk, /\/dev\/serial0/);
  assert.match(kiosk, /releases\/download\/v&lt;version&gt;\/install-lancerlogin\.sh/);
  assert.match(kiosk, /--dry-run/);
  assert.match(kiosk, /--no-fingerprint-reader/);
  assert.match(kiosk, /http:\/\/&lt;pi-hostname&gt;\.local:8788/);
  assert.match(kiosk, /phone or laptop/);
  assert.match(kiosk, /ten minutes/);
  assert.match(kiosk, /Pair kiosk/);
  for (const label of ["Add physical kiosk", "Prepare the Pi", "This kiosk has an R503 fingerprint reader", "Copy install commands", "Create one-time pairing key", "Copy pairing key", "Pair this kiosk", "One-time pairing key", "Open simulator"]) assert.match(kiosk, new RegExp(label));
  for (const method of ["Fingerprint", "RFID badge", "NFC badge", "Member ID entry", "QR code"]) assert.match(kiosk, new RegExp(method));
  for (const command of ["Reload display", "Restart software", "Reboot Pi", "Reset network PIN", "Update kiosk", "Erase unlinked fingerprints"]) assert.match(kiosk, new RegExp(`<td>${command}</td>`));
  assert.match(kiosk, /Scan without choosing a meeting/);
  assert.match(kiosk, /Recovery accepts only those fixed commands/);
  assert.match(kiosk, /reader status, the number of scans waiting, and uptime/);
  assert.doesNotMatch(kiosk, /Enter the Worker API URL/);
  assert.doesNotMatch(kiosk, /5-volt pin 2|<td>2 or 4<\/td>|<td>5 V<\/td>/);
  assert.doesNotMatch(kiosk, /one kiosk|local time|Finger labels|label a finger/i);
});

test("privacy page describes current storage boundaries without retired features", async () => {
  const privacy = await read("privacy.html");
  assert.doesNotMatch(privacy, /Settings → Privacy|30 days|deletion-request reference/);
  assert.doesNotMatch(privacy, /Community telemetry|Peer sync is off|relay cannot decrypt/);
  assert.match(privacy, /No usage data is sent/);
  assert.match(privacy, /server manages a separate 32-byte encryption key and can decrypt/);
  assert.match(privacy, /not end-to-end private from the server/);
  assert.match(privacy, /require re-enrollment before sharing/);
  assert.match(privacy, /Portable dashboard backups exclude/);
  assert.match(privacy, /id="fingerprint-cloud-storage"/);
  assert.doesNotMatch(privacy, /templates exclusively inside/);
});
