// Retained records rotate through bounded batches, including reviewed records,
// so it can rebuild a lost cloud mirror while the pairing remains valid. A record
// the cloud has acknowledged is skipped until its local review changes or the
// periodic refresh, so a settled history costs no cloud reads on every heartbeat.
export function createScanReviewSync({ queue, send, refreshMs = 60 * 60_000, now = Date.now }) {
  let cursor = 0, running, singleRecord = false, refreshedAt = now();
  const failed = new Set(), acknowledged = new Map();
  const settled = record => acknowledged.get(record.eventId) === "reviewed" || acknowledged.get(record.eventId) === "open" && record.reviewStatus !== "reviewed";
  async function synchronize(config) {
    if (now() - refreshedAt >= refreshMs) { acknowledged.clear(); refreshedAt = now(); }
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
      for (const review of result.reviews) {
        if (review.reviewStatus === "reviewed") await queue.markReviewed(review.eventId);
        acknowledged.set(review.eventId, review.reviewStatus);
      }
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
  }, hasFailures: () => failed.size > 0 };
}
