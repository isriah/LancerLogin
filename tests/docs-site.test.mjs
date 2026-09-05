import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const pages = ["index.html", "setup.html", "kiosk.html", "operations.html", "privacy.html", "releases.html", "technical.html"];

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

  for (const page of pages) {
    const html = await readFile(`docs-site/${page}`, "utf8");
    assert.match(html, /<meta name="color-scheme" content="light dark">/, `${page} should set its first-paint palette`);
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/, `${page} should use the shared presentation`);
    assert.equal(html.match(/<h1(?:\s|>)/g)?.length, 1, `${page} should keep one page heading`);
  }
});

test("public docs are task-first, keyboard-navigable, and consistently linked", async () => {
  for (const page of pages) {
    const html = await readFile(`docs-site/${page}`, "utf8");
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /class="skip" href="#main"/);
    assert.match(html, /<main id="main"/);
    assert.match(html, /aria-label="Documentation"/);
    assert.match(html, /robolancers@gmail\.com|Apache-2\.0/);
    assert.doesNotMatch(html, /target="_blank"/);
  }
  const home = await readFile("docs-site/index.html", "utf8");
  assert.ok(home.indexOf("Choose what you need to do") < home.indexOf("Release boundaries"));
});

test("public release notes explain visible changes and the manual upgrade path", async () => {
  const releases = await readFile("docs-site/releases.html", "utf8");
  assert.match(releases, /v0\.5\.0/);
  assert.match(releases, /v0\.7\.0/);
  assert.match(releases, /v0\.8\.0/);
  assert.match(releases, /v0\.9\.0/);
  assert.match(releases, /Unattended kiosk operations/);
  assert.match(releases, /remote kiosk pairing/i);
  assert.match(releases, /Verified integrations/);
  assert.match(releases, /arrival and departure/);
  assert.match(releases, /manually run/);
  assert.match(releases, /application public key/);
});

test("annotated dashboard screenshot is a real non-empty asset with text alternative", async () => {
  assert.ok((await stat("docs-site/assets/dashboard-cloudflare-setup.png")).size > 50_000);
  const setup = await readFile("docs-site/setup.html", "utf8");
  assert.match(setup, /dashboard-cloudflare-setup\.png/);
  assert.match(setup, /alt="[^"]{30,}"/);
  assert.match(setup, /class="pin one"/);
});

test("setup and integration guides include sanitized annotated visual callouts", async () => {
  const expectedAssets = [
    "github-environment-create.png",
    "github-environment-secret.png",
    "cloudflare-token-chooser.png",
    "cloudflare-token-review.png",
    "cloudflare-account-id.png",
    "google-oauth-setup.png",
    "integration-controls.png",
  ];
  for (const asset of expectedAssets) {
    assert.ok((await stat(`docs-site/assets/${asset}`)).size > 20_000, `${asset} should be a rendered image`);
  }

  const setup = await readFile("docs-site/setup.html", "utf8");
  assert.match(setup, /github-environment-create\.png/);
  assert.match(setup, /github-environment-secret\.png/);
  assert.match(setup, /cloudflare-token-chooser\.png/);
  assert.match(setup, /cloudflare-token-review\.png/);
  assert.match(setup, /cloudflare-account-id\.png/);
  assert.match(setup, /google-oauth-setup\.png/);
  assert.match(setup, /Start from scratch/);
  assert.match(setup, /Account Settings Read/);
  assert.match(setup, /Copy account ID/);
  assert.match(setup, /Settings.*Environments/s);
  assert.match(setup, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(setup, /CLOUDFLARE_API_TOKEN/);
  assert.match(setup, /LANCERLOGIN_SETUP_CODE/);
  assert.match(setup, /https:\/\/dash\.cloudflare\.com\//);
  assert.match(setup, /Copy the exact callback/);
  assert.match(setup, /id="google-oauth"/);
  assert.match(setup, /Google Auth Platform/);
  assert.match(setup, /Branding.*Audience.*Clients.*Data Access.*Verification Center/s);
  assert.match(setup, /<strong>Internal<\/strong>/);
  assert.match(setup, /<strong>External<\/strong>/);
  assert.match(setup, /<strong>Testing<\/strong>/);
  assert.match(setup, /<strong>In production<\/strong>/);
  assert.match(setup, /<code>openid<\/code>.*<code>email<\/code>.*<code>profile<\/code>/s);
  assert.match(setup, /https:\/\/&lt;slug&gt;-dashboard\.pages\.dev\/api\/auth\/google\/callback/);
  assert.match(setup, /support\.google\.com\/cloud\/answer\/15544987/);
  assert.match(setup, /support\.google\.com\/cloud\/answer\/15549049/);
  assert.match(setup, /support\.google\.com\/cloud\/answer\/15549945/);
  assert.match(setup, /support\.google\.com\/cloud\/answer\/15549135/);
  assert.match(setup, /support\.google\.com\/cloud\/answer\/15549257/);
  assert.match(setup, /Google's Verification Center and LancerLogin's integration verification are separate/);
  assert.doesNotMatch(setup, /client-secret-[A-Za-z0-9_-]+|[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/i);

  const operations = await readFile("docs-site/operations.html", "utf8");
  assert.match(operations, /integration-controls\.png/);
  assert.match(operations, /Check status, not secrets/);
  assert.match(operations, /Rotate in place/);
  assert.match(operations, /pending queue, last sync, issue state, and installed release/);
  assert.match(operations, /spreadsheet formula markers as text/);
  assert.match(operations, /id="discord-commands"/);
  assert.match(operations, /applications\/\{application\.id\}\/guilds\/\{guild\.id\}\/commands/);
  assert.match(operations, /"name": "pair"[\s\S]*"name": "member-id"/);
  assert.match(operations, /"name": "attendance-report"/);
  assert.match(operations, /ephemeral responses/);
});

test("kiosk guide includes a sanitized Waveshare-sized annotated screenshot", async () => {
  assert.ok((await stat("docs-site/assets/kiosk-touch-ui.png")).size > 20_000);
  const kiosk = await readFile("docs-site/kiosk.html", "utf8");
  assert.match(kiosk, /kiosk-touch-ui\.png/);
  assert.match(kiosk, /800 by 480 pixels/);
  assert.match(kiosk, /class="annotated kiosk-shot"/);
  assert.match(kiosk, /phone or laptop/);
  assert.match(kiosk, /Scan without choosing a meeting/);
  assert.match(kiosk, /Recovery accepts only those fixed/);
  assert.doesNotMatch(kiosk, /Enter the Worker API URL/);
});

test("privacy page publishes the approved collector operator, retention, access, and deletion process", async () => {
  const privacy = await readFile("docs-site/privacy.html", "utf8");
  assert.match(privacy, /RoboLancers operates/);
  assert.match(privacy, /30 days/);
  assert.match(privacy, /designated maintainers/);
  assert.match(privacy, /deletion-request reference/);
  assert.match(privacy, /robolancers@gmail\.com/);
});
