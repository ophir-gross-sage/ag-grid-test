import { ENTITY_COUNT } from '../types';
import type { AppStore } from '../store';
import { calcCompleted, calcScheduled, calcStarted } from '../store/calcSlice';
import { notifyRowsChanged } from '../store/gridSync';
import {
  advanceRun,
  beginRun,
  createCalcState,
  createRun,
  runResult,
  type CalcRun,
  type CalcState,
} from './calcKernel';
import type { CalcRequest, CalcRunner, CalcRunnerFactory, CalcWork } from './calcTypes';

/**
 * Orchestrates the calculation: collects what changed, runs it through a
 * `CalcRunner`, and publishes whatever came back.
 *
 * Decoupled from the UI in both directions. It never imports React, ag-grid, or
 * a component, and nothing in the UI calls it directly — it is driven by store
 * actions via `calcMiddleware` and reports back through `calcSlice` and
 * `gridSync`. The UI could be deleted and this would keep working.
 *
 * ---------------------------------------------------------------------------
 * What this engine deliberately does *not* do
 *
 * It does not decide scope, predict cost, or know which rows will be affected.
 * Earlier versions did — they maintained running column sums, measured
 * population drift, and chose "incremental" or "full" before dispatching. All
 * of that was deleted, because the real calculation cannot predict which rows
 * it will touch, and a scheduler built on a prediction the production
 * implementation cannot make is a scheduler that will not survive contact with
 * it.
 *
 * So the engine's job is only:
 *
 *   1. Accumulate the rows whose inputs changed (the seeds).
 *   2. Coalesce a burst of them into one run.
 *   3. Hand them to the runner.
 *   4. Publish the affected set the calculation *reports back*.
 *
 * Scope and cost arrive as results. Every run must be assumed capable of
 * costing 50ms, because none of them can be known to be cheap in advance.
 */

export interface CalcEngine {
  attach(store: AppStore, runnerFactory: CalcRunnerFactory): void;
  /** Report that a row's inputs changed. Cheap; safe to call on every action. */
  markRowDirty(row: number): void;
  /** Force a recalculation of the whole population. */
  requestFullRecalc(): void;
  /** Swap the execution strategy at runtime. */
  setRunner(factory: CalcRunnerFactory): void;
  runnerId(): string;
  dispose(): void;
}

export function createCalcEngine(): CalcEngine {
  let store: AppStore | null = null;
  let runner: CalcRunner | null = null;

  /** Opaque to the engine — threaded through to the kernel and never inspected. */
  const state: CalcState = createCalcState(ENTITY_COUNT);
  const run: CalcRun = createRun();

  const dirtyRows = new Set<number>();
  /** Preallocated hand-off buffers, so scheduling never allocates. */
  const seedScratch = new Int32Array(ENTITY_COUNT);
  const changedScratch = new Int32Array(ENTITY_COUNT);

  let forceFull = false;
  let scheduled = 0;
  let requestedAt = 0;
  /** True from submission until the runner reports an outcome. */
  let inFlight = false;

  function results(): Float64Array {
    return store!.getState().results.values;
  }

  /**
   * Hand the grid whatever changed since the last call.
   *
   * Called after every slice, not just at the end. A sliced run therefore
   * repaints progressively: rows finalised in the first slice are on screen
   * while later ones are still being computed. `gridSync` bulk-collapses above
   * a threshold, so publishing often costs no more than publishing once.
   */
  function publishNew(): void {
    const fresh = run.changedCount - run.publishedCount;
    if (fresh <= 0) return;
    notifyRowsChanged(
      'result',
      changedScratch.subarray(run.publishedCount, run.changedCount),
      fresh,
    );
    run.publishedCount = run.changedCount;
  }

  const work: CalcWork = {
    begin(seeds, seedCount) {
      beginRun(run, state, seeds, seedCount);
    },

    advance(deadlineMs) {
      const done = advanceRun(
        results(),
        ENTITY_COUNT,
        state,
        run,
        changedScratch,
        deadlineMs,
      );
      publishNew();
      return done;
    },

    outcome() {
      return runResult(run);
    },
  };

  // --- Scheduling -----------------------------------------------------------

  function submit(): void {
    scheduled = 0;
    if (!store || !runner) return;

    /**
     * Coalescing rule 2: never start a second run while one is in flight.
     *
     * Seeds keep accumulating in `dirtyRows` and go out in a single follow-up
     * when the current run finishes. Without this, a sliced run — which spans
     * many frames — would have a fresh run launched on top of it by every edit
     * arriving meanwhile, and they would fight over the same buffers.
     *
     * This is also where the cheapest possible optimisation lives: the fastest
     * calculation is the one that never runs. At a 50ms tail, *not* running is
     * worth more than any amount of making it faster.
     */
    if (inFlight) return;

    let seedCount = 0;
    if (!forceFull) {
      for (const row of dirtyRows) seedScratch[seedCount++] = row;
      if (seedCount === 0) return;
    }
    dirtyRows.clear();
    forceFull = false;
    inFlight = true;

    const request: CalcRequest = { seeds: seedScratch, seedCount, requestedAt };

    /**
     * Announced as 'stale' rather than 'scheduled' because that is the honest
     * description: computed values on screen no longer match their inputs, and
     * we cannot say how long that will remain true — the calculation might
     * settle in 1ms or cascade for 50ms, and there is no way to know which.
     */
    store.dispatch(calcScheduled({ stale: true }));
    runner.submit(request);
  }

  function schedule(): void {
    if (scheduled !== 0) return;
    requestedAt = performance.now();
    /**
     * Coalescing rule 1: collapse a burst on a frame boundary. A thousand edits
     * in one tick must produce one run, not a thousand.
     */
    scheduled = requestAnimationFrame(submit);
  }

  function buildRunner(factory: CalcRunnerFactory): CalcRunner {
    return factory({
      work,
      onStart: () => store?.dispatch(calcStarted()),
      onOutcome: (outcome) => {
        inFlight = false;
        store?.dispatch(calcCompleted(outcome));
        // Anything that arrived while we were busy goes out now, as one run.
        if (dirtyRows.size > 0 || forceFull) schedule();
      },
    });
  }

  return {
    attach(nextStore, runnerFactory) {
      store = nextStore;
      runner = buildRunner(runnerFactory);
      // Nothing has been computed yet, so the first run covers everything.
      forceFull = true;
      schedule();
    },

    markRowDirty(row) {
      dirtyRows.add(row);
      schedule();
    },

    requestFullRecalc() {
      forceFull = true;
      schedule();
    },

    setRunner(factory) {
      runner?.dispose();
      runner = buildRunner(factory);
      forceFull = true;
      schedule();
    },

    runnerId() {
      return runner?.id ?? 'none';
    },

    dispose() {
      if (scheduled !== 0) cancelAnimationFrame(scheduled);
      scheduled = 0;
      runner?.dispose();
      runner = null;
      store = null;
    },
  };
}

/** The app's engine. A singleton because there is one store and one dataset. */
export const calcEngine = createCalcEngine();
