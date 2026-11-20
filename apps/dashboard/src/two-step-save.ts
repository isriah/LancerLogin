/** Remembers the first write of a two-write save that has already reached the server, by what it sent. */
export type FirstWrite = { current?: string };

/**
 * A save made of two writes, such as a roster member and then their attendance start date. When the second write
 * fails the form stays open; `done` remembers the first, so trying again sends only the second instead of repeating
 * the first. A first write with different content (`firstKey`, usually its JSON body) is sent again.
 * The error for a failed second write comes from `partial`, which says what was and wasn't saved.
 */
export async function saveInTwoSteps(done: FirstWrite, firstKey: string, first: () => Promise<unknown>, second: (() => Promise<unknown>) | undefined, partial: (message: string) => string) {
  if (done.current !== firstKey) { done.current = undefined; await first(); done.current = firstKey; }
  if (second) {
    try { await second(); }
    catch (error) { throw new Error(partial((error as Error).message)); }
  }
  done.current = undefined;
}
