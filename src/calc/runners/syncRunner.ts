import { ENTITY_COUNT } from '../../types';
import type { CalcRunnerFactory } from '../calcTypes';

/**
 * Baseline runner: does the work immediately, on the main thread, to
 * completion.
 *
 * This is the simplest thing that is correct, and it is deliberately the
 * starting point rather than a straw man — for the incremental path it is also
 * the *best* option, because a pass costing microseconds gains nothing from
 * being deferred, sliced, or shipped to another thread, and would only pay
 * scheduling latency for the privilege.
 *
 * What it cannot do is the full pass. ~50ms on the main thread is three dropped
 * frames, during which nothing paints, scrolling stops, and no spinner can even
 * appear — `onStart` and `onOutcome` are dispatched inside the same task, so
 * the 'calculating' status never reaches the screen. That is the problem the
 * options in `docs/calculation-options.md` exist to solve.
 */
export const createSyncRunner: CalcRunnerFactory = (host) => ({
  id: 'sync',
  label: 'Synchronous (baseline)',

  submit(request) {
    host.onStart();

    const startedAt = performance.now();
    const changedRows =
      request.scope === 'full'
        ? host.work.runFull()
        : host.work.runIncremental(request.rows, request.rowCount);
    const blockingMs = performance.now() - startedAt;

    host.onOutcome({
      scope: request.scope,
      latencyMs: performance.now() - request.requestedAt,
      blockingMs,
      // Nothing yields, so the whole pass is one uninterrupted block.
      longestBlockMs: blockingMs,
      changedRows,
      visitedRows: request.scope === 'full' ? ENTITY_COUNT : request.rowCount,
      drift: request.drift,
    });
  },

  /** Nothing to cancel: by the time anyone could ask, the work has finished. */
  cancel() {},
  dispose() {},
});
