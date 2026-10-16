import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { operatorPresenceApp } from "../apps/kiosk/src/operator-presence-ui.mjs";

test("queued local renewal uses the acknowledged mode after an asynchronous transition", { timeout: 2000 }, async () => {
  const requests = [], errors = [];
  let interval, releaseTransition, finishRenewal;
  const renewal = new Promise(resolve => { finishRenewal = resolve; });
  const create = runInNewContext(operatorPresenceApp.replace("export function", "function") + "; createOperatorPresence;", {
    crypto: { randomUUID: () => "synthetic-client-page-identifier" }, AbortSignal,
    setInterval: callback => { interval = callback; return 1; }, clearInterval() {},
    fetch: async (_url, options) => {
      const input = JSON.parse(options.body); requests.push(input);
      if (input.action === "renew") finishRenewal(input);
      if (input.action === "transition") await new Promise(resolve => { releaseTransition = resolve; });
      return Response.json({ ...input, generation: input.action === "enter" ? 1 : 2, captureSuspended: input.mode !== "attendance" });
    }
  });
  const client = create({ onError: error => errors.push(error) });
  await client.enter("attendance");
  const transition = client.transition("network");
  for (let count = 0; count < 10 && !releaseTransition; count++) await Promise.resolve();
  assert.equal(typeof releaseTransition, "function");
  interval(); releaseTransition(); await transition;
  await renewal;
  assert.equal(requests[2].action, "renew");
  assert.equal(requests[2].generation, 2);
  assert.equal(requests[2].mode, "network");
  assert.equal(errors.length, 0);
  client.stop();
});
