import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const exact = (input, fields) => input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === fields.length && fields.every(field => Object.hasOwn(input, field));

// Local launcher control carries no OS process authority. The desktop account
// owns its child; this registry only publishes one fixed exit request.
export function createDesktopControl({ now = Date.now, leaseMs = 30_000 } = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000) throw new Error("Invalid desktop lease");
  const serviceId = randomUUID(), retired = new Set();
  let current;
  function retire() {
    if (current) retired.add(current.instanceId);
    while (retired.size > 64) retired.delete(retired.values().next().value);
    current = undefined;
  }
  function credentials(input, secret, fields = ["instanceId"]) {
    if (!exact(input, fields) || !uuid(input.instanceId) || typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) fail(400, "invalid_launcher_request");
    return createHash("sha256").update(secret).digest();
  }
  function owner(input, secret, fields) {
    const digest = credentials(input, secret, fields);
    if (!current) fail(retired.has(input.instanceId) ? 410 : 404, "launcher_not_registered");
    if (current.instanceId !== input.instanceId || !timingSafeEqual(current.digest, digest)) fail(409, "launcher_instance_changed");
    if (now() >= current.expiresAt) { retire(); fail(410, "launcher_lease_expired"); }
    return current;
  }
  const registration = () => ({ registered: true, serviceId, leaseMs });
  return {
    register(input, secret) {
      const digest = credentials(input, secret);
      if (retired.has(input.instanceId)) fail(410, "launcher_instance_expired");
      if (current && now() >= current.expiresAt) retire();
      if (retired.has(input.instanceId)) fail(410, "launcher_instance_expired");
      if (current) {
        if (current.instanceId !== input.instanceId || !timingSafeEqual(current.digest, digest)) fail(409, "launcher_already_registered");
        current.expiresAt = now() + leaseMs;
        return registration();
      }
      current = { instanceId: input.instanceId, digest, expiresAt: now() + leaseMs, requestId: null, acknowledged: false, requesting: undefined };
      return registration();
    },
    poll(input, secret) {
      const entry = owner(input, secret);
      entry.expiresAt = now() + leaseMs;
      return { serviceId, instanceId: entry.instanceId, requestId: entry.requestId, action: entry.requestId ? "exit" : "none" };
    },
    acknowledge(input, secret) {
      const entry = owner(input, secret, ["instanceId", "requestId"]);
      if (!uuid(input.requestId) || entry.requestId !== input.requestId) fail(409, "exit_request_changed");
      entry.acknowledged = true;
      return { completed: true, requestId: entry.requestId };
    },
    detach(input, secret) { owner(input, secret); retire(); return { detached: true }; },
    status() { return { available: Boolean(current && now() < current.expiresAt), exitPending: Boolean(current?.requestId), completed: Boolean(current?.acknowledged) }; },
    async requestExit(beforePublish = async () => {}) {
      if (!current || now() >= current.expiresAt) fail(503, "desktop_launcher_unavailable");
      const entry = current;
      if (!entry.requesting) entry.requesting = (async () => {
        await beforePublish();
        if (current !== entry || now() >= entry.expiresAt) fail(503, "desktop_launcher_unavailable");
        entry.requestId ??= randomUUID();
        return { requested: true, instanceId: entry.instanceId, requestId: entry.requestId };
      })().catch(error => { entry.requesting = undefined; throw error; });
      return entry.requesting;
    },
  };
}
