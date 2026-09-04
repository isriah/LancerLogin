import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight, fetchLatestRelease, latestReleaseUrl } from "../apps/dashboard/src/update-release.ts";

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
