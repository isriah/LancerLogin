import test from "node:test";
import assert from "node:assert/strict";
import { createKioskReleaseLookup, createReleaseDiscovery, discoveryTtlMs } from "../apps/api/src/release-discovery.ts";
import { HttpError } from "../apps/api/src/http-error.ts";

const sha = "c".repeat(40);
const release = (name = "v1.4.0") => ({ tag_name: name, draft: false, prerelease: name.includes("-beta."), immutable: true, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => { const archive = `lancerlogin-kiosk-${name.slice(1)}-linux-${arch}.tar.gz`; return [archive, `${archive}.sha256`]; })].map((name) => ({ name })) });
const feed = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";
const betaFeed = "https://api.github.com/repos/isriah/LancerLogin/releases?per_page=100&page=1";
const commitUrl = (tag: string) => `https://api.github.com/repos/isriah/LancerLogin/commits/${tag}`;
const token = { WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.parse("2026-11-01T12:00:00Z") + 86_400_000).toISOString() };

/** A lookup over its own discoveries and a scripted GitHub, with every request recorded. */
function harness(answer: (url: string, init?: RequestInit) => Response | Promise<Response>, { timeoutMs = 4_000 } = {}) {
  const state = { now: Date.parse("2026-11-01T12:00:00Z"), requests: [] as { url: string; authorization: string | null }[] };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    state.requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    assert.equal(init?.redirect, "manual");
    return answer(String(input), init);
  }) as typeof fetch;
  const now = () => state.now;
  const discoveries = { stable: createReleaseDiscovery({ fetcher, now, timeoutMs }), beta: createReleaseDiscovery({ channel: "beta", fetcher, now, timeoutMs }) };
  const lookup = createKioskReleaseLookup({ discovery: (channel) => discoveries[channel], fetcher, now, timeoutMs });
  return { state, discoveries, lookup: lookup.lookup };
}
const github = (url: string) => url.includes("/commits/") ? Response.json({ sha }) : url.includes("?per_page") ? Response.json([release("v1.5.0-beta.2"), release("v1.4.0")]) : Response.json(release());
async function refusal(action: Promise<unknown>) {
  const error = await action.then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof HttpError, "the lookup refuses with an HttpError");
  assert.equal(error.status, 503);
  return { code: error.code, message: error.message, extra: error.extra };
}
const resetIn = (state: { now: number }, seconds: number) => String(Math.floor(state.now / 1000) + seconds);

test("a kiosk update reads the feed and the tag's commit once, then nothing while the answer is fresh", async () => {
  const { state, lookup } = harness(github);
  assert.deepEqual(await lookup(undefined, "stable"), { tag: "v1.4.0", notes: "", prerelease: false, sha });
  assert.deepEqual(state.requests.map((item) => item.url), [feed, commitUrl("v1.4.0")]);
  // Warm: the cached release and its remembered commit answer every further update without a GitHub request.
  for (let count = 0; count < 5; count++) assert.equal((await lookup(undefined, "stable")).sha, sha);
  assert.equal(state.requests.length, 2);
  // Once the discovery is no longer fresh the feed is read again, but an immutable release's commit is not.
  state.now += discoveryTtlMs;
  assert.equal((await lookup(undefined, "stable")).tag, "v1.4.0");
  assert.deepEqual(state.requests.map((item) => item.url), [feed, commitUrl("v1.4.0"), feed]);
});

test("a release the dashboard has just shown starts a kiosk update with one commit read, and each track keeps its own answer", async () => {
  const { state, discoveries, lookup } = harness(github);
  assert.equal((await discoveries.beta.check()).release?.tag_name, "v1.5.0-beta.2");
  assert.deepEqual(await lookup(undefined, "beta"), { tag: "v1.5.0-beta.2", notes: "", prerelease: true, sha });
  assert.deepEqual(state.requests.map((item) => item.url), [betaFeed, commitUrl("v1.5.0-beta.2")]);
  assert.equal((await lookup(undefined, "stable")).tag, "v1.4.0");
  assert.equal((await lookup(undefined, "beta")).tag, "v1.5.0-beta.2");
  assert.deepEqual(state.requests.slice(2).map((item) => item.url), [feed, commitUrl("v1.4.0")]);
});

test("release requests carry the web update token only while it is usable", async () => {
  const signed = harness(github);
  await signed.lookup(token, "stable");
  assert.deepEqual(signed.state.requests.map((item) => item.authorization), ["Bearer synthetic-token", "Bearer synthetic-token"]);
  for (const credential of [undefined, { WEB_UPDATE_TOKEN: "synthetic-expired-token", WEB_UPDATE_TOKEN_EXPIRES_AT: "2026-10-01T00:00:00Z" }]) {
    const anonymous = harness(github);
    await anonymous.lookup(credential, "stable");
    assert.deepEqual(anonymous.state.requests.map((item) => item.authorization), [null, null]);
  }
});

test("a GitHub rate limit is reported as a rate limit, with GitHub's reset time and no further requests until it", async () => {
  const limits: { name: string; build: (state: { now: number }) => Response; minutes: string }[] = [
    { name: "403 with an exhausted quota", build: (state) => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(state, 25 * 60) } }), minutes: "in about 25 minutes" },
    { name: "403 with Retry-After", build: () => Response.json({ message: "secondary rate limit" }, { status: 403, headers: { "retry-after": "120" } }), minutes: "in about 2 minutes" },
    { name: "429", build: () => new Response("slow down", { status: 429 }), minutes: "in about a minute" },
  ];
  for (const limit of limits) {
    const { state, lookup } = harness(() => limit.build(state));
    const first = await refusal(lookup(undefined, "stable"));
    assert.equal(first.code, "kiosk_release_rate_limited", limit.name);
    assert.equal(first.message, `GitHub is limiting release checks right now, so the kiosk update was not started. Nothing is wrong with the kiosk. Try again ${limit.minutes}. Setting up or refreshing the optional web update token (Settings > Updates) signs this server's release checks, which avoids this shared limit.`, limit.name);
    assert.doesNotMatch(first.message, /No compatible|no complete official/i);
    assert.ok(Number(first.extra?.retryAfterSeconds) >= 60, limit.name);
    // Asking again before the reset repeats the answer without spending another GitHub request.
    assert.equal((await refusal(lookup(undefined, "stable"))).code, "kiosk_release_rate_limited");
    assert.equal(state.requests.length, 1, limit.name);
  }
  // With the token in use, the message does not suggest adding it.
  const signed = harness(() => new Response("slow down", { status: 429 }));
  const limited = await refusal(signed.lookup(token, "stable"));
  assert.equal(limited.message, "GitHub is limiting release checks right now, so the kiosk update was not started. Nothing is wrong with the kiosk. Try again in about a minute.");
});

test("a rate-limited commit read is a rate limit too, and waits for GitHub's reset", async () => {
  const { state, lookup } = harness((url) => url.includes("/commits/")
    ? Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(state, 10 * 60) } })
    : Response.json(release()));
  const first = await refusal(lookup(undefined, "stable"));
  assert.equal(first.code, "kiosk_release_rate_limited");
  assert.match(first.message, /Try again in about 10 minutes\./);
  assert.equal(first.extra?.retryAfterSeconds, 600);
  assert.equal((await refusal(lookup(undefined, "stable"))).code, "kiosk_release_rate_limited");
  assert.equal(state.requests.length, 2);
  state.now += 10 * 60_000;
  await refusal(lookup(undefined, "stable"));
  assert.deepEqual(state.requests.map((item) => item.url), [feed, commitUrl("v1.4.0"), commitUrl("v1.4.0")]);
});

test("a timeout, an unreachable GitHub, a GitHub error and an unreadable answer each get their own code and message", async () => {
  const stalled = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); });
  const offline = () => { throw new TypeError("fetch failed: sensitive network details"); };
  const cases: { name: string; feed: typeof github; commit?: typeof github; code: string; message: RegExp }[] = [
    { name: "feed timeout", feed: stalled, code: "kiosk_release_timeout", message: /^GitHub did not answer the release check in time, so the kiosk update was not started\. Nothing is wrong with the kiosk\. Try again in about a minute\.$/ },
    { name: "commit timeout", feed: github, commit: stalled, code: "kiosk_release_timeout", message: /^GitHub did not answer the release check in time, .* Try again in a few minutes\.$/ },
    { name: "feed network error", feed: offline, code: "kiosk_release_unreachable", message: /^This server could not reach GitHub to check the release, so the kiosk update was not started\. Nothing is wrong with the kiosk\. Try again in about a minute\.$/ },
    { name: "commit network error", feed: github, commit: offline, code: "kiosk_release_unreachable", message: /^This server could not reach GitHub to check the release, / },
    { name: "feed server error", feed: () => new Response("{}", { status: 502 }), code: "kiosk_release_github_error", message: /^GitHub returned an error for the release check, so the kiosk update was not started\. Nothing is wrong with the kiosk\. Try again in about a minute\.$/ },
    { name: "feed redirect", feed: () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }), code: "kiosk_release_github_error", message: /^GitHub returned an error/ },
    { name: "commit not found", feed: github, commit: () => new Response("{}", { status: 404 }), code: "kiosk_release_github_error", message: /^GitHub returned an error/ },
    { name: "malformed feed", feed: () => new Response("not-json"), code: "kiosk_release_unreadable", message: /^GitHub's answer to the release check could not be read, so the kiosk update was not started\. Nothing is wrong with the kiosk\. Try again in about a minute\.$/ },
    { name: "feed of the wrong shape", feed: () => Response.json([release()]), code: "kiosk_release_unreadable", message: /^GitHub's answer/ },
    { name: "malformed commit", feed: github, commit: () => new Response("not-json"), code: "kiosk_release_unreadable", message: /^GitHub's answer/ },
    { name: "commit without a full sha", feed: github, commit: () => Response.json({ sha: "abc123" }), code: "kiosk_release_unreadable", message: /^GitHub's answer/ },
  ];
  for (const item of cases) {
    const { lookup } = harness((url, init) => url.includes("/commits/") ? (item.commit ?? item.feed)(url, init) : item.feed(url, init), { timeoutMs: 10 });
    const refused = await refusal(lookup(undefined, "stable"));
    assert.equal(refused.code, item.code, item.name);
    assert.match(refused.message, item.message, item.name);
    assert.doesNotMatch(refused.message, /No compatible|no complete official|sensitive/i, item.name);
  }
});

test("no release is reported only when the feed was read and none qualified", async () => {
  const stable = harness(() => Response.json({ ...release(), assets: [] }));
  const none = await refusal(stable.lookup(undefined, "stable"));
  assert.deepEqual(none, { code: "kiosk_release_none", message: "GitHub's release list was read, but it has no complete official kiosk release on the Stable track, so there is nothing to install yet.", extra: undefined });
  assert.equal(stable.state.requests.length, 1);
  for (const feedAnswer of [[] as unknown[], [{ ...release("v1.5.0-beta.2"), immutable: false }, { ...release(), draft: true }]]) {
    const beta = harness(() => Response.json(feedAnswer));
    const refused = await refusal(beta.lookup(undefined, "beta"));
    assert.equal(refused.code, "kiosk_release_none");
    assert.match(refused.message, /on the Beta track/);
  }
  // A Beta list too long to read completely cannot prove which release is newest, so it is unreadable, not empty.
  const truncated = harness(() => Response.json(Array.from({ length: 100 }, () => release("v1.5.0-beta.2"))));
  assert.equal((await refusal(truncated.lookup(undefined, "beta"))).code, "kiosk_release_unreadable");
  assert.equal(truncated.state.requests.length, 5);
});

test("a failed check never pins a previously seen release, and recovers when GitHub answers again", async () => {
  let failing = false;
  const { state, lookup } = harness((url) => failing ? new Response("slow down", { status: 429 }) : github(url));
  assert.equal((await lookup(undefined, "stable")).tag, "v1.4.0");
  state.now += discoveryTtlMs; failing = true;
  assert.equal((await refusal(lookup(undefined, "stable"))).code, "kiosk_release_rate_limited");
  state.now += 60_000; failing = false;
  assert.equal((await lookup(undefined, "stable")).tag, "v1.4.0");
  assert.deepEqual(state.requests.map((item) => item.url), [feed, commitUrl("v1.4.0"), feed, feed]);
});
