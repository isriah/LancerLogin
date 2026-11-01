// The web kiosk's offline queue. Every confirmed scan is saved on the device first, then sent. Queued scans go to the
// server in the order they were taken, one at a time, always with the same event ID, so a retried scan is never
// recorded twice. Like the Pi kiosk (apps/kiosk/src/file-queue.mjs, scan-review-sync.mjs):
// - an answer that the scan was recorded, or was already recorded, removes it from the queue;
// - a refusal on its merits (such as no meeting accepting scans) removes it too, and keeps it in a short local list
//   of refused scans (the last 50), which is uploaded to `/kiosk/scan-reviews` for review on the dashboard;
// - no answer, or one that doesn't settle the scan, keeps it and everything after it queued, and waits before the
//   next try, doubling the wait each time up to 5 minutes.
// Kept free of React and the browser so it can be tested with a fake transport and an in-memory queue.
import type { AttendanceResult, ScanReviewAcknowledgement, ScanReviewRecord, SendOutcome } from "./kiosk-api.ts";
import type { QueuedScan, ScanQueue } from "./kiosk-store.ts";

/** A scan the server refused, kept on the device. `cloud` is the review status the server last acknowledged. */
export type RefusedScan = {
  eventId: string; memberId: string; occurredAt: string; pairingId: string;
  httpStatus: number | null; reasonCode: string; message: string; refusedAt: string; cloud?: "open" | "reviewed";
};

/** Where the refused scans are kept (the `rejected` value in the kiosk's state store). */
export interface RefusedScanStore { list(): Promise<RefusedScan[]>; save(scans: RefusedScan[]): Promise<void> }

/** What happened to a scan this session: settled one way or another, or still waiting. */
export type ScanFate =
  | { kind: "accepted"; result: AttendanceResult }
  | { kind: "rejected"; status: number; code?: string; message: string }
  | { kind: "rescan"; status: number; code: string; message: string };

/** Why a sync pass stopped before the queue was empty. */
export type SyncStop = "unreachable" | "retry" | "credential" | "backoff";
export type SyncReport = { delivered: number; pending: number; stopped?: SyncStop };

export const maxRefusedScans = 50;
export const syncBaseDelayMs = 5_000;
export const syncMaxDelayMs = 5 * 60_000;
const maxRememberedFates = 200;
const reasonCodePattern = /^[a-z][a-z0-9_]{0,39}$/;

/** The wait before the next try after `failures` failed tries in a row: 5 s, 10 s, 20 s, ... up to 5 minutes. */
export function syncBackoffMs(failures: number, baseMs = syncBaseDelayMs, maxMs = syncMaxDelayMs) {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
}

/** The evidence for a refused scan, as `/kiosk/scan-reviews` validates it. */
export function scanReviewRecordFor(scan: RefusedScan): ScanReviewRecord {
  return { eventId: scan.eventId, memberId: scan.memberId, occurredAt: scan.occurredAt, pairingId: scan.pairingId, reasonCode: scan.reasonCode, httpStatus: scan.httpStatus, reviewStatus: "open" };
}

function refusedScanFor(scan: QueuedScan, outcome: { status: number; code?: string; message: string }, at: string): RefusedScan {
  return {
    eventId: scan.eventId, memberId: scan.memberId, occurredAt: scan.occurredAt, pairingId: scan.pairingId,
    httpStatus: Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599 ? outcome.status : null,
    reasonCode: outcome.code && reasonCodePattern.test(outcome.code) ? outcome.code : "unclassified",
    message: outcome.message.slice(0, 300), refusedAt: at,
  };
}

export type ScanSyncOptions = {
  queue: ScanQueue;
  refused: RefusedScanStore;
  send: (scan: QueuedScan) => Promise<SendOutcome>;
  /** Uploads refused scans for review. Without it, refused scans are only kept on the device. */
  sendReviews?: (records: ScanReviewRecord[]) => Promise<ScanReviewAcknowledgement[]>;
  /** The server refused the kiosk's credential: the page asks to pair again. */
  onCredentialRejected?: () => void;
  /** Called after the queue or the refused list changed, so the page can update its counts. */
  onChange?: () => void;
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export function createScanSync({ queue, refused, send, sendReviews, onCredentialRejected, onChange, now = Date.now, baseDelayMs = syncBaseDelayMs, maxDelayMs = syncMaxDelayMs }: ScanSyncOptions) {
  let failures = 0, nextAttemptAt = 0, running: Promise<SyncReport> | undefined, again = false, reviewing: Promise<void> | undefined;
  let lastDeliveredAt: number | undefined;
  const fates = new Map<string, ScanFate>();
  const remember = (eventId: string, fate: ScanFate) => {
    fates.set(eventId, fate);
    if (fates.size > maxRememberedFates) fates.delete(fates.keys().next().value!);
  };
  const changed = () => { try { onChange?.(); } catch { /* the page's own problem */ } };

  async function keepRefused(scan: QueuedScan, outcome: { status: number; code?: string; message: string }) {
    const list = await refused.list();
    if (list.some((item) => item.eventId === scan.eventId)) return;
    await refused.save([...list, refusedScanFor(scan, outcome, new Date(now()).toISOString())].slice(-maxRefusedScans));
  }

  function failed() {
    failures += 1;
    nextAttemptAt = now() + syncBackoffMs(failures, baseDelayMs, maxDelayMs);
  }

  async function pass(): Promise<SyncReport> {
    let delivered = 0;
    for (;;) {
      const [next] = await queue.list();
      if (!next) {
        if (again) { again = false; continue; }
        return { delivered, pending: 0 };
      }
      const outcome = await send(next);
      if (outcome.kind === "unreachable" || outcome.kind === "retry") {
        failed(); again = false;
        return { delivered, pending: await queue.count(), stopped: outcome.kind };
      }
      if (outcome.kind === "credential") {
        again = false; onCredentialRejected?.();
        return { delivered, pending: await queue.count(), stopped: "credential" };
      }
      failures = 0; nextAttemptAt = 0;
      // Keep the refusal before removing the scan, so a crash in between sends it again rather than losing it; the
      // server answers the same, and the refused list keeps one record per event ID.
      if (outcome.kind === "rejected") await keepRefused(next, outcome);
      await queue.remove(next.eventId);
      remember(next.eventId, outcome);
      if (outcome.kind === "accepted") { delivered += 1; lastDeliveredAt = now(); }
      changed();
    }
  }

  const engine = {
    /** Saves a scan to the end of the queue. The scan is safe on the device once this resolves. */
    async enqueue(scan: QueuedScan) { await queue.add(scan); changed(); },
    /**
     * Sends the queued scans in order until the queue is empty or a try fails. Only one pass runs at a time; a call
     * during a pass makes that pass look at the queue again before it finishes. Unless `force` is set (a new scan, or
     * the network came back), a call during the wait after a failure does nothing.
     */
    sync({ force = false }: { force?: boolean } = {}): Promise<SyncReport> {
      if (running) { again = true; return running; }
      if (!force && now() < nextAttemptAt) return queue.count().then((pending) => ({ delivered: 0, pending, stopped: "backoff" as const }));
      running = pass().finally(() => { running = undefined; });
      return running;
    },
    /**
     * Records the answer to a scan sent straight away instead of through the queue (a PIN scan, whose PIN is never
     * saved): a refusal on its merits is kept for review like a queued one. Wrong PIN answers aren't scans to review,
     * so the page doesn't pass them here.
     */
    async settle(scan: QueuedScan, outcome: ScanFate) {
      if (outcome.kind === "rejected") await keepRefused(scan, outcome);
      remember(scan.eventId, outcome);
      if (outcome.kind === "accepted") lastDeliveredAt = now();
      changed();
    },
    /** The network came back: forget the wait and try at once. */
    online() { failures = 0; nextAttemptAt = 0; return engine.sync({ force: true }); },
    /** What happened to a scan this session, or undefined while it is still queued (or was never seen). */
    fate: (eventId: string) => fates.get(eventId),
    pending: () => queue.count(),
    refusedScans: () => refused.list(),
    /** When the next try after a failure is due (device time), or undefined when there's no wait. */
    retryAt: () => nextAttemptAt > now() ? nextAttemptAt : undefined,
    failures: () => failures,
    lastDeliveredAt: () => lastDeliveredAt,
    /**
     * Uploads refused scans the server hasn't acknowledged yet, up to 50 at a time, and records what it answered.
     * A failed upload is tried again on the next call. The answer must cover exactly the records sent.
     */
    uploadRefused(): Promise<void> {
      if (!sendReviews) return Promise.resolve();
      reviewing ??= (async () => {
        const list = await refused.list();
        const batch = list.filter((item) => !item.cloud).slice(0, maxRefusedScans);
        if (!batch.length) return;
        const reviews = await sendReviews(batch.map(scanReviewRecordFor));
        const expected = new Set(batch.map((item) => item.eventId));
        if (reviews.length !== expected.size || reviews.some((review) => !expected.delete(review?.eventId) || !["open", "reviewed"].includes(review.reviewStatus))) throw new Error("Invalid scan review acknowledgement");
        const status = new Map(reviews.map((review) => [review.eventId, review.reviewStatus]));
        const current = await refused.list();
        await refused.save(current.map((item) => status.has(item.eventId) ? { ...item, cloud: status.get(item.eventId) } : item));
        changed();
      })().finally(() => { reviewing = undefined; });
      return reviewing;
    },
  };
  return engine;
}
export type ScanSync = ReturnType<typeof createScanSync>;

/** A refused-scan store kept in memory, for tests. */
export function createMemoryRefusedStore(initial: RefusedScan[] = []): RefusedScanStore {
  let scans = structuredClone(initial);
  return { async list() { return structuredClone(scans); }, async save(next) { scans = structuredClone(next); } };
}
