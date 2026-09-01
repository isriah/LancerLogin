import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const pages = ["index.html", "setup.html", "kiosk.html", "operations.html", "privacy.html", "releases.html", "technical.html"];

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

  const operations = await readFile("docs-site/operations.html", "utf8");
  assert.match(operations, /integration-controls\.png/);
  assert.match(operations, /Check status, not secrets/);
  assert.match(operations, /Rotate in place/);
  assert.match(operations, /reader state, and installed release/);
  assert.match(operations, /spreadsheet formula markers as text/);
});

test("kiosk guide includes a sanitized Waveshare-sized annotated screenshot", async () => {
  assert.ok((await stat("docs-site/assets/kiosk-touch-ui.png")).size > 20_000);
  const kiosk = await readFile("docs-site/kiosk.html", "utf8");
  assert.match(kiosk, /kiosk-touch-ui\.png/);
  assert.match(kiosk, /800 by 480 pixels/);
  assert.match(kiosk, /class="annotated kiosk-shot"/);
});

test("privacy page publishes the approved collector operator, retention, access, and deletion process", async () => {
  const privacy = await readFile("docs-site/privacy.html", "utf8");
  assert.match(privacy, /RoboLancers operates/);
  assert.match(privacy, /30 days/);
  assert.match(privacy, /designated maintainers/);
  assert.match(privacy, /deletion-request reference/);
  assert.match(privacy, /robolancers@gmail\.com/);
});
