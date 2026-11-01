// The web kiosk doesn't trust the device's clock. Each heartbeat reply carries the server's time (`receivedAt`); the
// kiosk compares it with the midpoint of its own send and answer times and keeps the difference as an offset, saved
// so it survives a restart without a network. Scans are stamped with the device time plus that offset. Until a first
// heartbeat has answered, the offset is 0.

/** The saved offset: server time minus device time, in milliseconds, and when (device time) it was measured. */
export type ClockOffset = { offsetMs: number; measuredAt: number; roundTripMs: number };

/** A round trip longer than this says too little about when the server stamped its time, so it is ignored. */
export const maxClockRoundTripMs = 30_000;

/**
 * The offset from one heartbeat: the server stamped `serverTime` somewhere between `sentAt` and `answeredAt` (device
 * times), so assume the middle. Undefined when the server time is missing or unreadable, or the round trip is too
 * long or goes backwards (the device clock was changed mid-request).
 */
export function clockOffsetFrom(sentAt: number, answeredAt: number, serverTime: string | undefined): ClockOffset | undefined {
  const server = typeof serverTime === "string" ? Date.parse(serverTime) : Number.NaN;
  const roundTripMs = answeredAt - sentAt;
  if (!Number.isFinite(server) || !Number.isFinite(sentAt) || !Number.isFinite(answeredAt) || roundTripMs < 0 || roundTripMs > maxClockRoundTripMs) return undefined;
  return { offsetMs: Math.round(server - (sentAt + answeredAt) / 2), measuredAt: answeredAt, roundTripMs };
}

/** A saved offset that can be used, or undefined. */
export function usableClockOffset(value: unknown): ClockOffset | undefined {
  const record = value as Partial<ClockOffset> | undefined;
  if (!record || typeof record !== "object" || !Number.isFinite(record.offsetMs) || !Number.isFinite(record.measuredAt)) return undefined;
  return { offsetMs: Number(record.offsetMs), measuredAt: Number(record.measuredAt), roundTripMs: Number.isFinite(record.roundTripMs) ? Number(record.roundTripMs) : 0 };
}

/** The kiosk's view of the server's time. `now` is the device clock, replaceable in tests. */
export function createKioskClock({ now = Date.now, initial }: { now?: () => number; initial?: ClockOffset } = {}) {
  let current = initial;
  return {
    /** The current server time estimate in milliseconds. */
    now: () => now() + (current?.offsetMs ?? 0),
    /** The time to stamp on a scan taken now. */
    occurredAt: () => new Date(now() + (current?.offsetMs ?? 0)).toISOString(),
    offset: () => current,
    /** Takes a heartbeat's measurement; returns the new offset when it was usable, to be saved. */
    update(sentAt: number, answeredAt: number, serverTime: string | undefined) {
      const next = clockOffsetFrom(sentAt, answeredAt, serverTime);
      if (next) current = next;
      return next;
    },
  };
}
export type KioskClock = ReturnType<typeof createKioskClock>;
