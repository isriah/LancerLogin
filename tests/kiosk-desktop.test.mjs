import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDesktopControl } from "../apps/kiosk/src/desktop-control.mjs";
import { createDesktopLauncherClient, kioskBrowserArguments, superviseKioskBrowser } from "../apps/kiosk/src/desktop-launcher.mjs";

const instance = () => ({ input: { instanceId: randomUUID() }, secret: randomBytes(32).toString("base64url") });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function transport(getControl, capture = []) {
  return async (url, options) => {
    capture.push({ url, body: options.body, headers: options.headers });
    const operation = url.split("/").at(-1), name = operation === "ack" ? "acknowledge" : operation;
    try { return Response.json(await getControl()[name](JSON.parse(options.body), options.headers["x-lancerlogin-launcher"])); }
    catch (error) { return Response.json({ error: error.code }, { status: error.status || 500 }); }
  };
}

test("desktop registration rejects takeover, arbitrary fields, stale owners and expired replay", async () => {
  let clock = 1000;
  const control = createDesktopControl({ now: () => clock, leaseMs: 1000 }), a = instance(), b = instance();
  await assert.rejects(control.requestExit(), { status: 503 });
  control.register(a.input, a.secret);
  assert.throws(() => control.register(b.input, b.secret), { status: 409 });
  assert.throws(() => control.register(a.input, b.secret), { status: 409 });
  assert.throws(() => control.poll({ ...a.input, pid: 1 }, a.secret), { status: 400 });
  assert.throws(() => control.poll(a.input, b.secret), { status: 409 });
  clock += 1000;
  assert.throws(() => control.register(a.input, a.secret), { status: 410 });
  control.register(b.input, b.secret);
  assert.throws(() => control.poll(a.input, a.secret), { status: 409 });
  assert.equal(control.poll(b.input, b.secret).action, "none");
});

test("exit waits for suspension, is idempotent and completes only after exact-instance acknowledgement", async () => {
  const control = createDesktopControl(), a = instance();
  control.register(a.input, a.secret);
  let suspended;
  const barrier = new Promise(resolve => { suspended = resolve; });
  let calls = 0;
  const first = control.requestExit(async () => { calls++; await barrier; });
  const second = control.requestExit(async () => { calls++; });
  assert.equal(control.poll(a.input, a.secret).action, "none");
  suspended();
  const request = await first;
  assert.deepEqual(await second, request);
  assert.equal(calls, 1); assert.equal(control.status().completed, false);
  assert.equal(control.poll(a.input, a.secret).requestId, request.requestId);
  assert.throws(() => control.acknowledge({ ...a.input, requestId: randomUUID() }, a.secret), { status: 409 });
  assert.equal(control.acknowledge({ ...a.input, requestId: request.requestId }, a.secret).completed, true);
  control.detach(a.input, a.secret);
  const b = instance(); control.register(b.input, b.secret);
  assert.equal(control.poll(b.input, b.secret).action, "none");
  assert.throws(() => control.acknowledge({ ...a.input, requestId: request.requestId }, a.secret), { status: 409 });
});

test("expired registration during suspension cannot publish an exit for another launcher", async () => {
  let clock = 1000, resume;
  const control = createDesktopControl({ now: () => clock, leaseMs: 1000 }), a = instance(), b = instance();
  control.register(a.input, a.secret);
  const request = control.requestExit(() => new Promise(resolve => { resume = resolve; }));
  clock += 1001; control.register(b.input, b.secret); resume();
  await assert.rejects(request, { status: 503 });
  assert.equal(control.poll(b.input, b.secret).action, "none");
});

test("launcher reconnects after service restart without accepting the previous exit", async () => {
  let control = createDesktopControl();
  const capture = [], client = await createDesktopLauncherClient({ fetchImpl: transport(() => control, capture) });
  await client.register();
  const old = await control.requestExit();
  control = createDesktopControl();
  assert.equal(await client.poll(), null);
  assert.equal(await client.poll(), null);
  const fresh = await control.requestExit();
  assert.notEqual(fresh.requestId, old.requestId);
  assert.equal(await client.poll(), fresh.requestId);
  assert.ok(capture.every(request => !request.url.includes(request.headers["x-lancerlogin-launcher"])));
  assert.ok(capture.every(request => !request.body.includes(request.headers["x-lancerlogin-launcher"])));
  await client.detach();
});

test("launcher validates response bounds and uses only a dedicated browser profile", async () => {
  const profile = join(tmpdir(), "synthetic-kiosk-profile"), args = kioskBrowserArguments(profile);
  assert.equal(args[0], `--user-data-dir=${profile}`);
  assert.equal(args.at(-1), "http://127.0.0.1:8788/");
  assert.equal(args.includes("--remote-debugging-port"), false);
  await assert.rejects(createDesktopLauncherClient({ baseUrl: "https://outside.invalid" }), /loopback/);
  const client = await createDesktopLauncherClient({ fetchImpl: async () => new Response("x".repeat(2049)) });
  await assert.rejects(client.register(), /Invalid desktop control response/);
});

test("desktop exit stops only its child, acknowledges after exit and leaves unrelated process alive", async context => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  context.after(() => unrelated.kill());
  await once(unrelated, "spawn");
  const control = createDesktopControl(), client = await createDesktopLauncherClient({ fetchImpl: transport(() => control) });
  let child, acknowledgedAfterExit = false;
  const originalAck = client.acknowledge;
  client.acknowledge = async requestId => { acknowledgedAfterExit = child.exitCode !== null || child.signalCode !== null; return originalAck(requestId); };
  const running = superviseKioskBrowser({ client, pollIntervalMs: 10, graceMs: 500,
    launch: () => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); return child; } });
  context.after(() => child?.kill());
  for (let attempts = 0; !child && attempts < 100; attempts++) await delay(5);
  assert.ok(child);
  await control.requestExit();
  assert.deepEqual(await running, { exited: true });
  assert.equal(acknowledgedAfterExit, true);
  assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
  assert.equal(control.status().available, false);
});

test("failed startup never launches a child and a competing live registration does not close an existing child", async context => {
  await assert.rejects(superviseKioskBrowser({ launch: () => assert.fail("No browser before registration"), client: { register: async () => { throw Object.assign(new Error("Unavailable"), { status: 503 }); } } }));
  const abort = new AbortController(); let child, polls = 0;
  const running = superviseKioskBrowser({ signal: abort.signal, pollIntervalMs: 5, graceMs: 500,
    launch: () => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); return child; },
    client: { register: async () => {}, detach: async () => {}, poll: async () => { polls++; throw Object.assign(new Error("Synthetic competing owner"), { status: 409 }); } } });
  context.after(() => { abort.abort(); child?.kill(); });
  for (let attempts = 0; polls < 3 && attempts < 100; attempts++) await delay(5);
  assert.ok(polls >= 3); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  abort.abort(); await running;
});

test("an outage longer than the lease keeps the browser alive and discards the retired exit request", async context => {
  let clock = 1000, offline = false, failures = 0, child;
  const control = createDesktopControl({ now: () => clock }), capture = [];
  const dispatch = transport(() => control, capture);
  const client = await createDesktopLauncherClient({ fetchImpl: async (...args) => {
    if (offline) { failures++; throw new Error("Synthetic loopback outage"); }
    return dispatch(...args);
  } });
  const abort = new AbortController();
  const running = superviseKioskBrowser({ client, signal: abort.signal, pollIntervalMs: 5, graceMs: 500,
    launch: () => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); return child; } });
  context.after(async () => { abort.abort(); child?.kill(); await running.catch(() => undefined); });
  for (let attempts = 0; !child && attempts < 100; attempts++) await delay(5);
  assert.ok(child); offline = true;
  const retiredExit = await control.requestExit();
  clock += 30_001;
  for (let attempts = 0; failures < 2 && attempts < 100; attempts++) await delay(5);
  assert.ok(failures >= 2); offline = false;
  const registrations = () => capture.filter(item => item.url.endsWith("/register"));
  for (let attempts = 0; registrations().length < 2 && attempts < 100; attempts++) await delay(5);
  assert.equal(registrations().length, 2);
  assert.notEqual(JSON.parse(registrations()[0].body).instanceId, JSON.parse(registrations()[1].body).instanceId);
  assert.notEqual(registrations()[0].headers["x-lancerlogin-launcher"], registrations()[1].headers["x-lancerlogin-launcher"]);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.equal(control.status().exitPending, false);
  const freshExit = await control.requestExit();
  assert.notEqual(freshExit.requestId, retiredExit.requestId);
  await running;
});

test("lease recovery waits for a competing owner without taking over or accepting its exit", async () => {
  let clock = 1000;
  const control = createDesktopControl({ now: () => clock, leaseMs: 1000 }), competitor = instance();
  const client = await createDesktopLauncherClient({ fetchImpl: transport(() => control) });
  await client.register();
  clock += 1001; control.register(competitor.input, competitor.secret);
  const competingExit = await control.requestExit();
  await assert.rejects(client.poll(), { status: 409 });
  await assert.rejects(client.poll(), { status: 409 });
  assert.equal(control.poll(competitor.input, competitor.secret).requestId, competingExit.requestId);
  control.detach(competitor.input, competitor.secret);
  assert.equal(await client.poll(), null);
  assert.equal(await client.poll(), null);
  assert.equal(control.status().exitPending, false);
  await client.detach();
});
