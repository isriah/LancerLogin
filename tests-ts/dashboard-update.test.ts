import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight, createReleaseCache, releaseCacheKey, releaseCacheTtlMs, ReleaseCheckError, fetchLatestRelease, latestReleaseUrl } from "../apps/dashboard/src/update-release.ts";
import { kioskUpdateState, type KioskUpdateCommand } from "../apps/dashboard/src/kiosk-update-status.ts";
import { canReloadWebUpdate, diagnosticUrl, webUpdateError, webUpdateStatus, type WebUpdateRequest } from "../apps/dashboard/src/web-update.ts";

test("web updates require verified finalization and a different bundled version to reload", () => {
  const request = { state: "succeeded", targetTag: "v1.0.0", reloadReady: true, maintenance: false, errorCode: null } as WebUpdateRequest;
  assert.equal(canReloadWebUpdate(request, "0.24.0"), true);
  assert.equal(canReloadWebUpdate(request, "1.0.0"), false);
  assert.equal(canReloadWebUpdate({ ...request, reloadReady: false }, "0.24.0"), false);
  assert.equal(canReloadWebUpdate({ ...request, state: "verifying" }, "0.24.0"), false);
  assert.match(webUpdateStatus({ ...request, state: "recovery_required", maintenance: true }), /Recovery required.*writes are paused/);
  assert.match(webUpdateError("cooldown"), /GitHub or this installation.*provider limits may take longer/);
  assert.equal(diagnosticUrl("javascript:alert(1)"), undefined);
  assert.equal(diagnosticUrl("https://credential:secret@example.test/"), undefined);
});

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

  const recovered = (async () => Response.json({ fresh: true, checkedAt: 100_000, attemptedAt: 99_000, release: { tag_name: "v0.15.0", html_url: "https://example.test/release" } })) as typeof fetch;
  assert.deepEqual(await fetchLatestRelease(recovered, 50), { tag_name: "v0.15.0", html_url: "https://example.test/release", checkedAt: 100_000, attemptedAt: 99_000 });
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

// incomplete version data must never be classified as current.
test("dashboard release comparison requires confirmed stable versions", async () => {
  const { hasComparableStableVersions } = await import("../apps/dashboard/src/update-release.ts");
  for (const installed of ["0.22.0", "v0.23.0", "0.24.0"]) {
    assert.equal(hasComparableStableVersions({ tag_name: "v0.23.0" }, installed), true);
  }
  for (const value of ["", "Unavailable", "0.23", "0.23.0oops", "0.23.0-beta.1", "01.23.0", "9007199254740992.0.0"]) {
    assert.equal(hasComparableStableVersions({ tag_name: value }, "0.22.0"), false);
    assert.equal(hasComparableStableVersions({ tag_name: "v0.23.0" }, value), false);
  }
  assert.equal(hasComparableStableVersions(undefined, "0.22.0"), false);
  assert.equal(hasComparableStableVersions({ tag_name: "v0.23.0", draft: true }, "0.22.0"), false);
  assert.equal(hasComparableStableVersions({ tag_name: "v0.23.0", prerelease: true }, "0.22.0"), false);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("release cache coalesces consumers, persists success and forces a fresh check only on demand", async () => {
  let now = 100_000; let calls = 0; let finish!: (release: { tag_name: string }) => void;
  const storage = memoryStorage();
  const load = () => { calls++; return new Promise<{ tag_name: string }>((resolve) => { finish = resolve; }); };
  const cache = createReleaseCache({ load, now: () => now, storage: () => storage });
  const first = cache.check(); assert.equal(cache.check(true), first);
  await Promise.resolve(); assert.equal(calls, 1); finish({ tag_name: "v0.23.0" }); await first;
  now += 14 * 60_000; await cache.check(); assert.equal(calls, 1);
  const reloaded = createReleaseCache({ load, now: () => now, storage: () => storage });
  await reloaded.check(); assert.equal(calls, 1);
  const forced = reloaded.check(true); await Promise.resolve(); assert.equal(calls, 2); finish({ tag_name: "v0.24.0" }); await forced;
  now += releaseCacheTtlMs; const expired = reloaded.check(); await Promise.resolve(); assert.equal(calls, 3); finish({ tag_name: "v0.24.0" }); await expired;
});
test("rate-limit cooldown survives reload, rejects force and keeps stale release unconfirmed", async () => {
  let now = 100_000; let calls = 0; let fail = false; const storage = memoryStorage();
  const load = async () => { calls++; if (fail) throw new ReleaseCheckError("Unavailable", new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3700", "retry-after": "120" } })); return { tag_name: "v0.23.0" }; };
  const cache = createReleaseCache({ load, now: () => now, storage: () => storage });
  await cache.check(); fail = true; await assert.rejects(cache.check(true));
  assert.equal(cache.snapshot().fresh, false); assert.equal(cache.snapshot().release?.tag_name, "v0.23.0"); assert.equal(cache.snapshot().retryAt, 3_700_000);
  const reloaded = createReleaseCache({ load, now: () => now, storage: () => storage });
  await assert.rejects(reloaded.check(true)); assert.equal(calls, 2); assert.equal(reloaded.snapshot().fresh, false);
  now = 3_700_000; fail = false; await reloaded.check(true); assert.equal(calls, 3); assert.equal(reloaded.snapshot().fresh, true);
});
test("Retry-After date and seconds are honored for429, unrelated403 reset does not block for an hour", async () => {
  const now = 1_000_000;
  for (const [status, headers, expected] of [
    [429, { "retry-after": "120" }, now + 120_000],
    [429, { "retry-after": new Date(now + 180_000).toUTCString() }, now + 180_000],
    [403, { "x-ratelimit-reset": "9000", "x-ratelimit-remaining": "1" }, now + 30_000],
  ] as const) {
    const cache = createReleaseCache({ now: () => now, storage: () => memoryStorage(), load: async () => { throw new ReleaseCheckError("Unavailable", new Response("{}", { status, headers })); } });
    await assert.rejects(cache.check()); assert.equal(cache.snapshot().retryAt, expected);
  }
});
test("transient failures back off increasingly to a bounded15minutes and success resets the sequence", async () => {
  let now = 100_000; let calls = 0; let failing = true;
  const cache = createReleaseCache({ now: () => now, storage: () => memoryStorage(), load: async () => { calls++; if (failing) throw new Error("Offline"); return { tag_name: "v0.23.0" }; } });
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    await assert.rejects(cache.check(true)); assert.equal(cache.snapshot().retryAt, now + delay);
    await assert.rejects(cache.check(true)); now += delay;
  }
  assert.equal(calls, 7); failing = false; await cache.check(); failing = true; await assert.rejects(cache.check(true)); assert.equal(cache.snapshot().retryAt, now + 30_000);
});
test("malformed storage, invalid releases, unsafe notes and storage failures cannot assert current", async () => {
  for (const raw of ["{", JSON.stringify({ failures: 0, checkedAt: 900_000, release: { tag_name: "v0.23.0" } }), JSON.stringify({ failures: 0, checkedAt: 90_000, release: { tag_name: "v0.23.0oops" } })]) {
    const storage = memoryStorage(); storage.setItem(releaseCacheKey, raw);
    const cache = createReleaseCache({ now: () => 100_000, storage: () => storage, load: async () => ({ tag_name: "invalid" }) });
    assert.equal(cache.snapshot().fresh, false); await assert.rejects(cache.check(), /could not be confirmed/); assert.equal(cache.snapshot().fresh, false);
  }
  const cache = createReleaseCache({ now: () => 100_000, storage: () => { throw new Error("Denied"); }, load: async () => ({ tag_name: "v0.23.0", html_url: "javascript:alert(1)" }) });
  assert.deepEqual(await cache.check(), { tag_name: "v0.23.0" }); assert.equal(cache.snapshot().fresh, true);
});

test("existing cache instances adopt another view's persisted success and cooldown before checking", async () => {
  let now = 100_000; let calls = 0; let failing = false; const storage = memoryStorage();
  const load = async () => { calls++; if (failing) throw new ReleaseCheckError("Unavailable", new Response("{}", { status: 429, headers: { "retry-after": "120" } })); return { tag_name: "v0.23.0" }; };
  const first = createReleaseCache({ now: () => now, storage: () => storage, load });
  const second = createReleaseCache({ now: () => now, storage: () => storage, load });
  await first.check(); await second.check(); assert.equal(calls, 1);
  failing = true; await assert.rejects(first.check(true));
  second.sync(); assert.equal(second.snapshot().fresh, false); await assert.rejects(second.check(true)); assert.equal(calls, 2);
  now += 120_000; failing = false; await second.check(); first.sync(); assert.equal(first.snapshot().fresh, true);
});

test("server cache timestamps do not gain another15minutes and stale envelopes cannot confirm", async () => {
  const cache = createReleaseCache({ now: () => 1_000_000, storage: () => memoryStorage(), load: async () => ({ tag_name: "v1.0.4", checkedAt: 900_000 }) });
  await cache.check(); assert.equal(cache.snapshot().checkedAt, 900_000);
  const stale = createReleaseCache({ now: () => 1_000_000, storage: () => memoryStorage(), load: async () => ({ tag_name: "v1.0.4", checkedAt: 100_000 }) });
  await assert.rejects(stale.check(), /could not be confirmed/); assert.equal(stale.snapshot().fresh, false);
  await assert.rejects(fetchLatestRelease(async () => Response.json({ fresh: false, checkedAt: 900_000, release: { tag_name: "v1.0.4" } })), /temporarily unavailable/);
});

test("failed discovery retains server success/attempt times, diagnostic code and exact cooldown on reload", async () => {
  let now = 1_000_000; let calls = 0; const storage = memoryStorage();
  const load = async () => {
    calls++;
    return fetchLatestRelease(async () => Response.json({ fresh: false, release: { tag_name: "v1.0.4" }, checkedAt: 100_000, attemptedAt: 900_000, retryAt: 1_120_000, code: "rate_limited" }, { status: 429, headers: { "retry-after": "120" } }));
  };
  const cache = createReleaseCache({ now: () => now, storage: () => storage, load });
  await assert.rejects(cache.check());
  assert.equal(cache.snapshot().checkedAt, 100_000); assert.equal(cache.snapshot().attemptedAt, 900_000);
  assert.equal(cache.snapshot().retryAt, 1_120_000); assert.equal(cache.snapshot().code, "rate_limited"); assert.equal(cache.snapshot().fresh, false);
  const reloaded = createReleaseCache({ now: () => now, storage: () => storage, load });
  assert.match(reloaded.snapshot().error!, /rate limited/); await assert.rejects(reloaded.check(true)); assert.equal(calls, 1);
  now = 1_120_000;
  await assert.rejects(reloaded.check()); assert.equal(calls, 2);
});

test("old direct-browser cooldown cannot prevent same-origin discovery", async () => {
  const storage = memoryStorage(); let calls = 0;
  storage.setItem("lancerlogin-release-cache-v1", JSON.stringify({ failures: 1, checkedAt: 90_000, attemptedAt: 95_000, retryAt: 3_700_000, release: { tag_name: "v1.0.3" } }));
  const cache = createReleaseCache({ now: () => 100_000, storage: () => storage, load: async () => { calls++; return { tag_name: "v1.0.4" }; } });
  assert.equal((await cache.check()).tag_name, "v1.0.4"); assert.equal(calls, 1);
});


test("small server clock differences confirm releases without extending freshness", async () => {
  for (const aheadBy of [1, 150, 1_000, 60_000]) {
    let now = 1_000_000; let calls = 0; const storage = memoryStorage();
    const load = async () => { calls++; return { tag_name: "v1.2.2", checkedAt: now + aheadBy, attemptedAt: now + aheadBy }; };
    const cache = createReleaseCache({ now: () => now, storage: () => storage, load });
    await cache.check();
    assert.equal(cache.snapshot().fresh, true);
    assert.equal(cache.snapshot().checkedAt, now);
    assert.equal(cache.snapshot().attemptedAt, now);
    const reloaded = createReleaseCache({ now: () => now, storage: () => storage, load });
    await reloaded.check(); assert.equal(calls, 1);
    now += releaseCacheTtlMs - 1; assert.equal(reloaded.snapshot().fresh, true);
    now++; assert.equal(reloaded.snapshot().fresh, false);
  }
});

test("future clock tolerance cannot confirm stale or implausible release timestamps", async () => {
  const now = 1_000_000;
  for (const checkedAt of [now + 60_001, now - releaseCacheTtlMs, NaN, Infinity, 0, now + 0.5]) {
    const cache = createReleaseCache({ now: () => now, storage: () => memoryStorage(), load: async () => ({ tag_name: "v1.2.2", checkedAt }) });
    await assert.rejects(cache.check(), /could not be confirmed/);
    assert.equal(cache.snapshot().fresh, false);
  }
});
