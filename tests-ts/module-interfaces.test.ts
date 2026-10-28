// Cross-module interfaces: manifest validation, required uses at composition and enablement, handler binding and call bounds.
// The Worker path, grants and lifecycle run end to end in module-interface-worker.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledModuleRegistry, createModuleRegistry, interfaceProviderId, interfaceUseProblem, requiredModuleIds, type ModuleDefinition, type ModuleInterfaceDefinition } from "../packages/shared/src/module-platform.ts";
import { createApiModuleSet } from "../apps/api/src/module-contributions.ts";
import { moduleInterfaceJson } from "../apps/api/src/module-interfaces.ts";
import { CompositionError, inspectPlugin, validateModuleSet } from "../scripts/compose-modules.mjs";

function module(id: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  const prefix = `${id.replaceAll("-", "_")}_`;
  return {
    id, label: `Synthetic ${id}`, description: `Synthetic ${id} module`, contractVersion: 1, available: true, dependencies: [],
    capabilities: [{ id: `${id}.manage`, label: `Manage ${id}`, operator: true }], navigation: [], settings: [], setup: { version: 1, steps: [] }, jobs: [], discordCommands: [], apiRoutes: [],
    tablePrefix: prefix, persistence: { tables: [], sharedFields: [], transientAuthority: [] }, backup: { version: 1, tables: [] }, lifecycle: { cleanupTargets: [`${prefix}records`] }, deletedData: [],
    ...extra,
  };
}
const items: ModuleInterfaceDefinition = { id: "provider.items", version: 1, label: "Provider items", operations: [
  { id: "list", label: "List provider items", capability: "provider.manage", grantable: true },
  { id: "archive", label: "Archive provider items", capability: "provider.manage", grantable: false },
] };
const provider = module("provider", { interfaces: [items] });
const use = { interface: "provider.items", version: 1, operations: ["list"], required: false, reason: "Show provider items" };
const consumer = module("consumer", { uses: [use] });

test("the registry accepts namespaced interfaces and well-formed uses, and refuses everything else", () => {
  const registry = createModuleRegistry([provider, consumer]);
  assert.equal(registry.interfaceOwner("provider.items")?.module.id, "provider");
  assert.equal(registry.interfaceOwner("provider.other"), undefined);
  assert.equal(interfaceProviderId("hour-tracking.team-support"), "hour-tracking");
  assert.equal(interfaceProviderId("no-namespace"), undefined);
  // Optional uses may name a provider that is not installed; composition and calls handle availability.
  assert.ok(createModuleRegistry([consumer]));
  const refused: [ModuleDefinition[], RegExp][] = [
    [[module("provider", { interfaces: [items, { ...items, label: "Again" }] })], /Duplicate module interface/],
    [[module("provider", { interfaces: [{ ...items, id: "other.items" }] }), module("other")], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, id: "provider" }] })], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, version: 0 }] })], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, version: 1.5 }] })], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, label: "" }] })], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, operations: [] }] })], /Invalid module interface/],
    [[module("provider", { interfaces: [{ ...items, operations: [items.operations[0]!, { ...items.operations[1]!, id: "list" }] }] })], /Duplicate module interface operation/],
    [[module("provider", { interfaces: [{ ...items, operations: [{ ...items.operations[0]!, capability: "consumer.manage" }] }] }), consumer], /provider's own capabilities/],
    [[module("provider", { interfaces: [{ ...items, operations: [{ ...items.operations[0]!, id: "List" }] }] })], /Invalid module interface operation/],
    [[module("provider", { interfaces: [{ ...items, operations: [{ ...items.operations[0]!, label: " padded" }] }] })], /Invalid module interface operation/],
    [[module("provider", { interfaces: [{ ...items, operations: [{ ...items.operations[0]!, grantable: "yes" as never }] }] })], /Invalid module interface operation/],
    [[module("provider", { interfaces: [items], uses: [{ ...use }] })], /cannot use its own interface/],
    [[module("consumer", { uses: [{ ...use, interface: "items" }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [{ ...use, version: 0 }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [{ ...use, operations: [] }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [{ ...use, operations: ["list", "list"] }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [{ ...use, required: "no" as never }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [{ ...use, reason: "" }] })], /Invalid module interface use/],
    [[module("consumer", { uses: [use, { ...use, operations: ["archive"] }] })], /Duplicate module interface use/],
    [[module("consumer", { uses: "provider.items" as never })], /Invalid module interface use/],
  ];
  for (const [modules, pattern] of refused) assert.throws(() => createModuleRegistry(modules), pattern, JSON.stringify(modules.map((item) => [item.interfaces, item.uses])));
  // Two versions of one interface are separate uses.
  assert.ok(createModuleRegistry([module("consumer", { uses: [use, { ...use, version: 2 }] })]));
});

test("a required use behaves like a dependency at enablement; an optional one does not", () => {
  const required = module("consumer", { uses: [{ ...use, required: true }] });
  const registry = createModuleRegistry([provider, required]);
  assert.deepEqual(registry.requiredModules("consumer"), ["provider"]);
  assert.deepEqual(requiredModuleIds(module("consumer", { dependencies: ["provider"], uses: [{ ...use, required: true }] })), ["provider"]);
  assert.throws(() => registry.validateSelection(["consumer"]), /Missing module dependency/);
  assert.deepEqual(registry.validateSelection(["provider", "consumer"]), ["provider", "consumer"]);
  // A required provider that is not installed can never be enabled first, so neither can the consumer.
  assert.throws(() => createModuleRegistry([required]).validateSelection(["consumer"]), /Missing module dependency/);
  const optional = createModuleRegistry([provider, consumer]);
  assert.deepEqual(optional.requiredModules("consumer"), []);
  assert.deepEqual(optional.validateSelection(["consumer"]), ["consumer"]);
  // Existing modules declare neither field and keep their dependencies exactly.
  for (const installed of bundledModuleRegistry.modules) assert.deepEqual(bundledModuleRegistry.requiredModules(installed.id), [...installed.dependencies]);
  assert.equal(interfaceUseProblem(use, [provider]), undefined);
  assert.match(interfaceUseProblem(use, [])!, /no installed module provides provider\.items/);
  assert.match(interfaceUseProblem({ ...use, version: 2 }, [provider])!, /provides provider\.items version 1, not 2/);
  assert.match(interfaceUseProblem({ ...use, operations: ["list", "delete"] }, [provider])!, /has no delete operation/);
});

test("the Worker binds exactly one handler per declared interface operation", () => {
  const registry = createModuleRegistry([provider, consumer]);
  const handler = async () => ({});
  const contribution = (interfaces?: unknown, moduleId = "provider") => ({ moduleId, routes: {}, setup: { predicates: {}, stepValid: async () => true }, cleanup: { steps: [{ kind: "assignments" as const }] }, ...(interfaces === undefined ? {} : { interfaces }) }) as never;
  const external = { externalModuleIds: new Set(["provider", "consumer"]) };
  assert.ok(createApiModuleSet(registry, [contribution({ "provider.items": { list: handler, archive: handler } }), contribution(undefined, "consumer")], external));
  for (const interfaces of [undefined, {}, { "provider.items": { list: handler } }, { "provider.items": { list: handler, archive: handler, extra: handler } }, { "provider.items": { list: handler, archive: "handler" } }, { "provider.items": { list: handler, archive: handler }, "provider.extra": { list: handler } }]) {
    assert.throws(() => createApiModuleSet(registry, [contribution(interfaces), contribution(undefined, "consumer")], external), /interface handlers do not match declared interface operations/, JSON.stringify(interfaces));
  }
  // A module that declares no interface may not bind any.
  assert.throws(() => createApiModuleSet(registry, [contribution({ "provider.items": { list: handler, archive: handler } }), contribution({ "provider.items": { list: handler } }, "consumer")], external), /Module consumer interface handlers/);
});

test("calls carry plain, bounded JSON only", () => {
  assert.equal(moduleInterfaceJson(undefined), "null");
  assert.equal(moduleInterfaceJson({ id: "a", count: 2, nested: [true, null, { text: "é" }] }), '{"id":"a","count":2,"nested":[true,null,{"text":"é"}]}');
  assert.equal(moduleInterfaceJson(Object.assign(Object.create(null), { id: "a" })), '{"id":"a"}');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [() => 1, new Date(), new Map(), Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol("x"), { value: undefined }, [undefined], cyclic, { [Symbol("key")]: 1 }, new (class Item { id = "a"; })()]) assert.equal(moduleInterfaceJson(value), undefined, String(typeof value));
  assert.ok(moduleInterfaceJson("x".repeat(65_534)));
  assert.equal(moduleInterfaceJson("x".repeat(65_535)), undefined);
  assert.ok(moduleInterfaceJson("é".repeat(32_767)));
  assert.equal(moduleInterfaceJson("é".repeat(32_768)), undefined, "the bound counts UTF-8 bytes");
});

test("composition inspects interface handlers and refuses a required use its provider cannot serve", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-interfaces-")); t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const inspect = async (name: string) => { const root = join(scratch, name); cpSync(`tests/fixtures/module-plugins/${name}`, root, { recursive: true }); return { root, ...await inspectPlugin({ pluginRoot: root, entries: { manifest: join(root, "src/manifest.ts"), api: join(root, "src/api.ts") }, env: process.env }) }; };
  const example = await inspect("example"); const consumerPlugin = await inspect("consumer");
  assert.deepEqual(example.api.interfaces, { "example.items": ["list", "create", "close"] });
  assert.deepEqual(consumerPlugin.api.interfaces, {});
  const external = (inspected: { manifest: any; api: any }, change: (manifest: any, api: any) => void = () => {}) => { const manifest = structuredClone(inspected.manifest); const api = structuredClone(inspected.api); change(manifest, api); return { plugin: { moduleId: manifest.id }, manifest, api }; };
  const firstParty = bundledModuleRegistry.modules.filter((item) => !["example", "consumer"].includes(item.id));
  const rejects = (pattern: RegExp) => (error: unknown) => error instanceof CompositionError && pattern.test(error.message);
  // An optional use composes with or without its provider.
  assert.ok(await validateModuleSet(firstParty, [external(example), external(consumerPlugin)]));
  assert.ok(await validateModuleSet(firstParty, [external(consumerPlugin)]));
  // A required use needs its provider, at that version, with every operation it names; order in the selection does not matter.
  const required = (change: (use: any) => void = () => {}) => external(consumerPlugin, (manifest) => { manifest.uses[0].required = true; change(manifest.uses[0]); });
  assert.ok(await validateModuleSet(firstParty, [required(), external(example)]));
  await assert.rejects(validateModuleSet(firstParty, [required()]), rejects(/Module consumer requires example\.items version 1, but no installed module provides example\.items/));
  await assert.rejects(validateModuleSet(firstParty, [external(example), required((use) => { use.version = 2; })]), rejects(/example provides example\.items version 1, not 2/));
  await assert.rejects(validateModuleSet(firstParty, [external(example), required((use) => { use.operations.push("archive"); })]), rejects(/has no archive operation/));
  // The provider's API must handle every declared operation and nothing else, like routes and jobs.
  await assert.rejects(validateModuleSet(firstParty, [external(example, (_manifest, api) => { api.interfaces["example.items"] = ["list", "create"]; })]), rejects(/Module example interface handlers do not match declared interface operations/));
  await assert.rejects(validateModuleSet(firstParty, [external(example, (_manifest, api) => { api.interfaces["example.items"].push("delete"); })]), rejects(/interface handlers do not match/));
  await assert.rejects(validateModuleSet(firstParty, [external(example, (_manifest, api) => { api.interfaces = {}; })]), rejects(/interface handlers do not match/));
  await assert.rejects(validateModuleSet(firstParty, [external(example, (manifest) => { manifest.interfaces[0].operations[0].capability = "consumer.manage"; })]), rejects(/provider's own capabilities/));
  // Inspection refuses an interface handler that is not a function.
  writeFileSync(join(example.root, "src/broken-api.ts"), 'import api from "./api.ts";\nexport default { ...api, interfaces: { "example.items": { ...api.interfaces["example.items"], list: "not a function" } } };\n');
  await assert.rejects(inspectPlugin({ pluginRoot: example.root, entries: { manifest: join(example.root, "src/manifest.ts"), api: join(example.root, "src/broken-api.ts") }, env: process.env }), /interfaces\.example\.items\.list must be a function/);
});

test("a consumer whose provider is absent gets no client and Settings > Modules says why", async () => {
  const { createTestD1Database } = await import("./fixtures/d1-database.ts");
  const { grantModuleInterface, moduleInterfaceServices, readModuleInterfaceGrants } = await import("../apps/api/src/module-interfaces.ts");
  const untouched = { prepare() { throw new Error("no lookup is needed"); }, batch() { throw new Error("no lookup is needed"); } } as never;
  const services = (registry: ReturnType<typeof createModuleRegistry>, handlers = () => undefined as never, nested = false) => moduleInterfaceServices({ db: untouched, consumerId: "consumer", registry, handlers, nested, providerServices: () => { throw new Error("unused"); } });
  // Absent provider, provider code not installed, another version, an undeclared interface and a nested call: nothing to call.
  assert.equal(await services(createModuleRegistry([consumer])).interface("provider.items", 1), undefined);
  assert.equal(await services(createModuleRegistry([provider, consumer])).interface("provider.items", 1), undefined);
  const installed = () => ({ "provider.items": { list: async () => ({}), archive: async () => ({}) } }) as never;
  assert.equal(await services(createModuleRegistry([provider, module("consumer", { uses: [{ ...use, version: 2 }] })]), installed).interface("provider.items", 2), undefined);
  assert.equal(await services(createModuleRegistry([provider, module("consumer", { uses: [{ ...use, operations: ["list", "delete"] }] })]), installed).interface("provider.items", 1), undefined);
  assert.equal(await services(createModuleRegistry([provider, consumer]), installed).interface("provider.other", 1), undefined);
  assert.equal(await services(createModuleRegistry([provider, consumer]), installed, true).interface("provider.items", 1), undefined);

  const db = await createTestD1Database();
  db.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-26');");
  const absent = await readModuleInterfaceGrants(db as never, createModuleRegistry([consumer]));
  assert.deepEqual(absent.uses.map((item) => ({ provider: item.provider, interface: item.interface, operations: item.operations, grantable: item.grantable, grant: item.grant })), [{
    provider: { id: "provider", label: null, state: "missing" }, interface: { id: "provider.items", version: 1, label: null },
    operations: [{ id: "list", label: null, grantable: false }], grantable: [], grant: null,
  }]);
  await assert.rejects(grantModuleInterface(db as never, "admin", { consumer: "consumer", interface: "provider.items", version: 1, operations: ["list"] }, createModuleRegistry([consumer])), /not installed at a compatible version/);
  const unsupported = await readModuleInterfaceGrants(db as never, createModuleRegistry([provider, module("consumer", { uses: [{ ...use, version: 2 }] })]));
  assert.equal(unsupported.uses[0]!.provider.state, "unsupported");
  // An operation no provider lets an Admin grant can never be granted.
  await assert.rejects(grantModuleInterface(db as never, "admin", { consumer: "consumer", interface: "provider.items", version: 1, operations: [] }, createModuleRegistry([provider, module("consumer", { uses: [{ ...use, operations: ["archive"] }] })])), /None of these operations can be granted/);
  // Installations whose modules declare no uses list nothing.
  assert.deepEqual(await readModuleInterfaceGrants(db as never, createModuleRegistry([provider])), { uses: [] });
});
