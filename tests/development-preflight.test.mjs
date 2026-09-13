import test from "node:test";
import assert from "node:assert/strict";
import { DEVELOPMENT_REPOSITORY, DEVELOPMENT_RESOURCES, developmentPreflight, parseDevelopmentArguments } from "../scripts/development-preflight.mjs";

// Synthetic provider fixtures, never real account/resource identities or credentials.
const account = "0".repeat(32);
const otherAccount = "1".repeat(32);
const token = "cfat_synthetic_test_value";
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token };
const options = { repository: DEVELOPMENT_REPOSITORY, expectedAccountId: account, env };
const kinds = { "workers/scripts": "worker", "pages/projects": "pages", "d1/database": "d1" };
function fakeProvider({ initial = [], intercept } = {}) {
  const records = [...initial];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.ok(parsed.pathname.startsWith(`/client/v4/accounts/${account}/`));
    const path = parsed.pathname.slice(`/client/v4/accounts/${account}/`.length);
    // Mirror the observed Pages limit instead of accepting an unsupported request.
    if (path === "pages/projects" && init.method === "GET" && parsed.searchParams.get("per_page") !== "10") {
      return Response.json({ success: false, errors: [{ code: 8000024 }] }, { status: 400 });
    }
    const override = await intercept?.({ path, init, records, calls, parsed });
    if (override) return override;
    let result;
    if (path === "tokens/verify") result = { status: "active" };
    else if (init.method === "GET") result = records.filter((entry) => entry.kind === kinds[path]).map(({ kind, ...entry }) => entry);
    else {
      const kind = init.method === "PUT" ? "worker" : kinds[path];
      const name = kind === "worker" ? path.split("/").at(-1) : JSON.parse(init.body).name;
      result = kind === "worker" ? { id: name } : { name, [kind === "d1" ? "uuid" : "id"]: id(records.length + 1) };
      records.push({ kind, ...result });
    }
    return Response.json({ success: true, result });
  };
  return { calls, fetchImpl, records };
}

test("report is read-only and returns only approved resource metadata", async () => {
  const provider = fakeProvider({ initial: [{ kind: "worker", id: "production-api", secret: "do not output" },
    { kind: "d1", name: DEVELOPMENT_RESOURCES[2].name, uuid: id(1), private_metadata: "do not output" }] });
  const result = await developmentPreflight({ ...options, fetchImpl: provider.fetchImpl });
  assert.equal(result.resources.length, 4);
  assert.equal(result.resources[2].id, id(1));
  assert.ok(provider.calls.every((call) => call.method === "GET"));
  assert.doesNotMatch(JSON.stringify(result), /production|private_metadata|do not output|cfat_/);
});

test("wrong repository, wrong approved account, missing identities and unsupported operations never reach provider", async () => {
  for (const change of [
    { repository: "isriah/LancerLogin" }, { repository: "example/LancerLogin/../LancerLogin" },
    { expectedAccountId: otherAccount }, { expectedAccountId: undefined },
    { env: { ...env, CLOUDFLARE_ACCOUNT_ID: "" } }, { env: { ...env, CLOUDFLARE_API_TOKEN: "" } },
    { env: { ...env, CLOUDFLARE_API_TOKEN: "cfat_bad\r\nheader" } }, { mode: "upgrade" },
  ]) {
    const provider = fakeProvider();
    await assert.rejects(developmentPreflight({ ...options, ...change, fetchImpl: provider.fetchImpl }));
    assert.equal(provider.calls.length, 0);
  }
});

test("inactive or wrong-account token fails before inventory", async () => {
  for (const status of ["expired", "disabled", undefined]) {
    const provider = fakeProvider({ intercept: () => Response.json({ success: true, result: { status } }) });
    await assert.rejects(developmentPreflight({ ...options, fetchImpl: provider.fetchImpl }), /not active/);
    assert.equal(provider.calls.length, 1);
  }
  const provider = fakeProvider({ intercept: () => Response.json({ success: false, errors: [{ message: token }] }, { status: 403 }) });
  await assert.rejects(developmentPreflight({ ...options, fetchImpl: provider.fetchImpl }), /request failed/);
  assert.equal(provider.calls.length, 1);
});

test("create refuses every existing target, duplicate names and missing or wrong IDs", async () => {
  const invalid = [
    { kind: "worker", id: DEVELOPMENT_RESOURCES[0].name },
    { kind: "pages", name: DEVELOPMENT_RESOURCES[1].name, id: id(1) },
    { kind: "d1", name: DEVELOPMENT_RESOURCES[2].name, uuid: id(2) },
    { kind: "d1", name: DEVELOPMENT_RESOURCES[3].name, uuid: id(3) },
    { kind: "d1", name: DEVELOPMENT_RESOURCES[2].name },
    { kind: "pages", name: DEVELOPMENT_RESOURCES[1].name, id: "provider-secret" },
    { kind: "d1", name: DEVELOPMENT_RESOURCES[2].name, uuid: id(2), account_id: otherAccount },
  ];
  for (const entry of invalid) {
    const provider = fakeProvider({ initial: [entry] });
    await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }));
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
  const provider = fakeProvider({ initial: [invalid[2], invalid[2]] });
  await assert.rejects(developmentPreflight({ ...options, fetchImpl: provider.fetchImpl }), /Duplicate/);
});

test("create issues only exact development names and an inert fixed Worker, then verifies IDs", async () => {
  const provider = fakeProvider();
  const result = await developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl });
  assert.ok(result.resources.every((entry) => entry.state === "exists" && entry.id));
  const writes = provider.calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 4);
  assert.equal(writes[0].method, "PUT");
  assert.ok(writes[0].url.endsWith(`/workers/scripts/${DEVELOPMENT_RESOURCES[0].name}`));
  assert.deepEqual(JSON.parse(writes[0].body.get("metadata")), { main_module: "bootstrap.mjs", compatibility_date: "2026-08-01", bindings: [] });
  assert.match(await writes[0].body.get("bootstrap.mjs").text(), /status: 503/);
  assert.deepEqual(writes.slice(1).map((call) => JSON.parse(call.body)), [
    { name: DEVELOPMENT_RESOURCES[1].name, production_branch: "main" },
    { name: DEVELOPMENT_RESOURCES[2].name }, { name: DEVELOPMENT_RESOURCES[3].name },
  ]);
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /collision/);
  assert.equal(provider.calls.filter((call) => call.method !== "GET").length, 4);
});

test("wrong creation identity stops remaining writes and preserves sanitized partial state", async () => {
  for (const result of [
    { name: "production-dashboard", id: id(1) },
    { name: DEVELOPMENT_RESOURCES[1].name },
    { name: DEVELOPMENT_RESOURCES[1].name, id: id(1), account: { id: otherAccount } },
  ]) {
    const provider = fakeProvider({ intercept: ({ init, path }) => init.method === "POST" && path === "pages/projects" ? Response.json({ success: true, result }) : undefined });
    await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), (error) => {
      assert.deepEqual(error.resources, [{ ...DEVELOPMENT_RESOURCES[0], state: "exists", id: DEVELOPMENT_RESOURCES[0].name }]);
      assert.doesNotMatch(JSON.stringify(error), /production-dashboard/);
      return true;
    });
    assert.equal(provider.calls.filter((call) => call.method !== "GET").length, 2);
  }
});

test("provider HTTP, JSON, redirects and transport errors never expose bodies or messages", async () => {
  for (const response of [
    () => Response.json({ success: false, errors: [{ message: token }] }, { status: 403 }),
    () => new Response(token),
    () => { throw new Error(`transport included ${token}`); },
    () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } }),
  ]) {
    const provider = fakeProvider({ intercept: response });
    await assert.rejects(developmentPreflight({ ...options, fetchImpl: provider.fetchImpl }), (error) => {
      assert.doesNotMatch(error.message + JSON.stringify(error), /cfat_|untrusted/);
      return true;
    });
  }
});

test("late inventory collision aborts before any write", async () => {
  let workerLists = 0;
  const provider = fakeProvider({ intercept: ({ path, records }) => {
    if (path === "workers/scripts" && ++workerLists === 2) records.push({ kind: "worker", id: DEVELOPMENT_RESOURCES[0].name });
  } });
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /collision/);
  assert.ok(provider.calls.every((call) => call.method === "GET"));
});

test("paginated collisions cannot be mistaken for absent resources", async () => {
  const provider = fakeProvider({ intercept: ({ path, parsed }) => {
    if (path !== "d1/database") return;
    return Response.json({ success: true, result: parsed.searchParams.get("page") === "1" ? [] : [{ name: DEVELOPMENT_RESOURCES[2].name, uuid: id(1) }], result_info: { total_pages: 2 } });
  } });
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /collision/);
  assert.ok(provider.calls.every((call) => call.method === "GET"));
});

test("Pages uses its supported page size and follows a full page without pagination metadata", async () => {
  const provider = fakeProvider({ intercept: ({ path, parsed }) => {
    if (path !== "pages/projects") return;
    const firstPage = Array.from({ length: 10 }, (_, index) => ({ name: `unrelated-project-${index}`, id: id(index + 1) }));
    return Response.json({ success: true, result: parsed.searchParams.get("page") === "1" ? firstPage : [{ name: DEVELOPMENT_RESOURCES[1].name, id: id(11) }] });
  } });
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /collision/);
  const pageCalls = provider.calls.filter((call) => new URL(call.url).pathname.endsWith("pages/projects"));
  assert.deepEqual(pageCalls.map((call) => new URL(call.url).search), ["?page=1&per_page=10", "?page=2&per_page=10"]);
  assert.ok(provider.calls.every((call) => call.method === "GET"));
});

test("unknown flags including production resource overrides and source inputs are rejected", () => {
  for (const args of [["--name", "production"], ["--source", "arbitrary.mjs"], ["--create", "--create"], ["--expected-account"], ["--repository", "--create"]]) {
    assert.throws(() => parseDevelopmentArguments(args));
  }
  assert.deepEqual(parseDevelopmentArguments(["--repository", DEVELOPMENT_REPOSITORY, "--expected-account", account, "--create"]), { repository: DEVELOPMENT_REPOSITORY, expectedAccountId: account, mode: "create" });
  assert.deepEqual(parseDevelopmentArguments([]), { mode: "report" });
});

test("malformed inventories and pagination fail closed before writes", async () => {
  for (const document of [
    { success: true, result: null }, { success: true, result: [{}] },
    { success: true, result: [null] },
    { success: true, result: [], result_info: { total_pages: 101 } },
    { success: true, result: [], result_info: { total_pages: "2" } },
  ]) {
    const provider = fakeProvider({ intercept: ({ path }) => path === "workers/scripts" ? Response.json(document) : undefined });
    await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }));
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
});

test("lost or replaced created resource stops subsequent writes", async () => {
  const provider = fakeProvider({ intercept: ({ path, records }) => {
    if (path === "workers/scripts" && records.length === 1) records.length = 0;
  } });
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /identity changed/);
  assert.equal(provider.calls.filter((call) => call.method !== "GET").length, 1);
});

test("final provider inventory must preserve all created identities", async () => {
  const provider = fakeProvider({ intercept: ({ path, records }) => {
    if (path === "d1/database" && records.length === 4) records[3].uuid = id(99);
  } });
  await assert.rejects(developmentPreflight({ ...options, mode: "create", fetchImpl: provider.fetchImpl }), /could not be verified/);
  assert.equal(provider.calls.filter((call) => call.method !== "GET").length, 4);
});
