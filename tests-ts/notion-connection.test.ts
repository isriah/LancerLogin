// quick-check: covers apps/api/migrations/**
// Core's shared Notion connection (notion-client.ts, module-notion.ts) against real SQLite with every Core migration:
// the client's error and uncertain-create rules, the manifest field, refusals before any request, the page-in-database
// check, email stripping, the shared pause after a rate limit, the budget charge, the per-invocation cap, capability
// records, the legacy import Part Requests uses, and the Admin functions behind Settings > Integrations > Notion.
// Notion is always a fake; no request leaves the test. Every token, ID, name and address here is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { encryptIntegration, moduleCredentials } from "../apps/api/src/integration-crypto.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import { NotionError, notionDefaultRetryAfterMs, notionMaximumRetryAfterMs, notionRequest, notionRetryAfterMs, notionTimeoutMs, notionVersion } from "../apps/api/src/notion-client.ts";
import {
  notionCallsPerInvocation, notionCommentName, notionIntegrationStatus, notionService, parseNotionCapabilities, removeNotionBinding, removeNotionConnection, saveNotionConnection, setNotionBinding, setNotionCommentName,
  withoutUserEmails, type NotionDeps, type NotionLogEntry,
} from "../apps/api/src/module-notion.ts";
import { SchedulerBudget, SchedulerBudgetError } from "../apps/api/src/scheduler-budget.ts";
import { createModuleRegistry, type ModuleDefinition, type ModuleNotionDefinition } from "../packages/shared/src/module-platform.ts";
import { decodedNotionPropertyId, formatNotionId, notionLink, parseNotionId, sameNotionId, validNotionUrl } from "../packages/shared/src/notion-ids.ts";

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherSecret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const token = "ntn_synthetic_token_0001";
const start = Date.parse("2026-11-26T12:00:00.000Z");

// Synthetic Notion IDs: `d` databases, `5` data sources, `a` pages, `c` users.
const uuid = (digit: string, last: number) => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${String(last).padStart(12, digit)}`;
const ordersDatabase = uuid("d", 1), ordersSource = uuid("5", 1), otherDatabase = uuid("d", 2), otherSource = uuid("5", 2);
const page = (last: number) => uuid("a", last);
const pageIn = (id: string, dataSourceId: string) => ({ object: "page", id, url: `https://www.notion.so/${id.replaceAll("-", "")}`, parent: { type: "data_source_id", data_source_id: dataSourceId, database_id: ordersDatabase }, properties: {} });

type Call = { method: string; path: string; body: any; authorization: string | null; version: string | null; redirect: RequestRedirect | undefined };
type Answer = { status: number; body?: unknown; headers?: Record<string, string>; text?: string } | Error;
/** A fake Notion: answers by method and path, records every request, and fails any request it was not told about. */
function fakeNotion(answers: (call: Call) => Answer | undefined) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); const headers = new Headers(init.headers);
    assert.equal(url.origin, "https://api.notion.com"); assert.ok(url.pathname.startsWith("/v1/"));
    assert.ok(init.signal, "every request to Notion has a timeout");
    const call: Call = { method: init.method ?? "GET", path: url.pathname.slice(3) + url.search, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), authorization: headers.get("authorization"), version: headers.get("notion-version"), redirect: init.redirect };
    calls.push(call);
    const answer = answers(call);
    if (!answer) throw new Error(`Unexpected request ${call.method} ${call.path}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body)), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { fetch, calls };
}

const declaration: ModuleNotionDefinition = {
  users: ["list", "retrieve"],
  bindings: [
    { id: "orders", label: "Ordering database", reason: "Part requests are added here", required: true, kind: "data_source", operations: ["retrieve", "query", "pages.create", "pages.retrieve", "pages.update", "pages.trash", "comments.create"] },
    { id: "people", label: "People database", reason: "Names are read from here", required: false, kind: "data_source", operations: ["query"] },
  ],
};
const modules = [
  { id: "part-requests", label: "Part Requests", available: true, notion: declaration },
  { id: "chores", label: "Chores", available: true, notion: { bindings: [{ id: "log", label: "Chore log", reason: "Chores are logged here", required: true, kind: "data_source", operations: ["query", "pages.create"] }] } satisfies ModuleNotionDefinition },
  { id: "attendance", label: "Attendance", available: true },
];

function setup(answers: (call: Call) => Answer | undefined = () => undefined, options: { key?: string } = {}) {
  const db = new TestD1Database();
  db.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01T00:00:00.000Z','local')");
  let now = start; const notion = fakeNotion(answers);
  const logs: NotionLogEntry[] = []; let authority = 0; let deliveryPausedUntil: number | null = null;
  const deps: NotionDeps = { db, fetch: notion.fetch, now: () => now, credentials: moduleCredentials(options.key ?? secret), authority: async () => { authority += 1; }, deliveryPausedUntil: async () => deliveryPausedUntil, log: (entry) => logs.push(entry) };
  const rows = <T = Record<string, unknown>>(sql: string, ...values: unknown[]) => db.sqlite.prepare(sql).all(...values as never[]).map((row) => ({ ...row })) as T[];
  return {
    db, deps, notion, logs, rows, authorityCalls: () => authority,
    advance(ms: number) { now += ms; }, pauseDelivery(until: number | null) { deliveryPausedUntil = until; },
    /** A new invocation: a fresh `services.notion` for the module. */
    service: (moduleId = "part-requests", definition: { notion?: ModuleNotionDefinition } | undefined = modules.find((module) => module.id === moduleId), extra: Partial<NotionDeps> = {}) => notionService({ ...deps, ...extra }, { moduleId, definition }),
    async connect(value = token, key = secret, enabled = 1) {
      const encrypted = await encryptIntegration({ token: value }, key);
      db.sqlite.prepare("INSERT INTO notion_connection(installation_id,ciphertext,iv,enabled,checked_at,updated_at) VALUES('primary',?,?,?,?,?)").run(encrypted.ciphertext, encrypted.iv, enabled, "2026-11-26T00:00:00.000Z", "2026-11-26T00:00:00.000Z");
    },
    bind(moduleId: string, bindingId: string, databaseId = ordersDatabase, dataSourceId = ordersSource) {
      db.sqlite.prepare("INSERT INTO notion_bindings(installation_id,module_id,binding_id,database_id,data_source_id,name,updated_at) VALUES('primary',?,?,?,?,'Test Orders','2026-11-26T00:00:00.000Z')").run(moduleId, bindingId, databaseId, dataSourceId);
    },
    connection: () => rows<{ enabled: number; capabilities_json: string; paused_until_ms: number; ciphertext: string; bot_name: string; workspace_name: string; revision: number; key_version: number }>("SELECT * FROM notion_connection")[0],
    audits: (action: string) => rows<{ metadata_json: string; actor_user_id: string | null; target_id: string }>("SELECT metadata_json,actor_user_id,target_id FROM audit_log WHERE action=?", action).map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) })),
  };
}
const rejectsWith = async (work: Promise<unknown>, code: string) => { await assert.rejects(work, (error: unknown) => { assert.ok(error instanceof NotionError, String(error)); assert.equal(error.code, code); return true; }); };

test("the client sends one versioned request with the token only in its header and refuses redirects", async () => {
  const notion = fakeNotion((call) => call.path === "/users/me" ? { status: 200, body: { object: "user", name: "Test Bot" } } : undefined);
  assert.deepEqual(await notionRequest(notion.fetch, token, { path: "/users/me" }), { object: "user", name: "Test Bot" });
  assert.deepEqual(notion.calls, [{ method: "GET", path: "/users/me", body: undefined, authorization: `Bearer ${token}`, version: "2026-03-11", redirect: "manual" }]);
  assert.equal(notionVersion, "2026-03-11"); assert.equal(notionTimeoutMs, 20_000);
  // Only the API families Core uses can be addressed, and nothing is sent for anything else.
  for (const path of ["/search", "/blocks/x/children", "/oauth/token", "pages", "/pages/../search"]) await rejectsWith(notionRequest(notion.fetch, token, { path }), "notion_unsupported");
  assert.equal(notion.calls.length, 1);
});

test("the client's errors are fixed text by status, and only an unconfirmed create is uncertain", async () => {
  const leaked = "synthetic-detail-from-notion";
  const failure = async (answer: Answer, creates: boolean) => {
    const notion = fakeNotion(() => answer);
    try { await notionRequest(notion.fetch, token, { path: "/pages", method: "POST", body: { properties: {} }, creates }); }
    catch (error) { assert.ok(error instanceof NotionError); assert.equal(notion.calls.length, 1, "nothing is retried"); return error; }
    throw new Error("Expected the request to fail");
  };
  const matrix: [number, string, boolean][] = [[400, "notion_400", false], [401, "notion_401", false], [403, "notion_403", false], [404, "notion_404", false], [409, "notion_409", true], [429, "notion_429", false], [500, "notion_500", true], [503, "notion_503", true], [302, "notion_302", true], [307, "notion_307", true]];
  for (const [status, code, uncertain] of matrix) {
    const created = await failure({ status, body: { object: "error", code: "x", message: leaked }, headers: status === 302 ? { location: "https://example.test/elsewhere" } : {} }, true);
    assert.equal(created.code, code); assert.equal(created.providerStatus, status); assert.equal(created.uncertain, uncertain, `create with ${status}`);
    assert.equal(created.message.includes(leaked), false, "Notion's own text is never repeated"); assert.equal(created.message.includes(token), false);
    const read = await failure({ status, body: { message: leaked } }, false);
    assert.equal(read.uncertain, false, `a request that creates nothing is never uncertain (${status})`);
    assert.equal(read.status, status === 429 ? 429 : 502);
  }
  assert.match((await failure({ status: 401 }, false)).message, /token is invalid or expired/);
  assert.match((await failure({ status: 404 }, false)).message, /Add the connection to the database/);
  // No answer at all (a network failure or the 20 second timeout) and an answer that is not JSON.
  for (const error of [new TypeError("fetch failed"), new DOMException("The operation timed out.", "TimeoutError")]) {
    const created = await failure(error, true);
    assert.equal(created.code, "notion_network"); assert.equal(created.providerStatus, undefined); assert.equal(created.uncertain, true);
    assert.equal((await failure(error, false)).uncertain, false);
  }
  for (const text of ["<html>not json</html>", "[]", "null"]) {
    const created = await failure({ status: 200, text }, true);
    assert.equal(created.code, "notion_response"); assert.equal(created.uncertain, true);
    assert.equal((await failure({ status: 200, text }, false)).uncertain, false);
  }
});

test("a rate limit carries Notion's Retry-After, bounded, and nothing else does", async () => {
  const limited = async (headers: Record<string, string>) => { try { await notionRequest(fakeNotion(() => ({ status: 429, headers })).fetch, token, { path: "/users" }); } catch (error) { return (error as NotionError).retryAfterMs; } };
  assert.equal(await limited({ "retry-after": "7" }), 7_000);
  assert.equal(await limited({ "retry-after": "0.4" }), 400);
  assert.equal(await limited({}), notionDefaultRetryAfterMs);
  assert.equal(await limited({ "retry-after": "soon" }), notionDefaultRetryAfterMs);
  assert.equal(await limited({ "retry-after": "999999" }), notionMaximumRetryAfterMs);
  assert.equal(notionRetryAfterMs(null), undefined); assert.equal(notionRetryAfterMs("-3"), undefined); assert.equal(notionRetryAfterMs(""), undefined);
  try { await notionRequest(fakeNotion(() => ({ status: 503, headers: { "retry-after": "9" } })).fetch, token, { path: "/users" }); assert.fail(); }
  catch (error) { assert.equal((error as NotionError).retryAfterMs, undefined); }
});

test("Notion IDs and links are read without following them", () => {
  assert.deepEqual(parseNotionId(`https://www.notion.so/test-workspace/Orders-${ordersDatabase.replaceAll("-", "")}?v=${otherDatabase.replaceAll("-", "")}`), { ok: true, id: ordersDatabase });
  assert.deepEqual(parseNotionId(ordersDatabase.toUpperCase()), { ok: true, id: ordersDatabase });
  assert.deepEqual(parseNotionId(`https://app.notion.com/p/${ordersDatabase}/`), { ok: true, id: ordersDatabase });
  for (const bad of ["", "   ", "not-an-id", `http://www.notion.so/${ordersDatabase}`, `https://notion.so.example.test/${ordersDatabase}`, `https://user:pass@www.notion.so/${ordersDatabase}`, "https://www.notion.so/Orders", 42, null]) assert.equal(parseNotionId(bad).ok, false, String(bad));
  assert.equal(formatNotionId(ordersDatabase.replaceAll("-", "")), ordersDatabase); assert.equal(formatNotionId("xyz"), undefined);
  assert.equal(sameNotionId(ordersDatabase, ordersDatabase.replaceAll("-", "").toUpperCase()), true); assert.equal(sameNotionId(ordersDatabase, otherDatabase), false); assert.equal(sameNotionId(undefined, undefined), false);
  assert.equal(notionLink(ordersDatabase), `https://www.notion.so/${ordersDatabase.replaceAll("-", "")}`);
  assert.equal(validNotionUrl("https://www.notion.so/abc"), "https://www.notion.so/abc"); assert.equal(validNotionUrl("https://example.test/abc"), undefined); assert.equal(validNotionUrl("javascript:alert(1)"), undefined);
  assert.equal(decodedNotionPropertyId("%3AaB%7C"), ":aB|"); assert.equal(decodedNotionPropertyId("%E0%A4%A"), "%E0%A4%A");
});

test("the manifest's notion field is validated beside uses", () => {
  const module = (notion: unknown): ModuleDefinition => ({
    id: "synthetic", label: "Synthetic", description: "Synthetic module", contractVersion: 1, available: true, dependencies: [], capabilities: [{ id: "synthetic.manage", label: "Manage", operator: true }],
    navigation: [], settings: [], setup: { version: 1, steps: [] }, jobs: [], discordCommands: [], apiRoutes: [], tablePrefix: "synthetic_",
    persistence: { tables: [], sharedFields: [], transientAuthority: [] }, backup: { version: 1, tables: [] }, lifecycle: { cleanupTargets: ["synthetic_records"] }, deletedData: [], notion: notion as never,
  });
  const binding = declaration.bindings[0]!;
  assert.deepEqual(createModuleRegistry([module(declaration)]).get("synthetic")?.notion, declaration);
  assert.ok(createModuleRegistry([module({ users: ["retrieve", "email"], bindings: [] })]));
  const refused: [unknown, RegExp][] = [
    ["orders", /Invalid module Notion declaration/], [[], /Invalid module Notion declaration/], [{ bindings: "orders" }, /Invalid module Notion declaration/],
    [{ bindings: [], extra: true }, /Invalid module Notion declaration/], [{ bindings: [] }, /Invalid module Notion declaration/], [{ bindings: [], users: [] }, /Invalid module Notion declaration/],
    [{ bindings: [binding], users: ["write"] }, /Invalid module Notion user access/], [{ bindings: [binding], users: ["list", "list"] }, /Invalid module Notion user access/],
    [{ bindings: [binding], users: ["email"] }, /Invalid module Notion user access/], [{ bindings: [binding], users: "list" }, /Invalid module Notion user access/],
    [{ bindings: [{ ...binding, id: "Orders" }] }, /Invalid module Notion binding/], [{ bindings: [{ ...binding, id: "" }] }, /Invalid module Notion binding/],
    [{ bindings: [{ ...binding, label: "" }] }, /Invalid module Notion binding/], [{ bindings: [{ ...binding, reason: " padded" }] }, /Invalid module Notion binding/],
    [{ bindings: [{ ...binding, required: "yes" }] }, /Invalid module Notion binding/], [{ bindings: [{ ...binding, kind: "page" }] }, /Invalid module Notion binding/],
    [{ bindings: [{ ...binding, databaseId: ordersDatabase }] }, /Invalid module Notion binding/], [{ bindings: [null] }, /Invalid module Notion binding/],
    [{ bindings: [{ ...binding, operations: [] }] }, /Invalid module Notion binding operations/], [{ bindings: [{ ...binding, operations: ["query", "query"] }] }, /Invalid module Notion binding operations/],
    [{ bindings: [{ ...binding, operations: ["request"] }] }, /Invalid module Notion binding operations/], [{ bindings: [{ ...binding, operations: "query" }] }, /Invalid module Notion binding operations/],
    [{ bindings: [binding, { ...binding, label: "Again" }] }, /Duplicate module Notion binding/],
  ];
  for (const [notion, pattern] of refused) assert.throws(() => createModuleRegistry([module(notion)]), pattern, JSON.stringify(notion));
});

test("an undeclared operation, an undeclared binding and an unbound binding are refused before any request", async () => {
  const fixture = setup(); await fixture.connect(); fixture.bind("part-requests", "orders");
  const service = fixture.service();
  // `people` declares only query; `log` belongs to another module; `missing` was never declared.
  await rejectsWith(service.createPage("people", { properties: { Name: {} } }), "notion_not_declared");
  await rejectsWith(service.dataSource("people"), "notion_not_declared");
  await rejectsWith(service.updatePage("people", page(1), { properties: { Name: {} } }), "notion_not_declared");
  await rejectsWith(service.trashPage("people", page(1)), "notion_not_declared");
  await rejectsWith(service.createComment("people", page(1), { richText: [{ text: { content: "Synthetic" } }] }), "notion_not_declared");
  await rejectsWith(service.page("people", page(1)), "notion_not_declared");
  await rejectsWith(service.query("log"), "notion_not_declared");
  await rejectsWith(service.query("missing"), "notion_not_declared");
  await rejectsWith(service.binding("missing"), "notion_not_declared");
  // Declared, but no Admin has chosen its database.
  await rejectsWith(service.query("people"), "notion_unbound");
  assert.equal(await service.binding("people"), undefined);
  assert.deepEqual(await service.binding("orders"), { id: "orders", databaseId: ordersDatabase, dataSourceId: ordersSource, name: "Test Orders" });
  // A module that declared no user access, and one with no notion field at all.
  const chores = fixture.service("chores");
  await rejectsWith(chores.users.list(), "notion_not_declared"); await rejectsWith(chores.users.get(uuid("c", 1)), "notion_not_declared");
  const attendance = fixture.service("attendance");
  await rejectsWith(attendance.query("orders"), "notion_not_declared");
  assert.equal(await attendance.ready(), true, "a module that needs no database is ready whenever the connection is");
  assert.equal(fixture.notion.calls.length, 0, "nothing reached Notion"); assert.equal(fixture.authorityCalls(), 0, "and nothing was charged");
  const error = await service.query("people").catch((caught: unknown) => caught);
  assert.equal(service.errorCode(error), "notion_unbound"); assert.equal(service.providerStatus(error), undefined); assert.equal(service.uncertain(error), false); assert.equal(service.retryAfterMs(error), undefined);
  assert.equal(service.errorCode(new Error("other")), undefined); assert.equal(service.uncertain(new HttpError(400, "other")), false);
});

test("queries and creates use the binding's database; the service never takes a path, parent or database from the module", async () => {
  const fixture = setup((call) => {
    if (call.path === `/data_sources/${ordersSource}/query`) return { status: 200, body: { results: [pageIn(page(1), ordersSource)], has_more: true, next_cursor: "cursor-2" } };
    if (call.path === `/data_sources/${ordersSource}`) return { status: 200, body: { object: "data_source", id: ordersSource, properties: {} } };
    if (call.path === "/pages" && call.method === "POST") return { status: 200, body: pageIn(page(2), ordersSource) };
    return undefined;
  });
  await fixture.connect(); fixture.bind("part-requests", "orders");
  const service = fixture.service();
  assert.equal((await service.dataSource("orders")).id, ordersSource);
  const listed = await service.query("orders", { filter: { property: "Status", status: { equals: "Open" } }, sorts: [{ timestamp: "created_time", direction: "ascending" }], pageSize: 25, cursor: "cursor-1" });
  assert.equal(listed.results.length, 1); assert.equal(listed.nextCursor, "cursor-2");
  const created = await service.createPage("orders", { properties: { Name: { title: [{ text: { content: "Synthetic part" } }] } }, parent: { data_source_id: otherSource }, children: [] } as never);
  assert.equal(created.id, page(2)); assert.equal(created.url, `https://www.notion.so/${page(2).replaceAll("-", "")}`);
  assert.deepEqual(fixture.notion.calls.map((call) => [call.method, call.path]), [["GET", `/data_sources/${ordersSource}`], ["POST", `/data_sources/${ordersSource}/query`], ["POST", "/pages"]]);
  assert.deepEqual(fixture.notion.calls[1]!.body, { page_size: 25, start_cursor: "cursor-1", filter: { property: "Status", status: { equals: "Open" } }, sorts: [{ timestamp: "created_time", direction: "ascending" }] });
  assert.deepEqual(fixture.notion.calls[2]!.body, { parent: { type: "data_source_id", data_source_id: ordersSource }, properties: { Name: { title: [{ text: { content: "Synthetic part" } }] } } }, "only properties are sent, under Core's own parent");
  assert.ok(fixture.notion.calls.every((call) => call.authorization === `Bearer ${token}`));
  // Anything but the four query fields, and malformed values, are refused before a request.
  for (const bad of [{ filter_properties: ["x"] }, { database_id: otherDatabase }, { pageSize: 0 }, { pageSize: 101 }, { cursor: "" }, { sorts: "created" }]) await assert.rejects(service.query("orders", bad as never), (error: unknown) => error instanceof HttpError && error.status === 400);
  for (const bad of [{}, { properties: {} }, { properties: [] }, null]) await assert.rejects(service.createPage("orders", bad as never), (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.equal(fixture.notion.calls.length, 3);
  // A reply without a results list must not read as "no rows".
  const odd = setup(() => ({ status: 200, body: { object: "list" } })); await odd.connect(); odd.bind("part-requests", "orders");
  await rejectsWith(odd.service().query("orders"), "notion_response");
});

test("a page Core returned is acted on directly; any other page costs one read, and another database's page is refused and audited", async () => {
  const pages = new Map([[page(1), ordersSource], [page(2), ordersSource], [page(3), ordersSource], [page(9), otherSource]]);
  const fixture = setup((call) => {
    if (call.path === `/data_sources/${ordersSource}/query`) return { status: 200, body: { results: [pageIn(page(1), ordersSource)], has_more: false } };
    if (call.path === "/pages" && call.method === "POST") return { status: 200, body: pageIn(page(2), ordersSource) };
    if (call.path === "/comments" && call.method === "POST") return { status: 200, body: { object: "comment", id: uuid("e", 1) } };
    const id = /^\/pages\/([0-9a-f-]{36})$/.exec(call.path)?.[1];
    if (id && pages.has(id)) return { status: 200, body: pageIn(id, pages.get(id)!) };
    return undefined;
  });
  await fixture.connect(); fixture.bind("part-requests", "orders");
  let service = fixture.service();
  const sent = () => fixture.notion.calls.map((call) => `${call.method} ${call.path}`);
  const since = (count: number) => sent().slice(count);

  // Hit: a row the query returned, and the row a create returned, need no check.
  await service.query("orders"); await service.createPage("orders", { properties: { Name: {} } });
  let before = sent().length;
  await service.updatePage("orders", page(1), { properties: { Status: { status: { name: "Ordered" } } }, archived: true, parent: { data_source_id: otherSource } } as never);
  await service.createComment("orders", page(2), { richText: [{ text: { content: "Synthetic comment" } }] });
  await service.trashPage("orders", page(2).replaceAll("-", "").toUpperCase());
  assert.deepEqual(since(before), [`PATCH /pages/${page(1)}`, "POST /comments", `PATCH /pages/${page(2)}`], "a known page costs no extra request");
  assert.deepEqual(fixture.notion.calls[before]!.body, { properties: { Status: { status: { name: "Ordered" } } } }, "an update sends only properties");
  assert.deepEqual(fixture.notion.calls[before + 1]!.body, { parent: { page_id: page(2) }, rich_text: [{ text: { content: "Synthetic comment" } }], display_name: { type: "custom", custom: { name: "Part Requests" } } });
  assert.deepEqual(fixture.notion.calls[before + 2]!.body, { in_trash: true }, "a trash sends only in_trash");

  // Miss: a page this invocation has not seen costs one read of its parent, once. What an earlier invocation learned
  // does not carry over.
  service = fixture.service(); before = sent().length;
  await service.updatePage("orders", page(3), { properties: { Qty: { number: 2 } } });
  await service.updatePage("orders", page(3), { properties: { Qty: { number: 3 } } });
  assert.deepEqual(since(before), [`GET /pages/${page(3)}`, `PATCH /pages/${page(3)}`, `PATCH /pages/${page(3)}`]);
  // Reading a page is its own check: one request either way.
  before = sent().length;
  assert.equal((await service.page("orders", page(1))).id, page(1));
  assert.deepEqual(since(before), [`GET /pages/${page(1)}`]);

  // Mismatch: a page of another database is refused before any write, and the refusal is audited without the page ID.
  service = fixture.service(); before = sent().length;
  await rejectsWith(service.updatePage("orders", page(9), { properties: { Qty: { number: 1 } } }), "notion_out_of_scope");
  await rejectsWith(service.trashPage("orders", page(9)), "notion_out_of_scope");
  await rejectsWith(service.createComment("orders", page(9), { richText: [{ text: { content: "Synthetic" } }] }), "notion_out_of_scope");
  await rejectsWith(service.page("orders", page(9)), "notion_out_of_scope");
  assert.deepEqual(since(before), Array(4).fill(`GET /pages/${page(9)}`), "only the parent was read; nothing was written");
  const audits = fixture.audits("integration.notion_refused");
  assert.deepEqual(audits.map((audit) => audit.metadata), ["pages.update", "pages.trash", "comments.create", "pages.retrieve"].map((operation) => ({ moduleId: "part-requests", binding: "orders", operation, reason: "page-outside-binding" })));
  assert.ok(audits.every((audit) => audit.actor_user_id === null && audit.target_id === "notion" && !audit.metadata_json.includes(page(9))));
  await assert.rejects(service.updatePage("orders", "not-a-page", { properties: { Qty: {} } }), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test("email addresses reach only a module that declared email", async () => {
  const people = [
    { object: "user", id: uuid("c", 1), type: "person", name: "Test Student A", avatar_url: "https://example.test/a.png", person: { email: "test.student.a@example.test" } },
    { object: "user", id: uuid("c", 2), type: "bot", name: "Test Bot", bot: { owner: { type: "workspace" }, workspace_name: "Test Workspace" } },
  ];
  const fixture = setup((call) => call.path.startsWith("/users?") ? { status: 200, body: { results: people, has_more: true, next_cursor: "next-users" } } : call.path === `/users/${uuid("c", 1)}` ? { status: 200, body: people[0] } : undefined);
  await fixture.connect();
  const plain = fixture.service("part-requests");
  const listed = await plain.users.list({ cursor: "start here", pageSize: 50 });
  assert.deepEqual(listed, { users: [{ id: uuid("c", 1), type: "person", name: "Test Student A" }, { id: uuid("c", 2), type: "bot", name: "Test Bot" }], nextCursor: "next-users" });
  assert.deepEqual(await plain.users.get(uuid("c", 1)), { id: uuid("c", 1), type: "person", name: "Test Student A" });
  assert.equal(JSON.stringify([listed, await plain.users.get(uuid("c", 1))]).includes("example.test"), false);
  assert.equal(fixture.notion.calls[0]!.path, "/users?page_size=50&start_cursor=start%20here");
  const withEmail = fixture.service("part-requests", { notion: { ...declaration, users: ["list", "retrieve", "email"] } });
  assert.deepEqual((await withEmail.users.list()).users[0], { id: uuid("c", 1), type: "person", name: "Test Student A", email: "test.student.a@example.test" });
  assert.equal((await withEmail.users.get(uuid("c", 1))).email, "test.student.a@example.test");
  // Core saw addresses in the answer, so the capability is recorded whoever asked.
  assert.deepEqual(parseNotionCapabilities(fixture.connection()!.capabilities_json), { read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "ok", email: "ok" });
  await assert.rejects(plain.users.get("nobody"), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test("a rate limit pauses every module until the time Notion named, and the pause is shared through the connection", async () => {
  let limited = true;
  const fixture = setup((call) => call.path.endsWith("/query") ? limited ? { status: 429, headers: { "retry-after": "30" } } : { status: 200, body: { results: [] } } : undefined);
  await fixture.connect(); fixture.bind("part-requests", "orders"); fixture.bind("chores", "log", otherDatabase, otherSource);
  const partRequests = fixture.service("part-requests");
  const first = await partRequests.query("orders").catch((error: unknown) => error);
  assert.equal(partRequests.errorCode(first), "notion_429"); assert.equal(partRequests.providerStatus(first), 429); assert.equal(partRequests.retryAfterMs(first), 30_000);
  assert.equal(fixture.connection()!.paused_until_ms, start + 30_000);
  // The same invocation, and another module in a new invocation, are held without a request.
  await rejectsWith(partRequests.query("orders"), "notion_paused");
  fixture.advance(10_000); limited = false;
  const chores = fixture.service("chores");
  const held = await chores.query("log").catch((error: unknown) => error);
  assert.equal(chores.errorCode(held), "notion_paused"); assert.equal(chores.providerStatus(held), 429); assert.equal(chores.retryAfterMs(held), 20_000);
  assert.equal((await chores.status()).pausedUntilMs, start + 30_000);
  assert.equal(fixture.notion.calls.length, 1, "only the rate-limited request was sent");
  fixture.advance(20_000);
  assert.deepEqual(await fixture.service("chores").query("log"), { results: [] });
  assert.equal((await fixture.service("part-requests").status()).pausedUntilMs, null);
  assert.equal(fixture.notion.calls.length, 2);
});

test("each Notion request is charged to the scheduler budget, and one invocation sends at most eight", async () => {
  const fixture = setup((call) => call.path.endsWith("/query") ? { status: 200, body: { results: [] } } : undefined);
  await fixture.connect(); fixture.bind("part-requests", "orders");
  fixture.db.sqlite.exec(`UPDATE notion_connection SET capabilities_json='{"read":"ok"}'`);
  // As the Worker wires it: the authority check charges one provider request before each call.
  const budget = new SchedulerBudget({ total: 20, reserve: 2, d1: 20, external: 3 });
  const charged = fixture.service("part-requests", undefined, { db: budget.database(fixture.db), authority: async () => budget.chargeExternal() });
  await charged.query("orders"); await charged.query("orders");
  assert.equal(budget.external, 2, "one provider request per Notion call"); assert.equal(budget.d1, 1, "the connection and bindings are one read per invocation");
  // A refusal charges nothing.
  await rejectsWith(charged.query("people"), "notion_unbound"); await rejectsWith(charged.createPage("people", { properties: { Name: {} } }), "notion_not_declared");
  assert.equal(budget.external, 2);
  // At the budget's limit the request is refused before it is sent.
  const tight = new SchedulerBudget({ total: 3, reserve: 2, d1: 3, external: 3 });
  const refused = fixture.service("part-requests", undefined, { authority: async () => tight.chargeExternal() });
  await refused.query("orders");
  await assert.rejects(refused.query("orders"), SchedulerBudgetError);
  assert.equal(fixture.notion.calls.length, 3);

  assert.equal(notionCallsPerInvocation, 8);
  const capped = fixture.service(); const before = fixture.notion.calls.length;
  for (let index = 0; index < notionCallsPerInvocation; index += 1) await capped.query("orders");
  const over = await capped.query("orders").catch((error: unknown) => error);
  assert.equal(capped.errorCode(over), "notion_call_limit"); assert.equal(capped.providerStatus(over), undefined);
  assert.equal(fixture.notion.calls.length - before, notionCallsPerInvocation, "the ninth call was not sent");
  await fixture.service().query("orders");
  assert.equal(fixture.notion.calls.length - before, notionCallsPerInvocation + 1, "the next invocation starts again");
});

test("capabilities are recorded from real traffic and written only when they change; logs carry module, operation and status", async () => {
  let createStatus = 403;
  const fixture = setup((call) => {
    if (call.path.endsWith("/query")) return { status: 200, body: { results: [pageIn(page(1), ordersSource)] } };
    if (call.path === "/pages") return createStatus === 200 ? { status: 200, body: pageIn(page(2), ordersSource) } : { status: createStatus, body: { code: "restricted_resource", message: "synthetic-detail" } };
    if (call.method === "PATCH") return { status: 200, body: pageIn(page(1), ordersSource) };
    if (call.path === "/comments") return { status: 403 };
    return undefined;
  });
  await fixture.connect(); fixture.bind("part-requests", "orders");
  const capabilities = () => parseNotionCapabilities(fixture.connection()!.capabilities_json);
  const writes: string[] = [];
  const watched = { ...fixture.deps, db: { prepare: (sql: string) => { if (/^\s*UPDATE notion_connection/i.test(sql)) writes.push(sql); return fixture.db.prepare(sql); }, batch: (statements: never[]) => fixture.db.batch(statements) } as never };
  const service = notionService(watched, { moduleId: "part-requests", definition: modules[0] });
  await service.query("orders"); await service.query("orders");
  await rejectsWith(service.createPage("orders", { properties: { Name: {} } }), "notion_403");
  await rejectsWith(service.createPage("orders", { properties: { Name: {} } }), "notion_403");
  await service.updatePage("orders", page(1), { properties: { Qty: { number: 1 } } });
  await rejectsWith(service.createComment("orders", page(1), { richText: [{ text: { content: "Synthetic" } }] }), "notion_403");
  assert.deepEqual(capabilities(), { read: "ok", insert: "refused", update: "ok", comment: "refused", users: "unknown", email: "unknown" });
  assert.equal(writes.length, 4, "one write per capability that changed, none for a repeat");
  // A later success replaces a refusal, in another invocation that starts from the saved record.
  createStatus = 200;
  const later = notionService(watched, { moduleId: "part-requests", definition: modules[0] });
  await later.query("orders"); await later.createPage("orders", { properties: { Name: {} } });
  assert.equal(capabilities().insert, "ok"); assert.equal(writes.length, 5);
  // Other failures say nothing about a capability.
  createStatus = 500;
  await rejectsWith(later.createPage("orders", { properties: { Name: {} } }), "notion_500");
  assert.equal(capabilities().insert, "ok");
  assert.deepEqual((await later.status()).capabilities, capabilities());

  assert.deepEqual(fixture.logs.slice(0, 4), [{ module: "part-requests", operation: "query", status: 200 }, { module: "part-requests", operation: "query", status: 200 }, { module: "part-requests", operation: "pages.create", status: 403 }, { module: "part-requests", operation: "pages.create", status: 403 }]);
  const logged = JSON.stringify(fixture.logs);
  for (const secretText of [token, ordersSource, ordersDatabase, page(1), "synthetic-detail", "Synthetic"]) assert.equal(logged.includes(secretText), false, `logs never carry ${secretText}`);
  assert.ok(fixture.logs.every((entry) => Object.keys(entry).sort().join() === "module,operation,status"));
});

test("a missing, turned-off or unreadable connection refuses every call, and writes wait while delivery is paused", async () => {
  const fixture = setup((call) => call.path.endsWith("/query") ? { status: 200, body: { results: [] } } : call.path === "/pages" ? { status: 200, body: pageIn(page(2), ordersSource) } : undefined);
  fixture.bind("part-requests", "orders");
  let service = fixture.service();
  await rejectsWith(service.query("orders"), "notion_not_configured");
  assert.equal(await service.ready(), false);
  assert.deepEqual(await service.status(), { connected: false, saved: false, enabled: false, readable: false, pausedUntilMs: null, capabilities: parseNotionCapabilities("{}"), bindings: [{ id: "orders", required: true, bound: true }, { id: "people", required: false, bound: false }] });
  await fixture.connect(token, secret, 0);
  service = fixture.service();
  await rejectsWith(service.query("orders"), "notion_disabled");
  assert.equal(await service.ready(), false); assert.equal((await service.status()).enabled, false); assert.equal((await service.status()).saved, true);
  fixture.db.sqlite.exec("UPDATE notion_connection SET enabled=1");
  // The same row read with another integration key, as after a restore onto another installation.
  const unreadable = notionService({ ...fixture.deps, credentials: moduleCredentials(otherSecret) }, { moduleId: "part-requests", definition: modules[0] });
  await rejectsWith(unreadable.query("orders"), "notion_unreadable");
  assert.equal((await unreadable.status()).readable, false); assert.equal(await unreadable.ready(), false);
  const noKey = notionService({ ...fixture.deps, credentials: moduleCredentials(undefined) }, { moduleId: "part-requests", definition: modules[0] });
  await rejectsWith(noKey.query("orders"), "notion_unreadable");
  assert.equal(fixture.notion.calls.length, 0);

  service = fixture.service();
  assert.equal(await service.ready(), true);
  fixture.db.sqlite.exec("DELETE FROM notion_bindings");
  assert.equal(await fixture.service().ready(), false, "a required binding without a database is not ready");
  fixture.bind("part-requests", "orders");
  // Outbound delivery paused (an Admin's Stop, or after a restore): reads go on, writes are refused before a request.
  fixture.pauseDelivery(start + 60_000);
  service = fixture.service();
  assert.equal(await service.ready(), false);
  assert.deepEqual(await service.query("orders"), { results: [] });
  for (const write of [service.createPage("orders", { properties: { Name: {} } }), service.updatePage("orders", page(1), { properties: { Name: {} } }), service.trashPage("orders", page(1)), service.createComment("orders", page(1), { richText: [{}] })]) {
    await assert.rejects(write, (error: unknown) => error instanceof HttpError && error.status === 409 && /delivery is paused/.test(error.message));
  }
  assert.equal(fixture.notion.calls.length, 1);
  fixture.pauseDelivery(null);
  assert.equal((await fixture.service().createPage("orders", { properties: { Name: {} } })).id, page(2));
});

test("only Part Requests may import its token, into an empty connection, keeping only databases Notion confirms", async () => {
  // Notion's view: each data source and the database it belongs to. `people` is claimed under the wrong database.
  const parents = new Map([[ordersSource, ordersDatabase], [otherSource, otherDatabase]]);
  const fixture = setup((call) => {
    if (call.path === "/users/me") return call.authorization === "Bearer ntn_plugin_token_0002" ? { status: 200, body: { object: "user", name: "Test Bot", bot: { workspace_name: "Test Workspace" } } } : { status: 401 };
    const source = /^\/data_sources\/([0-9a-f-]{36})$/.exec(call.path)?.[1];
    if (source) return parents.has(source) ? { status: 200, body: { object: "data_source", id: source, parent: { type: "database_id", database_id: parents.get(source) } } } : { status: 404 };
    return undefined;
  });
  const plugin = await encryptIntegration({ token: "ntn_plugin_token_0002" }, secret);
  const orders = { id: "orders", databaseId: ordersDatabase.replaceAll("-", ""), dataSourceId: ordersSource, name: "  Test Orders  " };
  const bindings = [orders];
  // Allow-list: any other module is refused before anything is read.
  await assert.rejects(fixture.service("chores").importLegacyConnection({ ...plugin, bindings: [] }), (error: unknown) => error instanceof HttpError && error.status === 403);
  // Malformed input, and a binding the module did not declare.
  for (const bad of [{ ciphertext: "", iv: plugin.iv }, { ciphertext: plugin.ciphertext }, { ...plugin, bindings: "orders" }, { ...plugin, bindings: [{ ...orders, id: "log" }] }, { ...plugin, bindings: [{ ...orders, dataSourceId: "x" }] }, { ...plugin, bindings: [orders, orders] }, null]) {
    await assert.rejects(fixture.service().importLegacyConnection(bad as never), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
  // Unreadable: encrypted with another key, garbage, or a token Notion no longer accepts.
  assert.equal(await fixture.service().importLegacyConnection({ ...await encryptIntegration({ token: "ntn_plugin_token_0002" }, otherSecret), bindings }), "unreadable");
  assert.equal(await fixture.service().importLegacyConnection({ ciphertext: "AAAA", iv: "AAAA", bindings }), "unreadable");
  assert.equal(await fixture.service().importLegacyConnection({ ...await encryptIntegration({ token: "ntn_revoked_token_0003" }, secret), bindings }), "unreadable");
  assert.equal(fixture.connection(), undefined); assert.equal(fixture.rows("SELECT * FROM notion_bindings").length, 0);

  // Empty connection: the token is checked with Notion and saved under Core's key. A database is kept only when Notion
  // says the data source belongs to it: `people` names a data source of another database, and is left unchosen.
  const mismatched = { id: "people", databaseId: ordersDatabase, dataSourceId: otherSource };
  const service = fixture.service();
  assert.equal(await service.importLegacyConnection({ ...plugin, bindings: [orders, mismatched] }), "imported");
  assert.deepEqual(fixture.notion.calls.slice(-3).map((call) => call.path), ["/users/me", `/data_sources/${ordersSource}`, `/data_sources/${otherSource}`]);
  assert.ok(fixture.notion.calls.slice(-3).every((call) => call.authorization === "Bearer ntn_plugin_token_0002"), "the plugin's own token proves its own databases");
  const saved = fixture.connection()!;
  assert.equal(saved.enabled, 1); assert.equal(saved.bot_name, "Test Bot"); assert.equal(saved.workspace_name, "Test Workspace"); assert.equal(saved.revision, 1);
  assert.notEqual(saved.ciphertext, plugin.ciphertext, "Core encrypts its own copy"); assert.equal(JSON.stringify(saved).includes("ntn_plugin"), false);
  assert.deepEqual(fixture.rows("SELECT module_id,binding_id,database_id,data_source_id,name FROM notion_bindings"), [{ module_id: "part-requests", binding_id: "orders", database_id: ordersDatabase, data_source_id: ordersSource, name: "Test Orders" }]);
  assert.deepEqual(fixture.audits("integration.notion_imported").map((audit) => audit.metadata), [{ moduleId: "part-requests", outcome: "imported", bindings: ["orders"] }]);
  assert.deepEqual(await service.binding("orders"), { id: "orders", databaseId: ordersDatabase, dataSourceId: ordersSource, name: "Test Orders" }, "the same invocation sees what it imported");
  assert.equal(await service.binding("people"), undefined);

  // Core already has a connection: nothing is changed and no database is chosen on the plugin's word, even one Core's
  // token could read. An Admin chooses them.
  const second = await encryptIntegration({ token: "ntn_other_token_0004" }, secret);
  const before = fixture.notion.calls.length;
  assert.equal(await fixture.service().importLegacyConnection({ ...second, bindings: [{ id: "people", databaseId: otherDatabase, dataSourceId: otherSource }] }), "kept-existing");
  assert.equal(fixture.notion.calls.length, before, "an existing connection is not even asked");
  assert.equal(fixture.connection()!.ciphertext, saved.ciphertext);
  assert.deepEqual(fixture.rows("SELECT binding_id FROM notion_bindings").map((row) => row.binding_id), ["orders"]);
  assert.deepEqual(fixture.audits("integration.notion_imported")[1]!.metadata, { moduleId: "part-requests", outcome: "kept-existing", bindings: [] });
  assert.equal(JSON.stringify(fixture.rows("SELECT * FROM audit_log")).includes("ntn_"), false);

  // A database an Admin chose before the token arrived is left alone, and the import does not claim to have bound it.
  const early = setup((call) => call.path === "/users/me" ? { status: 200, body: { name: "Test Bot" } } : call.path === `/data_sources/${ordersSource}` ? { status: 200, body: { parent: { type: "database_id", database_id: ordersDatabase } } } : undefined);
  early.bind("part-requests", "orders", otherDatabase, otherSource);
  assert.equal(await early.service().importLegacyConnection({ ...plugin, bindings }), "imported");
  assert.deepEqual(early.rows("SELECT data_source_id FROM notion_bindings"), [{ data_source_id: otherSource }]);
  assert.deepEqual(early.audits("integration.notion_imported")[0]!.metadata.bindings, [], "only rows the import wrote are reported");
  // A data source Notion will not show the plugin's token is skipped; a failure that proves nothing stops the import.
  const hidden = setup((call) => call.path === "/users/me" ? { status: 200, body: { name: "Test Bot" } } : { status: 404 });
  assert.equal(await hidden.service().importLegacyConnection({ ...plugin, bindings }), "imported");
  assert.equal(hidden.rows("SELECT * FROM notion_bindings").length, 0);
  const down = setup((call) => call.path === "/users/me" ? { status: 200, body: { name: "Test Bot" } } : { status: 503 });
  await rejectsWith(down.service().importLegacyConnection({ ...plugin, bindings }), "notion_503");
  assert.equal(down.connection(), undefined, "nothing is saved when Notion could not confirm the databases");
});

test("pages and data sources come back without email addresses unless the module declared email", async () => {
  const person = (last: number, email: string) => ({ object: "user", id: uuid("c", last), type: "person", name: `Test Student ${last}`, person: { email } });
  const row = (id: string) => ({
    ...pageIn(id, ordersSource), created_by: person(1, "test.student.a@example.test"), last_edited_by: { object: "user", id: uuid("c", 2) },
    properties: {
      Recipient: { id: "a%3Ab", type: "people", people: [person(1, "test.student.a@example.test"), person(2, "test.student.b@example.test")] },
      Editor: { id: "c", type: "last_edited_by", last_edited_by: person(2, "test.student.b@example.test") },
      Seen: { id: "d", type: "rollup", rollup: { type: "array", array: [{ type: "people", people: [person(1, "test.student.a@example.test")] }] } },
      // Not a user object: a property that happens to be called person is left alone.
      Notes: { id: "e", type: "rich_text", rich_text: [{ plain_text: "Synthetic note", person: "kept" }] },
    },
  });
  const fixture = setup((call) => {
    if (call.path.endsWith("/query")) return { status: 200, body: { results: [row(page(1))] } };
    if (call.path === `/data_sources/${ordersSource}`) return { status: 200, body: { object: "data_source", id: ordersSource, created_by: person(1, "test.student.a@example.test"), properties: {} } };
    if (call.path === "/pages" || call.path.startsWith("/pages/")) return { status: 200, body: row(page(1)) };
    return undefined;
  });
  await fixture.connect(); fixture.bind("part-requests", "orders");
  const everything = async (service: ReturnType<typeof fixture.service>) => [
    (await service.query("orders")).results, await service.page("orders", page(1)), (await service.createPage("orders", { properties: { Name: {} } })).page,
    await service.updatePage("orders", page(1), { properties: { Name: {} } }), await service.dataSource("orders"),
  ];
  const plain = await everything(fixture.service());
  assert.equal(JSON.stringify(plain).includes("example.test"), false, "no email address reaches a module that did not declare email");
  assert.equal(JSON.stringify(plain).includes('"person":{'), false);
  const first = (plain[0] as any[])[0];
  assert.deepEqual(first.properties.Recipient.people, [{ object: "user", id: uuid("c", 1), type: "person", name: "Test Student 1" }, { object: "user", id: uuid("c", 2), type: "person", name: "Test Student 2" }], "names and IDs stay");
  assert.deepEqual(first.created_by, { object: "user", id: uuid("c", 1), type: "person", name: "Test Student 1" });
  assert.deepEqual(first.properties.Notes.rich_text, [{ plain_text: "Synthetic note", person: "kept" }]);
  assert.equal(first.id, page(1)); assert.deepEqual(first.parent, pageIn(page(1), ordersSource).parent);
  const declaredEmail = await everything(fixture.service("part-requests", { notion: { ...declaration, users: ["list", "retrieve", "email"] } }));
  assert.deepEqual((declaredEmail[0] as any[])[0], row(page(1)), "a module that declared email receives Notion's JSON as it is");
  assert.equal((declaredEmail[4] as any).created_by.person.email, "test.student.a@example.test");
  // The helper copies; it never changes what it was given.
  const original = row(page(1)); const copy = withoutUserEmails(original);
  assert.equal(original.properties.Recipient.people[0]!.person.email, "test.student.a@example.test"); assert.notEqual(copy, original);
  assert.deepEqual(withoutUserEmails([null, 1, "x", { object: "user", person: { email: "test.student.a@example.test" }, name: "Test" }]), [null, 1, "x", { object: "user", name: "Test" }]);
});

test("a call still in flight on a replaced token cannot mark the new token paused or refused", async () => {
  let answer: Answer = { status: 200, body: { results: [] } }; let replace = false;
  const fixture = setup((call) => {
    if (!call.path.endsWith("/query")) return undefined;
    // While Notion is answering the old token, an Admin saves another one.
    if (replace) fixture.db.sqlite.exec("UPDATE notion_connection SET ciphertext='new-ciphertext',iv='new-iv',capabilities_json='{}',paused_until_ms=0");
    return answer;
  });
  await fixture.connect(); fixture.bind("part-requests", "orders");
  const service = fixture.service();
  await service.query("orders");
  assert.equal(parseNotionCapabilities(fixture.connection()!.capabilities_json).read, "ok", "the token in use records what it allows");
  replace = true; answer = { status: 429, headers: { "retry-after": "30" } };
  await rejectsWith(service.query("orders"), "notion_429");
  assert.equal(fixture.connection()!.paused_until_ms, 0, "the old token's rate limit does not pause the new token");
  await rejectsWith(service.query("orders"), "notion_paused");
  const second = fixture.service(undefined, undefined, { credentials: { available: true, encrypt: fixture.deps.credentials.encrypt, decrypt: async () => ({ token }) } });
  // An invocation that loaded the old row, then saw a 403 after the swap.
  fixture.db.sqlite.exec("UPDATE notion_connection SET ciphertext='older-ciphertext'");
  await second.status();
  answer = { status: 403 };
  await rejectsWith(second.query("orders"), "notion_403");
  assert.deepEqual(parseNotionCapabilities(fixture.connection()!.capabilities_json), parseNotionCapabilities("{}"), "nor does its refusal mark the new token");
  assert.equal(fixture.connection()!.ciphertext, "new-ciphertext");
});

test("an Admin's change is refused when the connection changed since the page loaded, and a token save never undoes a turn-off", async () => {
  let duringCheck: (() => void) | undefined;
  const fixture = setup((call) => {
    if (call.path === "/users/me") { duringCheck?.(); return { status: 200, body: { name: "Test Bot" } }; }
    if (call.path === "/users?page_size=1") return { status: 200, body: { results: [] } };
    return undefined;
  });
  const changed = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "notion_connection_changed";
  const revision = () => fixture.connection()?.revision ?? 0;
  // Nothing saved: only revision 0 may create the connection, and a second first save racing the first is refused.
  await assert.rejects(saveNotionConnection(fixture.deps, { token, revision: 3 }), changed);
  assert.equal(fixture.notion.calls.length, 0, "a stale page does not even reach Notion");
  duringCheck = () => { duringCheck = undefined; fixture.db.sqlite.exec("INSERT INTO notion_connection(installation_id,ciphertext,iv,enabled,checked_at,revision,updated_at) VALUES('primary','first-ciphertext','first-iv',0,'2026-11-26T00:00:00.000Z',1,'2026-11-26T00:00:00.000Z')"); };
  await assert.rejects(saveNotionConnection(fixture.deps, { token, revision: 0 }), changed);
  assert.equal(fixture.connection()!.ciphertext, "first-ciphertext", "the connection saved first is left as it is");
  fixture.db.sqlite.exec("DELETE FROM notion_connection");
  assert.equal(await saveNotionConnection(fixture.deps, { token, revision: 0 }), "saved");
  assert.equal(revision(), 1); assert.equal(fixture.connection()!.enabled, 1, "a new connection starts turned on");
  assert.equal(await saveNotionConnection(fixture.deps, { token, enabled: false, revision: 1 }), "saved");
  assert.equal(fixture.connection()!.enabled, 0, "an explicit enabled is honoured"); assert.equal(revision(), 2);

  // Each kind of change from a page that loaded an older revision is refused, and writes nothing.
  const stale = JSON.stringify(fixture.connection());
  for (const body of [{ token }, { enabled: true }, { check: true }]) await assert.rejects(saveNotionConnection(fixture.deps, { ...body, revision: 1 }), changed, JSON.stringify(body));
  assert.equal(JSON.stringify(fixture.connection()), stale);
  // Another Admin turns the connection off while this save is checking its token with Notion: the save is refused.
  assert.equal(await saveNotionConnection(fixture.deps, { enabled: true, revision: 2 }), "enabled");
  duringCheck = () => { duringCheck = undefined; void saveNotionConnection({ ...fixture.deps, fetch: (async () => { throw new Error("no request needed"); }) as never }, { enabled: false, revision: 3 }); };
  const racing = saveNotionConnection(fixture.deps, { token, revision: 3 });
  await assert.rejects(racing, changed);
  assert.equal(fixture.connection()!.enabled, 0, "the turn-off stands"); assert.equal(revision(), 4);
  // Even a turn-off the revision could not see (written without moving it) survives a token save that did not ask to change it.
  fixture.db.sqlite.exec("UPDATE notion_connection SET enabled=1");
  duringCheck = () => { duringCheck = undefined; fixture.db.sqlite.exec("UPDATE notion_connection SET enabled=0"); };
  assert.equal(await saveNotionConnection(fixture.deps, { token, revision: 4 }), "saved");
  assert.equal(fixture.connection()!.enabled, 0, "the save keeps the switch as the database has it"); assert.equal(revision(), 5);
  assert.equal(await saveNotionConnection(fixture.deps, { token, enabled: true, revision: 5 }), "saved");
  assert.equal(fixture.connection()!.enabled, 1);
  // Module traffic (capabilities, the pause) does not move the revision, so it never blocks an Admin.
  fixture.bind("part-requests", "orders");
  await fixture.service().query("orders").catch(() => undefined);
  assert.equal(revision(), 6);
  assert.equal(await saveNotionConnection(fixture.deps, { check: true, revision: 6 }), "checked");
});

test("an Admin saves, checks, turns off and removes the connection, and the token is never returned", async () => {
  let users: Answer = { status: 200, body: { results: [{ id: uuid("c", 1), type: "person", name: "Test Student A", person: {} }] } };
  const fixture = setup((call) => {
    if (call.path === "/users/me") return call.authorization === `Bearer ${token}` ? { status: 200, body: { object: "user", name: " Test Bot ", bot: { workspace_name: "Test Workspace" } } } : { status: 401 };
    if (call.path === "/users?page_size=1") return users;
    return undefined;
  });
  const status = () => notionIntegrationStatus(fixture.deps, modules);
  // As the page does: each change carries the revision it last loaded.
  const save = (deps: NotionDeps, value: unknown) => saveNotionConnection(deps, value && typeof value === "object" && !Array.isArray(value) ? { revision: fixture.connection()?.revision ?? 0, ...value } : value);
  await assert.rejects(saveNotionConnection(fixture.deps, { token }), /Send the revision this page loaded/);
  for (const revision of [-1, 1.5, "0", null]) await assert.rejects(saveNotionConnection(fixture.deps, { token, revision }), (error: unknown) => error instanceof HttpError && error.status === 400);
  const empty = await status();
  assert.deepEqual({ saved: empty.saved, enabled: empty.enabled, readable: empty.readable, encryption: empty.encryption, checkedAt: empty.checkedAt }, { saved: false, enabled: false, readable: false, encryption: true, checkedAt: null });
  assert.deepEqual(empty.bindings.map((binding) => [binding.moduleId, binding.id, binding.bound]), [["part-requests", "orders", false], ["part-requests", "people", false], ["chores", "log", false]]);

  for (const bad of [null, [], { token: "" }, { token: "short" }, { token: "has space in the token" }, { token, extra: 1 }, { token, check: true }, { enabled: "yes" }, { check: false }, {}]) await assert.rejects(save(fixture.deps, bad), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(bad));
  await assert.rejects(save(fixture.deps, { enabled: true }), /Save a Notion token first/);
  await assert.rejects(save(fixture.deps, { token: "ntn_wrong_token_0009" }), (error: unknown) => error instanceof HttpError && error.status === 400 && /did not accept this token/.test(error.message));
  await assert.rejects(save({ ...fixture.deps, credentials: moduleCredentials(undefined) }, { token }), (error: unknown) => error instanceof HttpError && error.status === 503);
  assert.equal(fixture.connection(), undefined, "a refused token saves nothing");

  assert.equal(await save(fixture.deps, { token: `  ${token} ` }), "saved");
  const saved = await status();
  assert.deepEqual({ saved: saved.saved, enabled: saved.enabled, readable: saved.readable, botName: saved.botName, workspaceName: saved.workspaceName, checkedAt: saved.checkedAt }, { saved: true, enabled: true, readable: true, botName: "Test Bot", workspaceName: "Test Workspace", checkedAt: new Date(start).toISOString() });
  assert.deepEqual(saved.capabilities, { read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "ok", email: "refused" }, "people without addresses show the email capability is missing");
  assert.equal(JSON.stringify(saved).includes(token), false); assert.equal(JSON.stringify(fixture.connection()).includes(token), false, "only ciphertext is stored");
  assert.equal(fixture.authorityCalls(), 0, "an Admin's check is not charged to a module");

  // Check again: the user capability is now refused; what real traffic recorded is kept.
  fixture.db.sqlite.exec(`UPDATE notion_connection SET capabilities_json='{"read":"ok","users":"ok","email":"ok"}'`);
  users = { status: 403 }; fixture.advance(60_000);
  assert.equal(await save(fixture.deps, { check: true }), "checked");
  const checked = await status();
  assert.deepEqual(checked.capabilities, { read: "ok", insert: "unknown", update: "unknown", comment: "unknown", users: "refused", email: "ok" });
  assert.equal(checked.checkedAt, new Date(start + 60_000).toISOString());
  // A check that Notion does not answer changes nothing and says so.
  users = new TypeError("fetch failed");
  assert.equal(await save(fixture.deps, { check: true }), "checked");
  assert.equal((await status()).capabilities.users, "refused", "an unanswered user check leaves the record as it was");

  assert.equal(await save(fixture.deps, { enabled: false }), "disabled");
  assert.equal((await status()).enabled, false); assert.equal((await status()).readable, true, "turning it off keeps the token");
  await rejectsWith(fixture.service().users.list(), "notion_disabled");
  // Saving a new token keeps the Admin's off switch unless the request says otherwise, and forgets the old record.
  users = { status: 200, body: { results: [] } };
  assert.equal(await save(fixture.deps, { token }), "saved");
  assert.equal((await status()).enabled, false); assert.deepEqual((await status()).capabilities, { ...empty.capabilities, users: "ok" });
  assert.equal(fixture.connection()!.key_version, 2);
  assert.equal(await save(fixture.deps, { enabled: true }), "enabled");

  // After a restore with another key the row is saved but unreadable until it is saved again.
  const restored = { ...fixture.deps, credentials: moduleCredentials(otherSecret) };
  const unreadable = await notionIntegrationStatus(restored, modules);
  assert.deepEqual({ saved: unreadable.saved, readable: unreadable.readable }, { saved: true, readable: false });
  await assert.rejects(save(restored, { check: true }), /can't be read\. Save it again/);
  assert.equal(await save(restored, { token }), "saved");
  assert.equal((await notionIntegrationStatus(restored, modules)).readable, true);

  // Remove forgets the token and keeps the databases an Admin chose.
  fixture.bind("part-requests", "orders");
  await removeNotionConnection(fixture.deps);
  const removed = await status();
  assert.equal(removed.saved, false); assert.equal(removed.bindings[0]!.bound, true);
  await rejectsWith(fixture.service().query("orders"), "notion_not_configured");
});

test("an Admin chooses a database only for a declared binding, and only one the connection can read", async () => {
  const sources: Record<string, { id: string; name: string }[]> = { [ordersDatabase]: [{ id: ordersSource, name: "Test Orders" }], [otherDatabase]: [{ id: otherSource, name: "" }, { id: uuid("5", 3), name: "Archive" }], [uuid("d", 3)]: [] };
  const fixture = setup((call) => {
    const database = /^\/databases\/([0-9a-f-]{36})$/.exec(call.path)?.[1];
    if (database) return sources[database] ? { status: 200, body: { object: "database", id: database, data_sources: sources[database] } } : { status: 404 };
    const source = /^\/data_sources\/([0-9a-f-]{36})$/.exec(call.path)?.[1];
    if (source) return { status: 200, body: { object: "data_source", id: source, title: [{ plain_text: "Titled " }, { plain_text: "source" }] } };
    return undefined;
  });
  const set = (moduleId: string, bindingId: string, value: unknown) => setNotionBinding(fixture.deps, modules, moduleId, bindingId, value);
  const link = `https://www.notion.so/test-workspace/${ordersDatabase.replaceAll("-", "")}?v=${uuid("f", 1).replaceAll("-", "")}`;
  await assert.rejects(set("part-requests", "orders", { database: link }), (error: unknown) => error instanceof HttpError && error.status === 409 && /Connect Notion/.test(error.message));
  await fixture.connect(token, secret, 0);
  await assert.rejects(set("part-requests", "orders", { database: link }), /Turn the Notion connection on/);
  fixture.db.sqlite.exec("UPDATE notion_connection SET enabled=1");
  // Undeclared: another module's binding, an unknown module, a module that is not available.
  for (const [moduleId, bindingId] of [["part-requests", "log"], ["chores", "orders"], ["missing", "orders"], ["attendance", "orders"]]) await assert.rejects(set(moduleId!, bindingId!, { database: link }), (error: unknown) => error instanceof HttpError && error.status === 404);
  await assert.rejects(setNotionBinding(fixture.deps, modules.map((module) => ({ ...module, available: false })), "part-requests", "orders", { database: link }), (error: unknown) => error instanceof HttpError && error.status === 404);
  for (const bad of [null, {}, { database: "https://example.test/x" }, { database: link, dataSourceId: "x" }, { database: link, extra: 1 }]) await assert.rejects(set("part-requests", "orders", bad), (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.equal(fixture.notion.calls.length, 0);

  assert.deepEqual(await set("part-requests", "orders", { database: link }), { bound: true });
  assert.deepEqual(fixture.notion.calls.map((call) => call.path), [`/databases/${ordersDatabase}`, `/data_sources/${ordersSource}`]);
  assert.deepEqual(fixture.rows("SELECT module_id,binding_id,database_id,data_source_id,name,revision FROM notion_bindings"), [{ module_id: "part-requests", binding_id: "orders", database_id: ordersDatabase, data_source_id: ordersSource, name: "Test Orders", revision: 0 }]);
  assert.equal(parseNotionCapabilities(fixture.connection()!.capabilities_json).read, "ok", "reading the database proves Read content");
  // A database with several data sources asks which one, and saves nothing until told.
  assert.deepEqual(await set("part-requests", "orders", { database: otherDatabase }), { bound: false, dataSources: sources[otherDatabase] });
  assert.equal(fixture.rows<{ database_id: string }>("SELECT database_id FROM notion_bindings")[0]!.database_id, ordersDatabase);
  await assert.rejects(set("part-requests", "orders", { database: otherDatabase, dataSourceId: ordersSource }), /Choose one of the database's data sources/);
  assert.deepEqual(await set("part-requests", "orders", { database: otherDatabase, dataSourceId: otherSource }), { bound: true });
  assert.deepEqual(fixture.rows("SELECT database_id,data_source_id,name,revision FROM notion_bindings"), [{ database_id: otherDatabase, data_source_id: otherSource, name: "Titled source", revision: 1 }]);
  // A database the connection was not added to, and a page with only a linked view.
  await assert.rejects(set("chores", "log", { database: uuid("d", 4) }), (error: unknown) => error instanceof HttpError && error.status === 400 && /Add the connection to the database/.test(error.message));
  await assert.rejects(set("chores", "log", { database: uuid("d", 3) }), /No data source was found/);
  const listed = (await notionIntegrationStatus(fixture.deps, modules)).bindings;
  assert.deepEqual(listed.map((binding) => [binding.moduleId, binding.id, binding.bound, binding.name, binding.link]), [["part-requests", "orders", true, "Titled source", notionLink(otherDatabase)], ["part-requests", "people", false, "", null], ["chores", "log", false, "", null]]);
  assert.deepEqual(listed[0]!.operations, declaration.bindings[0]!.operations);

  assert.equal(await removeNotionBinding(fixture.deps, "part-requests", "orders"), true);
  assert.equal(await removeNotionBinding(fixture.deps, "part-requests", "orders"), false);
  await assert.rejects(removeNotionBinding(fixture.deps, "Part Requests", "orders"), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(fixture.rows("SELECT * FROM notion_bindings").length, 0);
});

test("each module's comments carry the name an Admin set for that module, or its label", async () => {
  const fixture = setup((call) => {
    if (call.path === "/comments" && call.method === "POST") return { status: 200, body: { object: "comment", id: uuid("e", 1) } };
    if (call.path === `/pages/${page(1)}`) return { status: 200, body: pageIn(page(1), ordersSource) };
    return undefined;
  });
  // Three modules that may comment, and the two from above that may not (Chores declared no comments; Attendance no Notion).
  const commenting = (id: string, label: string) => ({ id, label, available: true, notion: { bindings: [{ id: "log", label: `${label} log`, reason: "Synthetic", required: true, kind: "data_source", operations: ["query", "comments.create"] }] } satisfies ModuleNotionDefinition });
  const installed = [modules[0]!, commenting("test-inventory", "Test Inventory"), commenting("test-tools", "Test Tools"), modules[1]!, modules[2]!];
  await fixture.connect(); fixture.bind("part-requests", "orders"); fixture.bind("test-inventory", "log"); fixture.bind("test-tools", "log");
  let batches = 0; const batch = fixture.db.batch.bind(fixture.db);
  fixture.db.batch = ((statements: Parameters<typeof batch>[0]) => { batches += 1; return batch(statements); }) as typeof fixture.db.batch;
  /** The display name on the comment a new invocation of the module posts. */
  const posted = async (moduleId: string, definition: { label?: string; notion?: ModuleNotionDefinition } | undefined = installed.find((module) => module.id === moduleId)) => {
    const before = fixture.notion.calls.length;
    await fixture.service(moduleId, definition as never).createComment(moduleId === "part-requests" ? "orders" : "log", page(1), { richText: [{ text: { content: "Synthetic comment" } }] });
    const calls = fixture.notion.calls.slice(before).filter((call) => call.path === "/comments");
    assert.equal(calls.length, 1);
    return calls[0]!.body.display_name;
  };
  const named = (name: string) => ({ type: "custom", custom: { name } });
  const set = (moduleId: string, name: unknown) => setNotionCommentName(fixture.deps, installed, moduleId, { name });
  const stored = () => Object.fromEntries(fixture.rows<{ module_id: string; name: string }>("SELECT module_id,name FROM notion_comment_names ORDER BY module_id").map((row) => [row.module_id, row.name]));

  // With nothing set every module comments under its own label, and the name costs no query beyond the invocation's one read.
  const reads = fixture.db.reads;
  assert.deepEqual(await posted("part-requests"), named("Part Requests"));
  assert.equal(batches, 1, "the connection, the bindings and the name are read together"); assert.equal(fixture.db.reads, reads, "and nothing else is read");
  assert.deepEqual(await posted("test-inventory"), named("Test Inventory"));
  assert.deepEqual(await posted("part-requests", { label: `  ${"L".repeat(120)}  `, notion: declaration }), named("L".repeat(100)), "a long label is cut to what an Admin could set");
  assert.deepEqual(await posted("part-requests", { notion: declaration }), named("LancerLogin"), "Notion refuses an empty name, so a module without a label still sends one");
  assert.deepEqual(await notionCommentName(fixture.deps, installed, "part-requests"), { moduleId: "part-requests", label: "Part Requests", name: "" });

  // Two modules get different names; the third is left blank and keeps its label. Names are trimmed.
  const connectionBefore = fixture.connection();
  assert.equal(await set("part-requests", "  Test Team 0000  "), "set");
  assert.equal(await set("test-inventory", "Test Stockroom"), "set");
  assert.deepEqual(stored(), { "part-requests": "Test Team 0000", "test-inventory": "Test Stockroom" });
  assert.deepEqual(await notionCommentName(fixture.deps, installed, "part-requests"), { moduleId: "part-requests", label: "Part Requests", name: "Test Team 0000" });
  assert.deepEqual(await notionCommentName(fixture.deps, installed, "test-tools"), { moduleId: "test-tools", label: "Test Tools", name: "" });
  batches = 0;
  assert.deepEqual(await posted("part-requests"), named("Test Team 0000"));
  assert.equal(batches, 1, "a set name arrives in the same read");
  assert.deepEqual(await posted("test-inventory"), named("Test Stockroom"));
  assert.deepEqual(await posted("test-tools"), named("Test Tools"));
  const connectionAfter = fixture.connection()!;
  assert.deepEqual([connectionAfter.ciphertext, connectionAfter.key_version, connectionAfter.revision], [connectionBefore!.ciphertext, connectionBefore!.key_version, connectionBefore!.revision], "a name changes nothing on the connection: the token and its revision stay");
  assert.equal(fixture.notion.calls.some((call) => call.path.startsWith("/users")), false, "setting a name asks Notion nothing");
  assert.equal(await set("part-requests", "Test Team 0000"), "unchanged");
  assert.equal(await set("part-requests", "N".repeat(100)), "set"); assert.deepEqual(await posted("part-requests"), named("N".repeat(100)));

  // Refused: too long, not text, more than one line, another field, or a module that cannot comment.
  for (const bad of ["N".repeat(101), ` ${"N".repeat(101)} `, 7, null, true, ["Test"], "Test\nTeam", undefined]) await assert.rejects(set("part-requests", bad), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(bad));
  for (const bad of [null, [], "Test", { name: "Test", revision: 1 }]) await assert.rejects(setNotionCommentName(fixture.deps, installed, "part-requests", bad), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(bad));
  for (const moduleId of ["chores", "attendance", "missing", "Part Requests"]) {
    await assert.rejects(set(moduleId, "Test Team"), (error: unknown) => error instanceof HttpError && error.status === 404, moduleId);
    await assert.rejects(notionCommentName(fixture.deps, installed, moduleId), (error: unknown) => error instanceof HttpError && error.status === 404, moduleId);
  }
  assert.equal(await set("test-tools", "Test Team"), "set");
  await assert.rejects(setNotionCommentName(fixture.deps, installed.map((module) => ({ ...module, available: false })), "part-requests", { name: "Test Team" }), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.deepEqual(stored(), { "part-requests": "N".repeat(100), "test-inventory": "Test Stockroom", "test-tools": "Test Team" });

  // Blank clears one module's name and leaves the others.
  assert.equal(await set("part-requests", "   "), "cleared"); assert.equal(await set("part-requests", ""), "unchanged");
  assert.equal(await set("test-tools", ""), "cleared");
  assert.deepEqual(stored(), { "test-inventory": "Test Stockroom" });
  assert.deepEqual(await posted("part-requests"), named("Part Requests"));
  assert.deepEqual(await posted("test-inventory"), named("Test Stockroom"));

  // The name belongs to the module: clearing its database or removing the token keeps it, and it can still be changed.
  assert.equal(await removeNotionBinding(fixture.deps, "test-inventory", "log"), true);
  await removeNotionConnection(fixture.deps);
  assert.deepEqual(stored(), { "test-inventory": "Test Stockroom" });
  assert.equal(await set("part-requests", "Test Team 0000"), "set");
  await fixture.connect(); fixture.bind("test-inventory", "log");
  assert.deepEqual(await posted("test-inventory"), named("Test Stockroom")); assert.deepEqual(await posted("part-requests"), named("Test Team 0000"));
});
