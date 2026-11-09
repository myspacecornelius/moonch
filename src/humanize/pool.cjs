'use strict';
/* A field of workers: runPool(items, size, work, { signal }) runs work(item, index) with at most `size` calls at a time and resolves with
   the results IN INPUT ORDER, whatever order the calls finish in, so the orchestrator's output never depends on timing. size 1 runs every
   call one after the other. The first failure stops the field: no worker takes another item, the calls already started are awaited, and
   the pool rejects with that failure. An aborted signal is a failure too. */

class AbortedError extends Error {
  constructor(message = 'The run was stopped.') {
    super(message);
    this.name = 'AbortedError';
    this.code = 'cancelled';
  }
}

async function runPool(items, size, work, { signal } = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number.isInteger(size) ? size : 1, list.length || 1));
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < list.length) {
      if (signal && signal.aborted) { failure = failure || new AbortedError(); break; }
      const index = next;
      next += 1;
      try {
        results[index] = await work(list[index], index);
      } catch (error) {
        failure = failure || error;
      }
    }
  };
  await Promise.all(Array.from({ length: list.length ? width : 0 }, worker));
  if (failure) throw failure;
  return results;
}

module.exports = { runPool, AbortedError };
