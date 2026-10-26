// Retained records rotate through bounded batches, including reviewed records,
// so it can rebuild a lost cloud mirror while the pairing remains valid.
export function createScanReviewSync({ queue, send }) {
  let cursor = 0, running, singleRecord = false;
  const failed = new Set();
  async function synchronize(config) {
    const records = await queue.rejections();
    if (!records.length) { cursor = 0; return; }
    cursor %= records.length;
    const batch = [...records.slice(cursor), ...records.slice(0, cursor)].slice(0, singleRecord ? 1 : 50);
    // Rotate on failure too. After a validation/evidence conflict, use one
    // record per heartbeat for this service lifetime to isolate bad evidence
    // without a burst of retries or starvation of other retained records.
    cursor = (cursor + batch.length) % records.length;
    try {
      const result = await send(config, batch);
      const expected = new Set(batch.map(record => record.eventId));
      if (!Array.isArray(result?.reviews) || result.reviews.length !== expected.size
        || result.reviews.some(review => !expected.delete(review?.eventId) || !["open", "reviewed"].includes(review.reviewStatus))) {
        throw new Error("Invalid scan review acknowledgement");
      }
      // Validate the entire response before recording any acknowledgement. Local
      // review is monotonic; an open cloud record never reopens local history.
      for (const review of result.reviews) if (review.reviewStatus === "reviewed") await queue.markReviewed(review.eventId);
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
