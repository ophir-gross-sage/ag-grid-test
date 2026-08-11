import {
  COL_COMPOSITE,
  ENTITY_COUNT,
  INPUT_RESULT_COLUMNS,
  RESULT_SIZE,
} from '../types';
import type { AppStore } from '../store';
import { calcCompleted, calcScheduled, calcStarted } from '../store/calcSlice';
import { notifyRowsChanged } from '../store/gridSync';
import {
  baselineDrift,
  computeBaselines,
  computeColumnSums,
  computeComposite,
  computeCompositeDistribution,
  computeDispersion,
  createBaselines,
  percentileOf,
  writeRow,
  type Baselines,
} from './calcKernel';
import type {
  CalcRequest,
  CalcRunner,
  CalcRunnerFactory,
  CalcWork,
  ChunkProgress,
} from './calcTypes';

/**
 * Orchestrates the calculation: decides what needs recomputing, runs it through
 * a `CalcRunner`, and publishes the results.
 *
 * Decoupled from the UI in both directions. It never imports React, ag-grid, or
 * a component, and nothing in the UI calls it directly — it is driven by store
 * actions via `calcMiddleware` and reports back through `calcSlice` and
 * `gridSync`. The UI could be deleted and this would keep working; that is what
 * makes it testable headlessly and what allows the runner to be swapped for a
 * worker without touching a component.
 *
 * ---------------------------------------------------------------------------
 * Deciding scope
 *
 * The engine maintains running sums of the input columns, updated by the deltas
 * `calcMiddleware` hands it. Before each pass it asks the kernel how far those
 * sums have drifted from the baselines currently in use:
 *
 *   drift <= FULL_RECALC_DRIFT_THRESHOLD  ->  incremental, dirty rows only
 *   drift >  FULL_RECALC_DRIFT_THRESHOLD  ->  full pass, all 50,000 rows
 *
 * The test is O(9) regardless of how much data changed, so deciding is never
 * itself a cost. A single small edit takes the cheap path; a bulk mutation
 * moves the population and takes the expensive one.
 */

/**
 * Mean shift, in standard deviations, past which cached baselines are no longer
 * considered a fair description of the population.
 *
 * Low enough that bulk changes reliably trigger a full pass, high enough that
 * ordinary single-cell editing does not. This is the knob that trades
 * correctness of the normalisation against how often the 50ms pass runs — in a
 * real system it belongs to the domain, not to the scheduler.
 */
export const FULL_RECALC_DRIFT_THRESHOLD = 0.02;

/**
 * Fraction of the population that can be recomputed incrementally before the
 * cached R10 distribution is no longer trustworthy.
 *
 * The second invalidation rule, and it catches what drift alone misses.
 * Replacing 1,000 rows of uniform-random values with different uniform-random
 * values barely moves any column mean — drift stays near zero and the baselines
 * really are still valid. But R12 is a *percentile*, so it depends on the shape
 * of the whole R10 distribution, and 1,000 rows landing in new places reshuffles
 * ranks for rows that were never touched.
 *
 * Without this rule the percentile column silently rots: every individual
 * incremental pass is locally correct, and the population-level answer drifts
 * further from the truth with each one.
 */
export const FULL_RECALC_CHURN_FRACTION = 0.005;

export interface CalcEngine {
  attach(store: AppStore, runnerFactory: CalcRunnerFactory): void;
  /** Report an input change. Cheap; safe to call from a middleware on every action. */
  markRowDirty(row: number, columnDeltaSum: Float64Array | null): void;
  /** Force a full pass regardless of drift. */
  requestFullRecalc(): void;
  /** Swap the execution strategy at runtime. */
  setRunner(factory: CalcRunnerFactory): void;
  runnerId(): string;
  dispose(): void;
}

export function createCalcEngine(): CalcEngine {
  let store: AppStore | null = null;
  let runner: CalcRunner | null = null;

  const baselines: Baselines = createBaselines();
  /** Running sums of input columns, maintained incrementally from edit deltas. */
  const columnSum = new Float64Array(INPUT_RESULT_COLUMNS);
  let columnSumValid = false;

  /** Rows with changed inputs awaiting recomputation. */
  const dirtyRows = new Set<number>();
  /** Preallocated hand-off buffers, so scheduling never allocates. */
  const dirtyScratch = new Int32Array(ENTITY_COUNT);
  const changedScratch = new Int32Array(ENTITY_COUNT);
  /** R10 for every row, needed as an intermediate before percentiles can be assigned. */
  const compositeScratch = new Float64Array(ENTITY_COUNT);

  let forceFull = false;
  let scheduled = 0;
  let requestedAt = 0;
  /** Rows recomputed incrementally since the last full pass. Drives the churn rule. */
  let churnSinceFull = 0;

  function results(): Float64Array {
    return store!.getState().results.values;
  }

  // --- Applying a pass ------------------------------------------------------

  /**
   * Recompute the given rows against the cached baselines.
   *
   * Note what this does *not* do: it does not rebuild the R10 distribution, so
   * R12 is computed against the distribution as it was. That is the deliberate
   * approximation an incremental pass buys — one row's move cannot meaningfully
   * shift a 50,000-row percentile curve, and the drift test catches the point
   * where enough of them accumulate that it can.
   */
  function runIncremental(rows: Int32Array, rowCount: number): number {
    const values = results();
    let changedCount = 0;

    for (let i = 0; i < rowCount; i++) {
      const row = rows[i];
      const composite = computeComposite(values, row, baselines);
      const dispersion = computeDispersion(values, row);
      const percentile = percentileOf(composite, baselines);
      if (writeRow(values, row, composite, dispersion, percentile)) {
        changedScratch[changedCount++] = row;
      }
    }

    publishChanges(changedCount);
    return changedCount;
  }

  /** The ~50ms pass: baselines, then every row, then the distribution, then every row again. */
  function runFull(): number {
    const values = results();

    computeBaselines(values, ENTITY_COUNT, baselines);
    computeColumnSums(values, ENTITY_COUNT, columnSum);
    columnSumValid = true;

    for (let row = 0; row < ENTITY_COUNT; row++) {
      compositeScratch[row] = computeComposite(values, row, baselines);
    }
    computeCompositeDistribution(compositeScratch, ENTITY_COUNT, baselines);

    let changedCount = 0;
    for (let row = 0; row < ENTITY_COUNT; row++) {
      const composite = compositeScratch[row];
      const dispersion = computeDispersion(values, row);
      const percentile = percentileOf(composite, baselines);
      if (writeRow(values, row, composite, dispersion, percentile)) {
        changedScratch[changedCount++] = row;
      }
    }

    publishChanges(changedCount);
    return changedCount;
  }

  /**
   * The same full pass, yielding between chunks.
   *
   * Kept in step with `runFull` by construction — same phases, same order — so
   * a runner that yields produces bit-identical output to one that doesn't.
   * Unused by the synchronous runner, but present so that choosing a
   * time-slicing route later is a change of runner and nothing else.
   */
  function* runFullChunked(): Generator<ChunkProgress, number> {
    const CHUNK = 4000;
    const values = results();

    computeBaselines(values, ENTITY_COUNT, baselines);
    computeColumnSums(values, ENTITY_COUNT, columnSum);
    columnSumValid = true;
    yield { done: 0, total: ENTITY_COUNT * 2 };

    for (let start = 0; start < ENTITY_COUNT; start += CHUNK) {
      const end = Math.min(start + CHUNK, ENTITY_COUNT);
      for (let row = start; row < end; row++) {
        compositeScratch[row] = computeComposite(values, row, baselines);
      }
      yield { done: end, total: ENTITY_COUNT * 2 };
    }

    computeCompositeDistribution(compositeScratch, ENTITY_COUNT, baselines);

    let changedCount = 0;
    for (let start = 0; start < ENTITY_COUNT; start += CHUNK) {
      const end = Math.min(start + CHUNK, ENTITY_COUNT);
      for (let row = start; row < end; row++) {
        const composite = compositeScratch[row];
        const dispersion = computeDispersion(values, row);
        const percentile = percentileOf(composite, baselines);
        if (writeRow(values, row, composite, dispersion, percentile)) {
          changedScratch[changedCount++] = row;
        }
      }
      // Publish as we go: partial results are visible immediately rather than
      // withheld until the whole pass lands.
      publishChanges(changedCount);
      changedCount = 0;
      yield { done: ENTITY_COUNT + end, total: ENTITY_COUNT * 2 };
    }

    return changedCount;
  }

  /** Hand changed rows to the grid. Bulk-collapses above a threshold; see `gridSync`. */
  function publishChanges(changedCount: number): void {
    if (changedCount > 0) {
      notifyRowsChanged('result', changedScratch, changedCount);
    }
  }

  const work: CalcWork = { runIncremental, runFull, runFullChunked };

  // --- Scheduling -----------------------------------------------------------

  function decideAndSubmit(): void {
    scheduled = 0;
    if (!store || !runner) return;

    const needsFull = forceFull || !baselines.valid || !columnSumValid;
    const drift = baselines.valid && columnSumValid
      ? baselineDrift(columnSum, ENTITY_COUNT, baselines)
      : Infinity;

    const churn = churnSinceFull + dirtyRows.size;
    const full =
      needsFull ||
      drift > FULL_RECALC_DRIFT_THRESHOLD ||
      churn > ENTITY_COUNT * FULL_RECALC_CHURN_FRACTION;

    if (!full && dirtyRows.size === 0) return;

    let rowCount = 0;
    if (full) {
      churnSinceFull = 0;
    } else {
      for (const row of dirtyRows) dirtyScratch[rowCount++] = row;
      churnSinceFull = churn;
    }
    dirtyRows.clear();
    forceFull = false;

    const request: CalcRequest = {
      scope: full ? 'full' : 'incremental',
      rows: dirtyScratch,
      rowCount,
      requestedAt,
      drift: Number.isFinite(drift) ? drift : 0,
    };

    store.dispatch(calcScheduled({ scope: request.scope, stale: full }));
    runner.submit(request);
  }

  function schedule(): void {
    if (scheduled !== 0) return;
    requestedAt = performance.now();
    /**
     * Coalesce on a frame boundary. A burst of 1,000 edits must produce one
     * decision, not 1,000 — and deferring to the frame means the raw edit
     * paints before the calculation starts competing for the thread.
     */
    scheduled = requestAnimationFrame(decideAndSubmit);
  }

  // --- Public surface -------------------------------------------------------

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
      // Nothing has been computed yet, so the first pass is unconditionally full.
      forceFull = true;
      schedule();
    },

    markRowDirty(row, columnDeltaSum) {
      if (columnDeltaSum && columnSumValid) {
        for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
          columnSum[col] += columnDeltaSum[col];
        }
      }
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

/** Column offset of the first computed slot, re-exported for the middleware's delta maths. */
export { COL_COMPOSITE, INPUT_RESULT_COLUMNS, RESULT_SIZE };
