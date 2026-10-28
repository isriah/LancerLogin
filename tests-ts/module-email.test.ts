import test from "node:test";
import assert from "node:assert/strict";
import { moduleEmailIdempotencyKey, moduleEmailMessage, resendModuleEmailPayload } from "../apps/api/src/module-email.ts";

test("module email messages are validated before any provider request", () => {
  const message = moduleEmailMessage({ to: " guest@example.test ", subject: " Visit confirmed ", html: "<p>Hi</p>", replyTo: "team@example.test", idempotencyKey: "booking-1:confirm" });
  assert.deepEqual(message, { to: "guest@example.test", subject: "Visit confirmed", idempotencyKey: "booking-1:confirm", html: "<p>Hi</p>", replyTo: "team@example.test" });
  assert.deepEqual(resendModuleEmailPayload("noreply@example.test", message), { from: "noreply@example.test", to: ["guest@example.test"], subject: "Visit confirmed", html: "<p>Hi</p>", reply_to: "team@example.test" });
  assert.equal(moduleEmailIdempotencyKey("visits", "booking-1:confirm"), "module-visits-booking-1:confirm");
  const base = { to: "guest@example.test", subject: "Hello", text: "Body", idempotencyKey: "key-1" };
  for (const [change, pattern] of [
    [{ to: "a@b.test, c@d.test" }, /one email address/], [{ to: ["guest@example.test"] }, /one email address/], [{ to: "Guest <guest@example.test>" }, /one email address/],
    [{ subject: "" }, /subject/], [{ subject: "Line\nBcc: x@y.test" }, /subject/], [{ subject: "x".repeat(201) }, /subject/],
    [{ text: undefined }, /html or text/], [{ text: " " }, /text must be non-empty/], [{ html: "x".repeat(200_001) }, /html must be/],
    [{ idempotencyKey: "" }, /idempotency key/], [{ idempotencyKey: "has space" }, /idempotency key/], [{ replyTo: "nope" }, /reply-to/],
  ] as const) assert.throws(() => moduleEmailMessage({ ...base, ...change }), pattern, JSON.stringify(change));
  for (const value of [undefined, null, [], "text"]) assert.throws(() => moduleEmailMessage(value), /must be an object/);
});
