const allowed = new Set(["installId", "releaseVersion", "activeKioskCount", "errorCategory", "metro"]);

export function createTelemetry({ accepted = false, send = async () => {} } = {}) {
  let consent = accepted;
  return {
    accept() { consent = true; },
    revoke() { consent = false; },
    async report(event) {
      if (!consent) return { sent: false, reason: "consent-required" };
      const payload = Object.fromEntries(Object.entries(event).filter(([key]) => allowed.has(key)));
      if (!payload.installId || !payload.releaseVersion) throw new Error("Missing telemetry identity");
      await send(payload); return { sent: true, payload };
    },
  };
}
