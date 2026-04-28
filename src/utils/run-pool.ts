/**
 * Bounded-concurrency task pool — extracted from `cache/files-uploader.ts`
 * (v1.13.0) so the workspace scanner can share the same primitive for
 * parallel file hashing.
 *
 * Order of results matches order of items. Never throws — every failure is
 * captured as a rejected `PromiseSettledResult` in the returned array.
 *
 * Caller is responsible for post-pool error propagation (e.g. abort signals)
 * — the pool itself does not surface rejections beyond returning them in the
 * result array, by design (originally added to support uploader's per-file
 * retry-and-continue semantics; kept here for symmetry).
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        const item = items[i];
        if (item === undefined) continue;
        try {
          const value = await task(item, i);
          results[i] = { status: 'fulfilled', value };
        } catch (err) {
          results[i] = { status: 'rejected', reason: err };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
