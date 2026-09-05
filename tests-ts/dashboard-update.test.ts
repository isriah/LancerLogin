import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight, fetchLatestRelease, latestReleaseUrl } from "../apps/dashboard/src/update-release.ts";
import { kioskUpdateState, type KioskUpdateCommand } from "../apps/dashboard/src/kiosk-update-status.ts";

test("latest release lookup aborts a stalled public feed within its bound", async () => {
  let requestedUrl = "";
  const stalledFetch = ((url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }) as typeof fetch;

  await assert.rejects(fetchLatestRelease(stalledFetch, 10), /Latest release check timed out/);
  assert.equal(requestedUrl, latestReleaseUrl);
});

test("latest release lookup reports unavailable responses and accepts recovery", async () => {
  const unavailable = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  await assert.rejects(fetchLatestRelease(unavailable, 50), /temporarily unavailable/);

  const recovered = (async () => new Response(JSON.stringify({ tag_name: "v0.15.0", html_url: "https://example.test/release" }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await fetchLatestRelease(recovered, 50), { tag_name: "v0.15.0", html_url: "https://example.test/release" });
});

test("single-flight refreshes do not overlap and allow a later retry", async () => {
  let calls = 0;
  let finish!: () => void;
  const refresh = createSingleFlight(() => {
    calls += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  });

  const first = refresh();
  const overlapping = refresh();
  assert.equal(first, overlapping);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await first;

  const retry = refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish();
  await retry;
});

test("kiosk update reporting keeps terminal outcomes stable and distinguishes bounded failures", () => {
  const createdAt = "2026-09-05T12:00:00.000Z";
  const completedAt = "2026-09-05T12:01:00.000Z";
  const base: KioskUpdateCommand = { id: "update-1", type: "install_latest", createdAt, completedAt, success: 1, requestedReleaseVersion: "v0.22.0", releaseVersionBefore: "0.21.0" };
  const now = Date.parse("2026-09-05T12:20:00.000Z");

  assert.deepEqual(kioskUpdateState({ ...base, resolutionStatus: "succeeded", resolvedReleaseVersion: "0.22.0", resolvedAt: "2026-09-05T12:02:00.000Z" }, { lastSeenAt: "2026-09-05T12:06:00.000Z", releaseVersion: "0.23.0" }, now), { message: "Installed successfully. This kiosk now reports 0.22.0.", tone: "success" });
  assert.match(kioskUpdateState({ ...base, resolutionStatus: "mismatch", resolvedReleaseVersion: "0.23.0" }, { releaseVersion: "0.23.0" }, now).message, /restarted into 0\.23\.0, not requested 0\.22\.0/);
  assert.match(kioskUpdateState({ ...base, resolutionStatus: "unchanged", resolvedReleaseVersion: "0.21.0" }, { releaseVersion: "0.21.0" }, now).message, /still reports 0\.21\.0 instead of requested 0\.22\.0/);
  assert.match(kioskUpdateState({ ...base, success: 0, resultMessage: "Checksum verification failed" }, undefined, now).message, /Checksum verification failed/);
  assert.match(kioskUpdateState(base, { lastSeenAt: "2026-09-05T12:00:30.000Z", releaseVersion: "0.21.0" }, now).message, /has not returned online/);
  assert.match(kioskUpdateState(base, { lastSeenAt: "2026-09-05T12:06:00.000Z" }, now).message, /installed release is unknown/);
  assert.match(kioskUpdateState({ id: "expired", type: "install_latest", createdAt }, undefined, now).message, /did not receive this update request before it expired/);
});
