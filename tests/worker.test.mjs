import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../apps/api/src/worker.mjs";

test("health remains public and provides safe CORS response", async () => {
  const response = await createWorker({ allowedOrigins: ["https://dashboard.example.test"] }).fetch(new Request("https://example.test/health", { headers: { origin: "https://dashboard.example.test" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "lancerlogin-api", mode: "mock" });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://dashboard.example.test");
});

test("untrusted origins do not receive CORS permission", async () => {
  const response = await createWorker({ allowedOrigins: ["https://dashboard.example.test"] }).fetch(new Request("https://example.test/health", { headers: { origin: "https://other.example.test" } }));
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("admin routes require an authenticated principal", async () => {
  const response = await createWorker().fetch(new Request("https://example.test/admin/meetings"));
  assert.equal(response.status, 401);
});

test("operator capability checks are enforced at the HTTP boundary", async () => {
  const worker = createWorker({ authenticate: async () => ({ userId: "operator-1", role: "operator" }) });
  assert.equal((await worker.fetch(new Request("https://example.test/admin/meetings"))).status, 200);
  assert.equal((await worker.fetch(new Request("https://example.test/admin/integrations"))).status, 403);
});
