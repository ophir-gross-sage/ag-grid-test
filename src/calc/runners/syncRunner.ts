import type { CalcRunnerFactory } from '../calcTypes';

/**
 * Baseline runner: does the work immediately, on the main thread, to
 * completion.
 *
 * The simplest thing that is correct, and deliberately the starting point
 * rather than a straw man. Most runs settle in a few milliseconds, and for
 * those this is genuinely the best option available — deferring, slicing or
 * shipping them to another thread would add scheduling latency to work that was
 * already finished.
 *
 * The problem is that it cannot tell those runs apart from the expensive ones.
 * Because scope is discovered rather than chosen, this runner commits the main
 * thread to whatever the calculation turns out to cost, with no way to bail. On
 * a cascade that is ~50ms: three dropped frames, nothing paints, and the
 * 'calculating' status cannot even reach the screen, since `onStart` and
 * `onOutcome` are dispatched inside the same task.
 *
 * Every option in `docs/calculation-options.md` exists to bound that tail
 * without penalising the common case.
 */
export const createSyncRunner: CalcRunnerFactory = (host) => ({
  id: 'sync',
  label: 'Synchronous (baseline)',

  submit(request) {
    host.onStart();

    const startedAt = performance.now();
    host.work.begin(request.seeds, request.seedCount);
    host.work.advance(Infinity);
    const result = host.work.outcome();
    const blockingMs = performance.now() - startedAt;

    host.onOutcome({
      cascaded: result.cascaded,
      latencyMs: performance.now() - request.requestedAt,
      blockingMs,
      // Nothing yields, so the whole run is one uninterrupted block.
      longestBlockMs: blockingMs,
      changedRows: result.changed,
      visitedRows: result.visited,
    });
  },

  /** Nothing to cancel: by the time anyone could ask, the work has finished. */
  cancel() {},
  dispose() {},
});
