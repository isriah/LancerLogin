import test from "node:test";
import assert from "node:assert/strict";
import { createFingerprintRosterReader } from "../apps/kiosk/src/fingerprint-roster.mjs";

const config = { apiUrl: "https://example.test", kioskToken: "synthetic-token" };
const members = [{ memberId: "synthetic-member", rosterId: "synthetic-roster" }];
const tag = '"kiosk-roster-v1-1"';

test("two kiosks revalidate for a simulated idle day with two full rosters instead of 23,040", async () => {
  let instant = 0, requests = 0, bodies = 0;
  const readers = [0, 1].map(() => createFingerprintRosterReader(config, { now: () => instant, fetchImpl: async (_url, options) => {
    requests++;
    assert.equal(options.headers.authorization, "Bearer synthetic-token");
    if (options.headers["if-none-match"] === tag) return new Response(null, { status: 304, headers: { etag: tag } });
    bodies++; return Response.json({ members }, { headers: { etag: tag } });
  } }));
  for (instant = 0; instant < 86400000; instant += 15000) for (const reader of readers) {
    const peer = await reader.read();
    peer.members[0].memberId = "changed-local-copy";
    const vault = await reader.read();
    assert.equal(vault.members[0].memberId, "synthetic-member");
    assert.equal(vault.freshUntil, instant + 60000);
    reader.endRound();
  }
  assert.equal(requests, 11520); assert.equal(bodies, 2);
});

test("sharing a round never extends freshness and each next round rechecks authority", async () => {
  let instant = 0, calls = 0;
  const reader = createFingerprintRosterReader(config, { now: () => instant, fetchImpl: async () => { calls++; return Response.json({ members }); } });
  assert.equal((await reader.read()).freshUntil, 60000);
  instant = 61000;
  assert.equal((await reader.read()).freshUntil, 60000);
  reader.endRound();
  assert.equal((await reader.read()).freshUntil, 121000);
  assert.equal(calls, 2);
});

test("failed authorization and invalid conditional replies discard the old roster", async () => {
  for (const failure of [() => new Response(null, { status: 403 }), () => new Response(null, { status: 304 }), () => new Response(null, { status: 304, headers: { etag: '"other"' } }), () => Response.json({ members: null }), () => Response.json({ members: [{ memberId: "invalid" }] }), () => Response.json({ members: [...members, ...members] })]) {
    let attempt = 0;
    const reader = createFingerprintRosterReader(config, { fetchImpl: async (_url, options) => {
      attempt++;
      if (attempt === 1) return Response.json({ members }, { headers: { etag: tag } });
      if (attempt === 2) return failure();
      assert.equal(options.headers["if-none-match"], undefined);
      return new Response(null, { status: 304, headers: { etag: tag } });
    } });
    await reader.read(); reader.endRound();
    await assert.rejects(reader.read(), /could not be verified/); reader.endRound();
    await assert.rejects(reader.read(), /could not be verified/);
  }
});

test("a changed revision replaces the roster and older APIs remain compatible", async () => {
  for (const conditional of [true, false]) {
    let calls = 0;
    const reader = createFingerprintRosterReader(config, { fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers["if-none-match"], calls === 2 && conditional ? tag : undefined);
      return Response.json({ members: calls === 1 ? members : [] }, { headers: conditional ? { etag: calls === 1 ? tag : '"kiosk-roster-v1-2"' } : {} });
    } });
    await reader.read(); reader.endRound();
    assert.deepEqual((await reader.read()).members, []);
  }
});
