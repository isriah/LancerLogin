import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function issuePairingCode({ now = () => Date.now(), ttlMs = 10 * 60_000, random = randomBytes }) {
  const code = random(6).toString("base64url").slice(0, 8).toUpperCase();
  return { code, codeHash: digest(code), expiresAt: new Date(now() + ttlMs).toISOString(), status: "unused" };
}

export function redeemPairingCode(record, submittedCode, now = new Date()) {
  const expected = Buffer.from(record.codeHash, "hex");
  const actual = Buffer.from(digest(submittedCode), "hex");
  if (record.status !== "unused" || Date.parse(record.expiresAt) <= now.getTime() || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };
  return { ok: true, record: { ...record, status: "redeemed", redeemedAt: now.toISOString() } };
}

export function createOfflineQueue() {
  const queued = [];
  return {
    enqueue(event) {
      if (!event.id || queued.some((item) => item.id === event.id)) return false;
      queued.push(Object.freeze({ ...event }));
      return true;
    },
    pending: () => [...queued],
    async flush(send) {
      const delivered = [];
      while (queued.length) {
        const event = queued[0];
        try { await send(event); } catch { break; }
        delivered.push(queued.shift().id);
      }
      return delivered;
    },
  };
}

export function createSensorAdapter(sensor) {
  return {
    async test() {
      const status = await sensor.status();
      return { readerOnline: status.connected === true, templateCount: status.templateCount ?? 0 };
    },
    async match() {
      const result = await sensor.match();
      return result?.slot === undefined ? { matched: false } : { matched: true, slot: result.slot };
    },
  };
}
