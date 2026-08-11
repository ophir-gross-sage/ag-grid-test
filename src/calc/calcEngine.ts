import { ENTITY_COUNT } from '../types';
import type { AppStore } from '../store';
import { calcCompleted, calcScheduled, calcStarted } from '../store/calcSlice';
import { notifyRowsChanged } from '../store/gridSync';
import { calculate, calculateChunked, createCalcState, type CalcState } from './calcKernel';
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

  /** Opaque to the engine — it is threaded through to the kernel and never inspected. */
  const state: CalcState = createCalcState(ENTITY_COUNT);

  const dirtyRows = new Set<number>();
  /** Preallocated hand-off buffers, so scheduling never allocates. */
  const seedScratch = new Int32Array(ENTITY_COUNT);
  const changedScratch = new Int32Array(ENTITY_COUNT);

  let forceFull = false;
  let scheduled = 0;
  let requestedAt = 0;

  function results(): Float64Array {
    return store!.getState().results.values;
  }

  /** Hand changed rows to the grid. Bulk-collapses above a threshold; see `gridSync`. */
  function publish(changedCount: number): void {
    if (changedCount > 0) notifyRowsChanged('result', changedScratch, changedCount);
  }

  const work: CalcWork = {
    run(seeds, seedCount) {
      const outcome = calculate(
        results(),
        ENTITY_COUNT,
        seeds,
        seedCount,
        state,
        changedScratch,
      );
      publish(outcome.changed);
      return outcome;
    },

    *runChunked(seeds, seedCount, chunkRows) {
      const iterator = calculateChunked(
        results(),
        ENTITY_COUNT,
        seeds,
        seedCount,
        state,
        changedScratch,
        chunkRows,
      );
      let step = iterator.next();
      while (!step.done) {
        yield step.value;
        step = iterator.next();
      }
      publish(step.value.changed);
      return step.value;
    },
  };

  // --- Scheduling -----------------------------------------------------------

  function submit(): void {
    scheduled = 0;
    if (!store || !runner) return;

    let seedCount = 0;
    if (!forceFull) {
      for (const row of dirtyRows) seedScratch[seedCount++] = row;
      if (seedCount === 0) return;
    }
    dirtyRows.clear();
    forceFull = false;

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
     * Coalesce on a frame boundary. A burst of 1,000 edits must produce one run,
     * not 1,000 — and since any run may cost 50ms, collapsing a burst into a
     * single run is worth far more here than it was when runs were cheap.
     */
    scheduled = requestAnimationFrame(submit);
  }

  function buildRunner(factory: CalcRunnerFactory): CalcRunner {
    return factory({
      work,
      onStart: () => store?.dispatch(calcStarted()),
      onOutcome: (outcome) => store?.dispatch(calcCompleted(outcome)),
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
