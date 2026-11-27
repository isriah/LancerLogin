// The virtual kiosk scenarios' start-up (scripts/virtual-kiosk/test-stack.mjs): which failures it retries, that it
// retries at most once, and how it picks free ports. The stack itself is faked here; nothing starts a Worker or a kiosk.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { choosePortBase, portFree, stackPortSpan, startupSignature, startupSignatures, startVirtualKioskStack } from "../scripts/virtual-kiosk/test-stack.mjs";

// Output the stack printed in failed starts on CI runners and locally, one sample per known signature.
const known = {
  "port-in-use": [
    "Virtual kiosk failed: The kiosk screen proxy could not listen on 127.0.0.1:23320: listen EADDRINUSE: address already in use 127.0.0.1:23320",
    "error: Port 23303 is already in use",
    "✘ [ERROR] Address already in use; toString() = failed to listen on port 23302",
  ],
  workerd: [
    "MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start. There is likely additional logging output above.",
    "Virtual kiosk failed: The local Worker did not start within 120 s",
  ],
  "preview-server-exit": ["A local preview server stopped (exit 1). Stopping the virtual kiosk."],
  "pairing-fetch": [
    "Virtual kiosk failed: TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n    at async kioskCall (scripts/virtual-kiosk.mjs:412:20)\n    at async pairKiosk",
    "Virtual kiosk failed: Pairing Virtual kiosk 1 failed: {\"error\":\"fetch failed\"}",
  ],
  "screen-proxy": [
    "Virtual kiosk failed: Virtual kiosk 1's screen proxy did not start within 30 s",
    "Virtual kiosk failed: The kiosk screen proxy could not listen on 127.0.0.1:23320: listen ECONNREFUSED",
  ],
};

test("every known start-up signature is recognised, and each sample names the right one", () => {
  assert.deepEqual(startupSignatures.map((signature) => signature.id), ["port-in-use", "workerd", "preview-server-exit", "pairing-fetch", "screen-proxy"]);
  for (const [id, samples] of Object.entries(known)) {
    for (const sample of samples) {
      const found = startupSignature(`some earlier line\n${sample}\n`);
      assert.ok(found, sample);
      // A screen proxy that can't take its port is a port problem first; the earlier signature wins.
      if (!(id === "screen-proxy" && /could not listen/.test(sample))) assert.equal(found.id, id, sample);
    }
  }
});

test("failures caused by the code under test are not start-up signatures, so they are never retried", () => {
  for (const output of [
    "Virtual kiosk failed: POST /admin/members returned 400: {\"error\":\"Member ID is required\"}",
    "Virtual kiosk failed: Applying Core migrations to the local database failed",
    "✘ [ERROR] Build failed with 1 error:\n✘ [ERROR] Could not resolve \"./missing.ts\"\nA local preview server stopped (exit 1). Stopping the virtual kiosk.",
    "Virtual kiosk failed: The virtual kiosk runs only on a developer's computer or a CI test runner, and CLOUDFLARE_API_TOKEN is set.",
    "Error: expect(locator).toHaveText(expected) failed",
    "Virtual kiosk 1 did not start within 30 s",
    "",
  ]) assert.equal(startupSignature(output), undefined, output);
});

/** A fake stack: each launch plays the next script, printing its lines, then exiting or becoming ready. */
function fakeStacks(scripts) {
  const launches = []; let ready = false;
  const launch = ({ base, state, onLine }) => {
    const script = scripts[launches.length]; const entry = { base, state, stopped: false };
    launches.push(entry);
    let finish; const exited = new Promise((resolveExit) => { finish = resolveExit; });
    queueMicrotask(() => {
      for (const line of script.lines ?? []) onLine(line);
      if (script.ready) ready = true; else if (script.exit !== undefined) finish(script.exit);
    });
    return { exited, stop: async () => { entry.stopped = true; ready = false; finish(null); } };
  };
  return { launches, launch, isReady: async () => ready };
}
const quiet = { log: () => {}, recordBase: () => {}, pickBase: async (base) => base, pollMs: 5 };

test("a start that fails with a known signature is stopped and started once more on a fresh state folder", async () => {
  const stacks = fakeStacks([{ lines: ["Virtual kiosk failed: TypeError: fetch failed"], exit: 1 }, { lines: ["Virtual kiosk control panel: ..."], ready: true }]);
  const logged = [];
  const stack = await startVirtualKioskStack({ ...quiet, requestedBase: 23_300, launch: stacks.launch, isReady: stacks.isReady, log: (line) => logged.push(line) });
  assert.equal(stack.attempts, 2);
  assert.equal(stack.panelUrl, "http://127.0.0.1:23300");
  assert.deepEqual(stacks.launches.map(({ state }) => state), [".provision/virtual-kiosk-tests", ".provision/virtual-kiosk-tests-23300-2"]);
  assert.equal(stacks.launches[0].stopped, true);
  assert.ok(logged.some((line) => /Start-up failed: a request failed while the stack seeded the preview or paired the kiosk \[pairing-fetch\]/.test(line)));
  await stack.stop();
  assert.equal(stacks.launches[1].stopped, true);
});

test("a start that fails for any other reason is not retried, and says so", async () => {
  const stacks = fakeStacks([{ lines: ["Virtual kiosk failed: POST /admin/members returned 400"], exit: 1 }, { ready: true }]);
  await assert.rejects(startVirtualKioskStack({ ...quiet, requestedBase: 23_300, launch: stacks.launch, isReady: stacks.isReady }),
    /Attempt 1 on ports from 23300: the stack exited \(1\) before its control panel answered\. This is not a known start-up signature, so it was not retried: treat it as a real failure\.\nLast lines from the stack:\nVirtual kiosk failed: POST \/admin\/members returned 400/);
  assert.equal(stacks.launches.length, 1);
});

test("a known failure that repeats fails after the second start, never a third", async () => {
  const workerd = { lines: ["MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start."], exit: 1 };
  const stacks = fakeStacks([workerd, workerd, { ready: true }]);
  await assert.rejects(startVirtualKioskStack({ ...quiet, requestedBase: 23_300, launch: stacks.launch, isReady: stacks.isReady }),
    /Attempt 1 [^.]+; the local Worker \(wrangler and workerd\) failed to start \[workerd\]\. Attempt 2 [^.]+; the local Worker \(wrangler and workerd\) failed to start \[workerd\]\. It failed the same known way twice/);
  assert.equal(stacks.launches.length, 2);
});

test("a stack that never answers is stopped at the time limit and retried only when its output names a known cause", async () => {
  const hung = fakeStacks([{ lines: ["Virtual kiosk 1's screen proxy did not start within 30 s"] }, { ready: true }]);
  const stack = await startVirtualKioskStack({ ...quiet, requestedBase: 23_300, readyTimeoutMs: 50, launch: hung.launch, isReady: hung.isReady });
  assert.equal(stack.attempts, 2); assert.equal(hung.launches[0].stopped, true);
  const silent = fakeStacks([{ lines: ["Local dashboard: http://localhost:23303"] }, { ready: true }]);
  await assert.rejects(startVirtualKioskStack({ ...quiet, requestedBase: 23_300, readyTimeoutMs: 50, launch: silent.launch, isReady: silent.isReady }),
    /control panel did not answer within 0 s\. This is not a known start-up signature/);
  assert.equal(silent.launches.length, 1); assert.equal(silent.launches[0].stopped, true);
});

test("each attempt picks its ports afresh and starts on a moved block with its own state folder", async () => {
  const stacks = fakeStacks([{ lines: ["listen EADDRINUSE: address already in use 127.0.0.1:23302"], exit: 1 }, { ready: true }]);
  const bases = [23_300, 23_400]; const recorded = [];
  const stack = await startVirtualKioskStack({ ...quiet, requestedBase: 23_300, launch: stacks.launch, isReady: stacks.isReady, pickBase: async () => bases.shift(), recordBase: (base) => recorded.push(base) });
  assert.equal(stack.base, 23_400); assert.equal(stack.panelUrl, "http://127.0.0.1:23400");
  assert.deepEqual(recorded, [23_300, 23_400]);
  assert.deepEqual(stacks.launches.map(({ base, state }) => [base, state]), [[23_300, ".provision/virtual-kiosk-tests"], [23_400, ".provision/virtual-kiosk-tests-23400-2"]]);
});

test("the port choice skips a block with any port in use and names it when every block is taken", async () => {
  const taken = new Set([23_333, 23_405]);
  const isFree = async (port) => !taken.has(port);
  assert.equal(await choosePortBase(23_300, { isFree }), 23_500);
  assert.equal(await choosePortBase(23_334, { isFree }), 23_334);
  await assert.rejects(choosePortBase(23_300, { isFree: async () => false, candidates: 2 }), /tried 23300 \(port 23300 is in use\), 23400 \(port 23400 is in use\)/);
  assert.equal(stackPortSpan, 34);
});

test("portFree sees a port another server holds on loopback", async (t) => {
  const server = createServer(); await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal(await portFree(port), false);
  await new Promise((resolveClose) => server.close(resolveClose));
  assert.equal(await portFree(port), true);
});
