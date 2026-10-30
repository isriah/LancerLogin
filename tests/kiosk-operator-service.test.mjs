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
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await wait(30); } assert.fail("Synthetic runtime condition did not become true"); }
async function fixture(t, { method = "fingerprint", modern = false, holdConfiguration = false, holdCommand = false, enrollment = false, confirmClock = true, reviewUnavailable = false, minimumScore, reenrollScore, refuseAttendance = false, commandType, enrollmentReports = "modern" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-operator-service-")); await chmod(root, 0o700);
  let rosterMode = "valid", heartbeats = 0, configurationStarted = false, commandStarted = false, releaseConfiguration, releaseCommand;
  const attendance = [], attendanceRefusals = [];
  const reviewRequests = [];
  const heartbeatReports = [];
  const commandResults = []; let commandQueued = false;
  let enrollmentSession = enrollment ? { id: "synthetic-session", pairingId: "synthetic-pairing", expiresAt: new Date(Date.now() + 300000).toISOString(), state: "ready", progress: "awaiting_confirmation", member: { memberId: "synthetic-member", rosterId: "synthetic-roster", firstName: "Sample", lastName: "Member" } } : null;
  const enrollmentProgress = [], enrollmentReportRequests = [], enrollmentReportsAccepted = [];
  const cloud = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    let data = {};
    if (request.url?.startsWith("/kiosk/poll?")) {
      if (!modern) { response.statusCode = 404; data = { error: "Not found" }; }
      else data = { protocol: 1, command: holdCommand ? { id: "synthetic-command", type: "reload_display" } : commandType && commandQueued && !commandResults.length ? { id: "synthetic-command", type: commandType } : null, ...(enrollment ? { enrollment: enrollmentSession } : {}),
        configuration: { kiosk: { id: "synthetic-kiosk", name: "Dashboard configured name" }, settings: { authenticationMethod: method } },
        fingerprints: { reset: { status: "ok", commands: [] }, roster: { status: "ok", revision: 1, notModified: false, members: [{ memberId: "synthetic-member", rosterId: "synthetic-roster" }] }, peer: { status: "ok", enabled: false, syncId: null, deliveries: [] }, vault: { status: "ok", enabled: false, vaultId: null, catalogRevision: null } } };
    }
    else if (request.url === "/kiosk/enrollment") data = { enrollment: enrollmentSession };
    else if (request.url === "/kiosk/enrollment/synthetic-session/progress") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString()); enrollmentProgress.push(input.status);
      enrollmentSession = { ...enrollmentSession, progress: input.status }; data = { session: enrollmentSession };
    }
    else if (request.url === "/kiosk/config") {
      configurationStarted = true;
      if (holdConfiguration) await new Promise(resolve => { releaseConfiguration = resolve; });
      data = { settings: { authenticationMethod: method, ...(minimumScore === undefined ? {} : { fingerprintMinimumScore: minimumScore }), ...(reenrollScore === undefined ? {} : { fingerprintReenrollScore: reenrollScore }) }, kiosk: { name: "Dashboard configured name" } };
    } else if (request.url === "/kiosk/commands/synthetic-command/result") {
      commandStarted = true;
      if (holdCommand) await new Promise(resolve => { releaseCommand = resolve; });
      const chunks = []; for await (const chunk of request) chunks.push(chunk); commandResults.push(JSON.parse(Buffer.concat(chunks).toString()));
      data = { completed: true };
    }
    else if (request.url === "/kiosk/scan-reviews") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const { records } = JSON.parse(Buffer.concat(chunks).toString());
      reviewRequests.push(records);
      if (reviewUnavailable) { response.statusCode = 404; data = { error: "Not found" }; }
      else data = { reviews: records.map(record => ({ eventId: record.eventId, reviewStatus: "reviewed" })) };
    }
    else if (request.url === "/kiosk/heartbeat") {
      heartbeats++;
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      heartbeatReports.push(JSON.parse(Buffer.concat(chunks).toString()));
    }
    else if (request.url === "/kiosk/roster") {
      if (rosterMode === "offline") { response.statusCode = 503; data = { error: "Synthetic private error" }; }
      else data = { members: rosterMode === "missing" ? [] : [{ memberId: "synthetic-member", ...(rosterMode === "no_identity" ? {} : { rosterId: "synthetic-roster" }) }] };
    } else if (request.url === "/kiosk/attendance") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks).toString());
      if (refuseAttendance) { attendanceRefusals.push(event); response.statusCode = 409; response.end(JSON.stringify({ error: "Scan again", code: "possible_wrong_match" })); return; }
      const duplicate = attendance.some(previous => previous.eventId === event.eventId);
      if (!duplicate) attendance.push(event);
      data = { eventId: event.eventId, ...(duplicate ? { duplicate: true } : { accepted: true }), action: "check_in" };
    } else if (request.url === "/kiosk/fingerprint-enrollments") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const report = JSON.parse(Buffer.concat(chunks).toString()); enrollmentReportRequests.push(report);
      // An older Worker has no such route and answers with its generic 404.
      if (enrollmentReports === "missing") { response.statusCode = 404; data = { error: "Not found" }; }
      else { const duplicate = enrollmentReportsAccepted.some(previous => previous.eventId === report.eventId); if (!duplicate) enrollmentReportsAccepted.push(report); data = { eventId: report.eventId, accepted: !duplicate, duplicate, reenrolledAt: report.enrolledAt }; }
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
  async function start({ initializeClock = confirmClock } = {}) {
    const child = fork(new URL("./fixtures/kiosk-operator-runtime-child.mjs",import.meta.url), [], { env, execArgv:["--experimental-test-module-mocks"], stdio:["ignore","pipe","pipe","ipc"] }); children.push(child);
    let diagnostics=""; child.stderr.on("data", chunk => { diagnostics += chunk; });
    const port = await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error("Child startup timed out: "+diagnostics)),5000); child.on("message",message=>{if(message.ready){clearTimeout(timer);resolve(message.port);}}); child.once("exit",()=>{clearTimeout(timer);reject(new Error("Child failed: "+diagnostics));}); });
    let sequence=0;
    async function reader(input={}) { const id=++sequence; return new Promise(resolve=>{const listener=message=>{if(message.id===id){child.off("message",listener);resolve(message);}};child.on("message",listener);child.send({...input,id});}); }
    const request=(path,input,headers={})=>fetch(`http://127.0.0.1:${port}${path}`,{method:input===undefined?"GET":"POST",headers:{"content-type":"application/json",...headers},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(5000)});
    // These operator tests begin with an established attendance clock. Exercise
    // the real PIN-protected confirmation without leaving maintenance unlocked.
    if (initializeClock && !(await (await request("/health")).json()).clock.verified) {
      assert.equal((await request("/network/unlock", { pin: "123456" })).status, 200);
      const confirmed = await request("/maintenance/clock", { currentTime: new Date().toISOString() });
      assert.ok(confirmed.ok || (await (await request("/health")).json()).clock.verified);
      await fetch(`http://127.0.0.1:${port}/network/session`, { method: "DELETE" });
    }
    async function presence(mode, previous) { const response=await request("/operator-presence",{action:previous?"transition":"enter",pageId:"synthetic-runtime-page",mode,...(previous?{generation:previous.generation}:{})});assert.equal(response.status,200);return response.json(); }
    async function stop(orderly = true) { const done = once(child, "exit"); child.send(orderly ? { orderlyStop: true } : { crashStop: true }); await done; }
    return { child, request, reader, presence, stop };
  }
  return { root, start, attendance, attendanceRefusals, reviewRequests, enrollmentReportRequests, enrollmentReportsAccepted, updateWorker: () => { enrollmentReports = "modern"; }, heartbeatReports, commandResults, queueCommand: () => { commandQueued = true; }, enrollmentProgress, roster: mode=>{rosterMode=mode;}, heartbeats:()=>heartbeats,
    configurationStarted: () => configurationStarted, commandStarted: () => commandStarted,
    releaseConfiguration: () => { holdConfiguration = false; releaseConfiguration?.(); }, releaseCommand: () => { holdCommand = false; releaseCommand?.(); },
  };
}

test("orderly restart recovery renews the existing attendance page without entering again", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let runtime = await f.start();
  const page = await runtime.presence("attendance");
  await runtime.stop();
  const checkpoint = JSON.parse(await readFile(join(f.root, "pairing.json.presence-restart.json"), "utf8"));
  assert.equal(checkpoint.presence.pages.length, 1);
  assert.ok(checkpoint.presence.pages[0].remainingMs > 0 && checkpoint.presence.pages[0].remainingMs <= 15000);
  runtime = await f.start({ initializeClock: false });
  const renewal = await runtime.request("/operator-presence", { action: "renew", pageId: page.pageId, generation: page.generation, mode: "attendance" });
  assert.equal(renewal.status, 200);
  const renewed = await renewal.json();
  assert.equal(renewed.generation, page.generation);
  assert.equal(renewed.captureSuspended, false);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
  await until(() => f.attendance.length === 1);
  await assert.rejects(readFile(join(f.root, "pairing.json.presence-restart.json")), { code: "ENOENT" });
});

test("orderly restart recovery keeps maintenance capture blocked when attendance renews first and never restores PIN authorization", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let runtime = await f.start();
  const attendance = await (await runtime.request("/operator-presence", { action: "enter", pageId: "synthetic-background-attendance", mode: "attendance" })).json();
  const maintenance = await runtime.presence("maintenance");
  assert.equal((await runtime.request("/network/unlock", { pin: "123456" })).status, 200);
  assert.equal((await (await runtime.request("/maintenance/session")).json()).authorized, true);
  await runtime.stop();
  runtime = await f.start({ initializeClock: false });
  const renewal = await runtime.request("/operator-presence", { action: "renew", pageId: attendance.pageId, generation: attendance.generation, mode: "attendance" });
  assert.equal(renewal.status, 200);
  assert.equal((await renewal.json()).captureSuspended, true);
  assert.equal((await (await runtime.request("/maintenance/session")).json()).authorized, false);
  assert.equal((await runtime.request("/sensor/test", {})).status, 403);
  assert.equal((await runtime.request("/attendance", { memberId: "synthetic-member" })).status, 400);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true }); await wait(350);
  assert.equal(f.attendance.length, 0);
  const maintenanceRenewal = await runtime.request("/operator-presence", { action: "renew", pageId: maintenance.pageId, generation: maintenance.generation, mode: "maintenance" });
  assert.equal(maintenanceRenewal.status, 200);
  assert.equal((await maintenanceRenewal.json()).captureSuspended, true);
});

test("unexpected stop recovery has no checkpoint and rejects the old page generation", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let runtime = await f.start();
  const page = await runtime.presence("attendance");
  await runtime.stop(false);
  await assert.rejects(readFile(join(f.root, "pairing.json.presence-restart.json")), { code: "ENOENT" });
  runtime = await f.start({ initializeClock: false });
  assert.equal((await runtime.request("/operator-presence", { action: "renew", pageId: page.pageId, generation: page.generation, mode: "attendance" })).status, 409);
  assert.equal((await runtime.request("/attendance", { memberId: "synthetic-member" })).status, 400);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true }); await wait(350);
  assert.equal(f.attendance.length, 0);
});

test("a real kiosk synchronizes retained review evidence and applies acknowledgement without attendance writes", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const record = { eventId: "synthetic-rejected", memberId: "synthetic-member", occurredAt: "2026-01-01T00:00:00.000Z", reasonCode: "clock_unverified", httpStatus: null, reviewStatus: "open" };
  await writeFile(join(f.root, "attendance-queue.json.outcomes.json"), JSON.stringify({ version: 1, accepted: 0, duplicate: 0, rejected: [record], pendingAck: null, historyComplete: true }), { mode: 0o600 });
  const runtime = await f.start();
  await until(() => f.reviewRequests.length === 1);
  assert.deepEqual(f.reviewRequests[0], [record]);
  await until(async () => (await (await runtime.request("/health")).json()).attendance.needsReview === 0);
  // Read the durable state (snapshot plus journal) as a fresh process would.
  const saved = await createFileQueue(join(f.root, "attendance-queue.json")).rejections();
  assert.equal(saved[0].reviewStatus, "reviewed");
  assert.equal(saved[0].occurredAt, record.occurredAt);
  assert.equal(f.attendance.length, 0);
});

test("an older review API leaves attendance delivery active and reports review sync failure to administrators", { timeout: 15000 }, async t => {
  const f = await fixture(t, { reviewUnavailable: true });
  const record = { eventId: "synthetic-rejected", memberId: "synthetic-member", occurredAt: "2026-01-01T00:00:00.000Z", reasonCode: "clock_unverified", httpStatus: null, reviewStatus: "open" };
  await writeFile(join(f.root, "attendance-queue.json.outcomes.json"), JSON.stringify({ version: 1, accepted: 0, duplicate: 0, rejected: [record], pendingAck: null, historyComplete: true }), { mode: 0o600 });
  await writeFile(join(f.root, "attendance-queue.json"), JSON.stringify([{ eventId: "synthetic-pending", memberId: "synthetic-member", pairingId: "synthetic-pairing", occurredAt: "2026-01-01T08:00:00.000Z", clock: { version: 1, verified: true } }]), { mode: 0o600 });
  const runtime = await f.start();
  await until(() => f.heartbeatReports.length > 0);
  assert.equal(f.attendance.length, 1);
  assert.equal(f.heartbeatReports[0].errorCategory, "cloud_sync");
  assert.deepEqual({ ...f.heartbeatReports[0].attention, clockConfirmed: undefined }, { scansNeedReview: 1, clockConfirmed: undefined, clockPendingScans: 0, reviewSyncFailing: true, weakMatches: 0, readerTemplates: 1, linkedTemplates: 1 });
  // The real service always reports its installed update policy; this host has no root update helper.
  assert.equal(f.heartbeatReports[0].updatePolicyVersion, 1);
  const health = await (await runtime.request("/health")).json();
  assert.equal(health.cloudOnline, true);
  assert.equal(health.attendance.pending, 0);
  assert.equal(health.attendance.needsReview, 1);
  assert.deepEqual(await createFileQueue(join(f.root, "attendance-queue.json")).rejections(), [record]);
});

test("a real kiosk pauses scans until the operator confirms the offline boot clock", { timeout: 15000 }, async t => {
  const f = await fixture(t, { confirmClock: false }), runtime = await f.start();
  let presence = await runtime.presence("attendance");
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true }); await wait(350);
  assert.equal(f.attendance.length, 0);
  assert.equal((await (await runtime.request("/display-state")).json()).display.id, "clock_required");
  assert.equal((await runtime.request("/maintenance/clock", { currentTime: new Date().toISOString() })).status, 403);
  presence = await runtime.presence("maintenance", presence);
  await runtime.request("/network/unlock", { pin: "123456" });
  assert.equal((await runtime.request("/maintenance/clock", { currentTime: new Date().toISOString() })).status, 200);
  await runtime.presence("attendance", presence);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
  await until(() => f.attendance.length === 1);
  assert.equal((await (await runtime.request("/display-state")).json()).clock.source, "operator");
});

test("dashboard enrollment in a real service never unlocks local maintenance or replaces occupied slots", { timeout: 15000 }, async t => {
  const f = await fixture(t, { modern: true, enrollment: true }), runtime = await f.start();
  await until(async () => Boolean((await (await runtime.request("/display-state")).json()).enrollment));
  assert.equal((await (await runtime.request("/maintenance/session")).json()).authorized, false);
  assert.equal((await runtime.request("/sensor/test", {})).status, 403);
  assert.equal((await runtime.request("/maintenance/enrollment/synthetic-session/confirm", { slot: 0 })).status, 409);
  assert.equal((await runtime.reader()).enrollCalls, 0);
  assert.equal((await runtime.request("/maintenance/enrollment/synthetic-session/confirm", {}, { origin: "https://untrusted.example" })).status, 403);
  const response = await runtime.request("/maintenance/enrollment/synthetic-session/confirm", {});
  assert.equal(response.status, 201, await response.clone().text()); assert.equal((await response.json()).slot, 1);
  assert.deepEqual(f.enrollmentProgress, ["awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second", "enroll_success"]);
  assert.equal((await (await runtime.request("/maintenance/session")).json()).authorized, false);
  assert.equal((await runtime.request("/sensor/test", {})).status, 403);
  const mappings = JSON.parse(await readFile(join(f.root, "slot-mappings.json"), "utf8"));
  assert.equal(mappings[0].memberId, "synthetic-member"); assert.equal(mappings[1].rosterId, "synthetic-roster");
});

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

test("a real kiosk records the match score with each scan and asks for a rescan below the Admin's minimum", { timeout: 20000 }, async t => {
  for (const minimumScore of [undefined, 100, 150]) {
    const f = await fixture(t, { minimumScore }), runtime = await f.start();
    await until(() => f.heartbeats() > 0);
    await runtime.presence("attendance"); await wait(350);
    await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
    if (minimumScore === 150) {
      await until(async () => (await (await runtime.request("/display-state")).json()).display.message === "Try again");
      await wait(500);
      assert.equal(f.attendance.length, 0, "a match scoring 100 is not recorded below a minimum of 150");
      assert.deepEqual(JSON.parse(await readFile(join(f.root, "fingerprint-match.json"), "utf8")), { minimumScore: 150, reenrollScore: 0 });
    } else {
      await until(() => f.attendance.length === 1);
      assert.equal(f.attendance[0].matchScore, 100, "a match at or above the minimum is recorded with its score");
    }
    assert.equal(f.heartbeatReports[0].attention.weakMatches, 0);
    await runtime.stop();
  }
});

test("a real kiosk records a weakly reading accepted scan and adds the re-enrollment note only below the threshold", { timeout: 20000 }, async t => {
  for (const reenrollScore of [80, 120]) {
    const f = await fixture(t, { minimumScore: 60, reenrollScore }), runtime = await f.start();
    await until(() => f.heartbeats() > 0);
    await runtime.presence("attendance"); await wait(350);
    await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
    await until(() => f.attendance.length === 1);
    await until(async () => (await (await runtime.request("/display-state")).json()).display.id === "welcome");
    const { display } = await (await runtime.request("/display-state")).json();
    assert.equal(f.attendance[0].matchScore, 100, "attendance is recorded either way");
    assert.equal(display.notice, reenrollScore === 120 ? "Your fingerprint is reading weakly. Ask a mentor to re-enroll it." : undefined);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "fingerprint-match.json"), "utf8")), { minimumScore: 60, reenrollScore });
    await runtime.stop();
  }
});

test("a real kiosk asks for a rescan when the Worker refuses a possible wrong match, without queueing it for review", { timeout: 20000 }, async t => {
  const f = await fixture(t, { refuseAttendance: true }), runtime = await f.start();
  await until(() => f.heartbeats() > 0);
  await runtime.presence("attendance"); await wait(350);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
  await until(async () => (await (await runtime.request("/display-state")).json()).display.id === "rescan");
  const { display } = await (await runtime.request("/display-state")).json();
  assert.deepEqual([display.message, display.tone], ["Scan again", "notice"]);
  assert.equal(f.attendanceRefusals.length, 1);
  assert.equal(f.attendanceRefusals[0].rescanSupported, true);
  const { attendance } = await (await runtime.request("/health")).json();
  assert.deepEqual([attendance.pending, attendance.rejected, attendance.needsReview], [0, 0, 0], "the refused scan is neither retried nor kept for review");
  await wait(300);
  assert.equal(f.attendanceRefusals.length, 1);
  assert.equal(f.reviewRequests.length, 0);
  await runtime.stop();
});

test("a real kiosk erases only unlinked reader fingerprints on the dashboard command and reports reader counts", { timeout: 20000 }, async t => {
  const f = await fixture(t, { modern: true, commandType: "erase_unlinked_fingerprints" });
  const runtime = await f.start();
  await runtime.reader({ occupy: [3, 7] }); f.queueCommand();
  // Commands arrive with the next five-second cloud poll.
  for (let n = 0; n < 400 && !f.commandResults.length; n++) await wait(30);
  assert.equal(f.commandResults.length, 1);
  assert.equal(f.commandResults[0].success, true, f.commandResults[0].message);
  assert.match(f.commandResults[0].message, /^Erased 2 unlinked fingerprints. The reader now stores 1 of 200, 1 linked to members.$/);
  assert.deepEqual((await runtime.reader()).occupied, [0], "the linked fingerprint in slot 0 is kept");
  await until(() => f.heartbeatReports.length > 0);
  assert.equal(f.heartbeatReports[0].attention.linkedTemplates, 1);
  assert.ok(Number.isInteger(f.heartbeatReports[0].attention.readerTemplates));
});

test("a maintenance-screen enrollment is reported to the Worker with only the member, time and pairing", { timeout: 20000 }, async t => {
  const f = await fixture(t), runtime = await f.start(); await runtime.presence("maintenance");
  assert.equal((await runtime.request("/network/unlock", { pin: "123456" })).status, 200);
  const before = Date.now();
  assert.equal((await runtime.request("/enroll", { memberId: "synthetic-member", slot: 1 })).status, 201);
  await until(() => f.enrollmentReportsAccepted.length === 1);
  const [report] = f.enrollmentReportsAccepted;
  assert.deepEqual(Object.keys(report).sort(), ["enrolledAt", "eventId", "pairingId", "rosterId"], "no template or other biometric data");
  assert.equal(report.rosterId, "synthetic-roster"); assert.equal(report.pairingId, "synthetic-pairing");
  assert.ok(Date.parse(report.enrolledAt) >= before - 1000 && Date.parse(report.enrolledAt) <= Date.now());
  await runtime.stop();
  assert.deepEqual(await createFileQueue(join(f.root, "local-enrollment-reports.json")).pending(), [], "a delivered report leaves the queue");
  for (const name of ["attendance-queue.json", "attendance-queue.json.outcomes.json", "attendance-queue.json.journal"]) {
    const text = await readFile(join(f.root, name), "utf8").catch(() => "");
    assert.doesNotMatch(text, /local-enrollment|synthetic-roster/, `${name} keeps only attendance records`);
  }
});

test("an older Worker without the endpoint parks enrollment reports without holding up attendance", { timeout: 25000 }, async t => {
  const f = await fixture(t, { enrollmentReports: "missing" });
  let runtime = await f.start(), presence = await runtime.presence("maintenance");
  assert.equal((await runtime.request("/network/unlock", { pin: "123456" })).status, 200);
  assert.equal((await runtime.request("/enroll", { memberId: "synthetic-member", slot: 1 })).status, 201);
  await until(() => f.enrollmentReportRequests.length === 1);
  presence = await runtime.presence("attendance", presence); await wait(350);
  await runtime.reader({ present: false }); await wait(350); await runtime.reader({ present: true });
  await until(() => f.attendance.length === 1);
  await runtime.stop();
  const parked = await createFileQueue(join(f.root, "local-enrollment-reports.json")).pending();
  assert.equal(parked.length, 1, "parked, not dropped");
  assert.equal(parked[0].rosterId, "synthetic-roster");
  // Once the Worker is updated, the parked report is delivered after the restart.
  f.updateWorker(); runtime = await f.start({ initializeClock: false });
  await until(() => f.enrollmentReportsAccepted.length === 1);
  assert.equal(f.enrollmentReportsAccepted[0].eventId, parked[0].eventId);
});
