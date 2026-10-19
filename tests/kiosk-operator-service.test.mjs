import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await wait(30); } assert.fail("Synthetic runtime condition did not become true"); }
async function fixture(t, { method = "fingerprint", modern = false, holdConfiguration = false, holdCommand = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-operator-service-")); await chmod(root, 0o700);
  let rosterMode = "valid", heartbeats = 0, configurationStarted = false, commandStarted = false, releaseConfiguration, releaseCommand;
  const attendance = [];
  const cloud = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    let data = {};
    if (request.url?.startsWith("/kiosk/poll?")) {
      if (!modern) { response.statusCode = 404; data = { error: "Not found" }; }
      else data = { protocol: 1, command: holdCommand ? { id: "synthetic-command", type: "reload_display" } : null,
        configuration: { kiosk: { id: "synthetic-kiosk", name: "Dashboard configured name" }, settings: { authenticationMethod: method } },
        fingerprints: { reset: { status: "ok", commands: [] }, roster: { status: "ok", revision: 1, notModified: false, members: [{ memberId: "synthetic-member", rosterId: "synthetic-roster" }] }, peer: { status: "ok", enabled: false, syncId: null, deliveries: [] }, vault: { status: "ok", enabled: false, vaultId: null, catalogRevision: null } } };
    }
    else if (request.url === "/kiosk/config") {
      configurationStarted = true;
      if (holdConfiguration) await new Promise(resolve => { releaseConfiguration = resolve; });
      data = { settings: { authenticationMethod: method }, kiosk: { name: "Dashboard configured name" } };
    } else if (request.url === "/kiosk/commands/synthetic-command/result") {
      commandStarted = true;
      if (holdCommand) await new Promise(resolve => { releaseCommand = resolve; });
      data = { completed: true };
    }
    else if (request.url === "/kiosk/heartbeat") heartbeats++;
    else if (request.url === "/kiosk/roster") {
      if (rosterMode === "offline") { response.statusCode = 503; data = { error: "Synthetic private error" }; }
      else data = { members: rosterMode === "missing" ? [] : [{ memberId: "synthetic-member", ...(rosterMode === "no_identity" ? {} : { rosterId: "synthetic-roster" }) }] };
    } else if (request.url === "/kiosk/attendance") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks).toString());
      const duplicate = attendance.some(previous => previous.eventId === event.eventId);
      if (!duplicate) attendance.push(event);
      data = { eventId: event.eventId, ...(duplicate ? { duplicate: true } : { accepted: true }), action: "check_in" };
    } else if (request.url?.includes("fingerprint-reset")) data = { commands: [] };
    else if (request.url?.includes("fingerprint")) data = { enabled: false, peers: [], transfers: [] };
    response.end(JSON.stringify(data));
  });
  await new Promise(resolve => cloud.listen(0,"127.0.0.1",resolve));
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child,"exit"); child.kill(); await done; } cloud.closeAllConnections(); await new Promise(resolve => cloud.close(resolve)); await rm(root,{recursive:true,force:true}); });
  const env = { ...process.env, NODE_ENV: "development", LANCERLOGIN_KIOSK_PORT: "0", LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_SENSOR_PATH: "synthetic" };
  for (const [key,name] of Object.entries({ CONFIG:"pairing.json",NETWORK_PIN:"network-pin.json",QUEUE:"attendance-queue.json",MAPPINGS:"slot-mappings.json",BRANDING:"branding.json",AUTHENTICATION:"authentication.json",CREDENTIAL_MAPPINGS:"credential-mappings.json",ROSTER_CACHE:"roster-cache.json",FINGERPRINT_SYNC:"fingerprint-sync",FINGERPRINT_VAULT:"fingerprint-vault",FINGERPRINT_RESET:"fingerprint-reset",FINGERPRINT_REVIEW:"fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(root,name);
  await writeFile(env.LANCERLOGIN_CONFIG, JSON.stringify({ apiUrl:`http://127.0.0.1:${cloud.address().port}`,kioskId:"synthetic-kiosk",pairingId:"synthetic-pairing",kioskToken:"synthetic-token",kioskName:"Old name" }), { mode:0o600 });
  await writeFile(env.LANCERLOGIN_MAPPINGS, JSON.stringify({0:{memberId:"synthetic-member",rosterId:"synthetic-roster",finger:"legacy"}}), {mode:0o600});
  await createNetworkPinStore(env.LANCERLOGIN_NETWORK_PIN).set("123456");
  async function start() {
    const child = fork(new URL("./fixtures/kiosk-operator-runtime-child.mjs",import.meta.url), [], { env, execArgv:["--experimental-test-module-mocks"], stdio:["ignore","pipe","pipe","ipc"] }); children.push(child);
    let diagnostics=""; child.stderr.on("data", chunk => { diagnostics += chunk; });
    const port = await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error("Child startup timed out: "+diagnostics)),5000); child.on("message",message=>{if(message.ready){clearTimeout(timer);resolve(message.port);}}); child.once("exit",()=>{clearTimeout(timer);reject(new Error("Child failed: "+diagnostics));}); });
    let sequence=0;
    async function reader(input={}) { const id=++sequence; return new Promise(resolve=>{const listener=message=>{if(message.id===id){child.off("message",listener);resolve(message);}};child.on("message",listener);child.send({...input,id});}); }
    const request=(path,input,headers={})=>fetch(`http://127.0.0.1:${port}${path}`,{method:input===undefined?"GET":"POST",headers:{"content-type":"application/json",...headers},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(5000)});
    async function presence(mode, previous) { const response=await request("/operator-presence",{action:previous?"transition":"enter",pageId:"synthetic-runtime-page",mode,...(previous?{generation:previous.generation}:{})});assert.equal(response.status,200);return response.json(); }
    return { child, request, reader, presence };
  }
  return { root, start, attendance, roster: mode=>{rosterMode=mode;}, heartbeats:()=>heartbeats,
    configurationStarted: () => configurationStarted, commandStarted: () => commandStarted,
    releaseConfiguration: () => { holdConfiguration = false; releaseConfiguration?.(); }, releaseCommand: () => { holdCommand = false; releaseCommand?.(); },
  };
}

test("real service starts sync immediately, persists name, and gates held fingers across restart", {timeout:20000}, async t => {
  const f=await fixture(t); let runtime=await f.start();
  await until(()=>f.heartbeats()>0);
  const health = await (await runtime.request("/health")).json();
  assert.deepEqual(Object.keys(health.fingerprintSync).sort(), ["reset", "vault"]);
  assert.doesNotMatch(JSON.stringify(health.fingerprintSync), /synthetic-token|synthetic-pairing|synthetic-member|resetEpoch|privateKey/);
  assert.equal(JSON.parse(await readFile(join(f.root,"pairing.json"),"utf8")).kioskName,"Dashboard configured name");
  await runtime.presence("attendance"); await wait(350); assert.equal(f.attendance.length,0);
  await runtime.reader({present:false}); await wait(350); await runtime.reader({present:true}); await until(()=>f.attendance.length===1);
  const done=once(runtime.child,"exit");runtime.child.kill();await done;
  runtime=await f.start();await runtime.presence("attendance");await wait(350);assert.equal(f.attendance.length,1);
  await runtime.reader({present:false});await wait(350);await runtime.reader({present:true});await until(()=>f.attendance.length===2);
});

test("real service verifies roster before enrollment, preserves replacement, and isolates operator scans", {timeout:20000}, async t => {
  const f=await fixture(t), runtime=await f.start();let presence=await runtime.presence("maintenance");
  assert.equal((await runtime.request("/fingerprint-diagnostics")).status,403);
  assert.equal((await runtime.request("/network/unlock",{pin:"123456"})).status,200);
  const diagnostics = await (await runtime.request("/fingerprint-diagnostics")).json();
  assert.deepEqual(Object.keys(diagnostics).sort(),["reset","vault"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-token|resetEpoch|synthetic-pairing/);
  const before=await readFile(join(f.root,"slot-mappings.json"),"utf8");
  for(const mode of ["offline","missing","no_identity"]){f.roster(mode);const response=await runtime.request("/enroll",{memberId:"synthetic-member",slot:0,replaceExisting:true});assert.ok([400,503].includes(response.status));assert.equal((await runtime.reader()).enrollCalls,0);assert.equal(await readFile(join(f.root,"slot-mappings.json"),"utf8"),before);}
  f.roster("valid"); await runtime.reader({holdEnrollment:true});
  const enrollment=runtime.request("/enroll",{memberId:"synthetic-member",slot:1});
  await until(async()=>(await runtime.reader()).enrollCalls===1);
  assert.equal((await runtime.request("/enroll",{memberId:"synthetic-member",slot:2})).status,409);
  assert.equal((await runtime.request("/sensor/test",{})).status,409);
  await runtime.reader({releaseEnrollment:true});const result=await enrollment;assert.equal(result.status,201);assert.equal((await result.json()).fingerRemovalRequired,true);
  assert.equal(JSON.parse(await readFile(join(f.root,"slot-mappings.json"),"utf8"))[1].rosterId,"synthetic-roster");
  await wait(350);assert.equal(f.attendance.length,0);
  assert.equal((await runtime.request("/attendance",{memberId:"synthetic-member"})).status,400);
  presence=await runtime.presence("attendance",presence);await wait(350);assert.equal(f.attendance.length,0);
  await runtime.reader({present:false});await wait(350);await runtime.reader({present:true});await until(()=>f.attendance.length===1);
  assert.equal((await runtime.request("/operator-presence",{action:"enter",pageId:"cross-origin-page",mode:"attendance"},{origin:"https://untrusted.example"})).status,403);
});

test("real desktop exit is authenticated, instance-bound and leaves capture disarmed until reentry", {timeout:20000}, async t => {
  const f = await fixture(t), runtime = await f.start();
  assert.equal((await runtime.request("/maintenance/desktop/exit", {})).status, 403);
  await runtime.request("/network/unlock", { pin: "123456" });
  assert.equal((await runtime.request("/maintenance/desktop/exit", {})).status, 503);
  const instanceId = randomUUID(), secret = randomBytes(32).toString("base64url");
  const headers = { "x-lancerlogin-launcher": secret };
  const origin = new URL((await runtime.request("/health")).url).origin;
  assert.equal((await runtime.request("/desktop/launcher/register", { instanceId }, { ...headers, origin })).status, 403);
  assert.equal((await runtime.request("/desktop/launcher/register", { instanceId, pid: 123 }, headers)).status, 400);
  assert.equal((await runtime.request("/desktop/launcher/register", { instanceId }, headers)).status, 200);
  const background = { pageId: "synthetic-background-page", mode: "attendance" };
  const oldAttendance = await (await runtime.request("/operator-presence", { action: "enter", ...background })).json();
  let presence = await runtime.presence("maintenance");
  await runtime.request("/operator-presence", { action: "leave", pageId: presence.pageId, generation: presence.generation, mode: presence.mode });
  assert.equal((await runtime.request("/maintenance/desktop/exit", { pid: 123 })).status, 400);
  assert.equal((await runtime.request("/maintenance/desktop/exit", {}, { origin: "https://untrusted.example" })).status, 403);
  const result = await (await runtime.request("/maintenance/desktop/exit", {})).json();
  assert.equal(result.requested, true);
  assert.equal((await (await runtime.request("/maintenance/desktop/exit", {})).json()).requestId, result.requestId);
  const polled = await (await runtime.request("/desktop/launcher/poll", { instanceId }, headers)).json();
  assert.equal(polled.action, "exit"); assert.equal(polled.requestId, result.requestId);
  const renewed = await (await runtime.request("/operator-presence", { action: "renew", ...background, generation: oldAttendance.generation })).json();
  assert.equal(renewed.captureSuspended, true);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true }); await wait(350);
  assert.equal(f.attendance.length, 0);
  assert.equal((await runtime.request("/desktop/launcher/ack", { instanceId, requestId: randomUUID() }, headers)).status, 409);
  assert.equal((await runtime.request("/desktop/launcher/ack", { instanceId, requestId: result.requestId }, headers)).status, 200);
  await runtime.request("/desktop/launcher/detach", { instanceId }, headers);
  assert.equal((await runtime.request("/desktop/launcher/poll", { instanceId }, headers)).status, 410);
  presence = await runtime.presence("attendance"); await wait(350); assert.equal(f.attendance.length, 0);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true }); await until(() => f.attendance.length === 1);
});

test("an identity still resolving cannot cross an operator transition into resumed attendance", {timeout:20000}, async t => {
  const f = await fixture(t, { method: "member_id" }), runtime = await f.start();
  await until(() => f.heartbeats() > 0);
  let presence = await runtime.presence("attendance");
  await runtime.reader({ holdIdentity: true });
  const pending = runtime.request("/identity", { method: "member_id", memberId: "synthetic-member" });
  await until(async () => (await runtime.reader()).identityCalls === 1);
  presence = await runtime.presence("maintenance", presence);
  await runtime.presence("attendance", presence);
  await runtime.reader({ holdIdentity: false, releaseIdentity: true });
  const discarded = await pending;
  assert.equal(discarded.status, 400); assert.match((await discarded.json()).error, /mode changed/);
  await wait(300); assert.equal(f.attendance.length, 0);
  assert.equal((await runtime.request("/identity", { method: "member_id", memberId: "synthetic-member" })).status, 202);
  await until(() => f.attendance.length === 1);
});

for (const section of ["configuration", "command"]) test(`unpair drains detached ${section} application before archiving the old pairing`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { modern: section === "command", holdConfiguration: section === "configuration", holdCommand: section === "command" }), runtime = await f.start();
  t.after(() => { f.releaseConfiguration(); f.releaseCommand(); });
  await until(() => section === "configuration" ? f.configurationStarted() : f.commandStarted());
  assert.equal((await runtime.request("/network/unlock", { pin: "123456" })).status, 200);
  let completed = false;
  const unpair = runtime.request("/maintenance/unpair", { confirmation: "UNPAIR" }).then(response => { completed = true; return response; });
  await wait(200); assert.equal(completed, false);
  assert.equal(JSON.parse(await readFile(join(f.root, "pairing.json"), "utf8")).pairingId, "synthetic-pairing");
  f.releaseConfiguration(); f.releaseCommand();
  assert.equal((await unpair).status, 200);
  await assert.rejects(readFile(join(f.root, "pairing.json"), "utf8"), { code: "ENOENT" });
});
