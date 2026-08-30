import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requireCapability } from "../../../packages/shared/src/policy.mjs";

const digest = (value) => createHash("sha256").update(value).digest();

export function createPairingService({ now = () => Date.now(), random = randomBytes, ttlMs = 10 * 60_000 } = {}) {
  let active;
  return {
    create(principal) {
      requireCapability(principal, "manage-security");
      let code; let codeHash;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        code = random(9).toString("base64url").slice(0, 12).toUpperCase();
        codeHash = digest(code);
        if (!active || !timingSafeEqual(codeHash, active.codeHash)) break;
      }
      if (active && timingSafeEqual(codeHash, active.codeHash)) throw new Error("Could not generate a unique pairing code");
      active = { codeHash, expiresAt: now() + ttlMs, createdBy: principal.userId, redeemedAt: undefined };
      return { code, expiresAt: new Date(active.expiresAt).toISOString() };
    },
    redeem(code) {
      if (!active || active.redeemedAt !== undefined || now() >= active.expiresAt) return { ok: false };
      const received = digest(code);
      if (received.length !== active.codeHash.length || !timingSafeEqual(received, active.codeHash)) return { ok: false };
      active.redeemedAt = now();
      return { ok: true, pairedBy: active.createdBy };
    },
    status() {
      if (!active) return { active: false };
      return { active: active.redeemedAt === undefined && now() < active.expiresAt, expiresAt: new Date(active.expiresAt).toISOString(), redeemed: active.redeemedAt !== undefined };
    },
  };
}
