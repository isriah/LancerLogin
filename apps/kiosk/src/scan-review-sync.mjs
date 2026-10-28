// Incremental review sync. Retained records rotate through bounded batches.
// The cloud acknowledgement of each record is persisted by the queue (when it
// supports recordCloudReviews), so a restart does not resend settled history:
// - a record the cloud reports as reviewed is final and never resent;
// - a record the cloud holds as open is polled again only after refreshMs, so
//   a dashboard review still reaches the kiosk;
// - a local review the cloud has not seen yet is sent on the next heartbeat.
export function createScanReviewSync({ queue, send, refreshMs = 60 * 60_000, now = Date.now }) {
  let cursor = 0, running, singleRecord = false, loaded = false;
  const startedAt = now();
  const failed = new Set(), acknowledged = new Map(), acknowledgedAt = new Map();
  const persistent = typeof queue.recordCloudReviews === "function" && typeof queue.cloudReviews === "function";
  function settled(record) {
    const cloud = acknowledged.get(record.eventId);
    if (cloud === "reviewed") return true;
    if (cloud !== "open" || record.reviewStatus === "reviewed") return false;
    return now() - (acknowledgedAt.get(record.eventId) ?? startedAt) < refreshMs;
  }
  async function synchronize(config) {
    if (persistent && !loaded) { for (const [eventId, status] of await queue.cloudReviews()) acknowledged.set(eventId, status); loaded = true; }
    const records = await queue.rejections();
    if (!records.length) { cursor = 0; return; }
    cursor %= records.length;
    const rotated = [...records.slice(cursor), ...records.slice(0, cursor)], batch = [];
    let last = -1;
    for (let index = 0; index < rotated.length && batch.length < (singleRecord ? 1 : 50); index++) if (!settled(rotated[index])) { batch.push(rotated[index]); last = index; }
    if (!batch.length) return;
    // Rotate on failure too. After a validation/evidence conflict, use one
    // record per heartbeat for this service lifetime to isolate bad evidence
    // without a burst of retries or starvation of other retained records.
    cursor = (cursor + last + 1) % records.length;
    try {
      const result = await send(config, batch);
      const expected = new Set(batch.map(record => record.eventId));
      if (!Array.isArray(result?.reviews) || result.reviews.length !== expected.size
        || result.reviews.some(review => !expected.delete(review?.eventId) || !["open", "reviewed"].includes(review.reviewStatus))) {
        throw new Error("Invalid scan review acknowledgement");
      }
      // Validate the entire response before recording any acknowledgement. Local
      // review is monotonic; an open cloud record never reopens local history.
      if (persistent) await queue.recordCloudReviews(result.reviews.map(({ eventId, reviewStatus }) => ({ eventId, reviewStatus })));
      else for (const review of result.reviews) if (review.reviewStatus === "reviewed") await queue.markReviewed(review.eventId);
      const at = now();
      for (const review of result.reviews) { acknowledged.set(review.eventId, review.reviewStatus); acknowledgedAt.set(review.eventId, at); }
      for (const record of batch) failed.delete(record.eventId);
    } catch (error) {
      if ([400, 409].includes(error?.status)) singleRecord = true;
      for (const record of batch) failed.add(record.eventId);
      throw error;
    }
  }
  return { tick(config) {
    if (!running) running = synchronize(config).finally(() => { running = undefined; });
    return running;
  },
  // The heartbeat reports fewer open reviews in the cloud than this kiosk holds:
  // a dashboard review happened, so poll cloud-open records on the next tick.
  refreshOpen() { for (const [eventId, status] of acknowledged) if (status === "open") acknowledgedAt.set(eventId, -Infinity); },
  hasFailures: () => failed.size > 0 };
}
