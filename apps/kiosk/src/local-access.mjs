import { randomInt, timingSafeEqual } from "node:crypto";
import { hostname as systemHostname, networkInterfaces } from "node:os";

export function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// DNS rebinding defence: a hostile page whose domain resolves to this device
// still sends its own name in Host. Accept only names that address this kiosk:
// loopback, its hostname (plain or .local) and its current interface addresses,
// on the port the service is listening on.
export function createHostAllowlist({ port, hostname = systemHostname, interfaces = networkInterfaces } = {}) {
  function names() {
    const allowed = new Set(["127.0.0.1", "localhost", "[::1]"]);
    const name = String(hostname() || "").toLowerCase().replace(/\.$/, "");
    if (/^[a-z0-9](?:[a-z0-9.-]{0,252})$/.test(name)) {
      const label = name.split(".")[0];
      for (const value of [name, label, `${label}.local`]) allowed.add(value);
    }
    for (const entries of Object.values(interfaces() ?? {})) for (const entry of entries ?? []) {
      if (entry.family === "IPv4" || entry.family === 4) allowed.add(entry.address);
      else if (entry.family === "IPv6" || entry.family === 6) allowed.add(`[${String(entry.address).split("%")[0].toLowerCase()}]`);
    }
    return allowed;
  }
  return {
    allowed(header) {
      if (typeof header !== "string" || header.length > 300) return false;
      const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(header.trim());
      if (!match || Number(match[2]) !== Number(port())) return false;
      return names().has(match[1].toLowerCase().replace(/\.$/, ""));
    },
  };
}

// A short code shown only on the kiosk's own screen. A pairing request from
// another device on the LAN must include it, which proves someone can see the
// kiosk. Wrong guesses rotate the code and pause LAN pairing briefly.
export function createSetupCode({ now = () => Date.now(), attempts = 5, lockMs = 60_000, generate = () => String(randomInt(0, 1_000_000)).padStart(6, "0") } = {}) {
  let code = generate(), failures = 0, lockedUntil = 0;
  return {
    current: () => code,
    rotate() { code = generate(); failures = 0; },
    verify(value) {
      if (now() < lockedUntil) return { ok: false, locked: true };
      const supplied = Buffer.from(String(value ?? "").replace(/\s+/g, ""));
      const expected = Buffer.from(code);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { failures = 0; return { ok: true }; }
      failures += 1;
      if (failures >= attempts) { code = generate(); failures = 0; lockedUntil = now() + lockMs; return { ok: false, locked: true }; }
      return { ok: false, locked: false };
    },
  };
}
