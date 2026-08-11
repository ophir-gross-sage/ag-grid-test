import {
  COL_COMPOSITE,
  COL_DISPERSION,
  COL_PERCENTILE,
  INPUT_RESULT_COLUMNS,
  RESULT_SIZE,
} from '../types';

/**
 * The calculation itself. Pure arithmetic over typed arrays.
 *
 * Nothing in this file may import the store, React, the DOM, or ag-grid. That
 * restriction is the whole point: a kernel that only touches `ArrayBuffer`s can
 * be moved onto a worker, split across time slices, or run twice for
 * verification without being rewritten. Every scheduling option in
 * `docs/calculation-options.md` is a change of *caller*, not of this code.
 *
 * ---------------------------------------------------------------------------
 * What it computes
 *
 * It reads the 9 input slots of each result and writes the 3 computed ones:
 *
 *   R10 composite   = normalised blend of R1-R9, z-scored against per-column
 *                     population baselines
 *   R11 dispersion  = spread of R1-R9 around their own mean (row-local)
 *   R12 percentile  = where this row's R10 falls among all 50,000 R10 values
 *
 * ---------------------------------------------------------------------------
 * Why one edit can imply 50ms of work
 *
 * The dependency structure, and the reason this shape was chosen:
 *
 *   R11(row)  <- inputs(row)                        row-local, always cheap
 *   R10(row)  <- inputs(row) + column baselines     baselines span all rows
 *   R12(row)  <- R10(row)    + R10 distribution     spans all rows
 *
 * So an edit has two possible consequences:
 *
 *   - The baselines still describe the population. Only the edited row's R10,
 *     R11 and R12 can have moved. Recompute one row: ~100 operations. This is
 *     the "few additional changes" case.
 *
 *   - The edit shifted a column's mean far enough that the baselines are no
 *     longer valid. Now every row's R10 is stale, and because R10 moved, the
 *     percentile distribution behind R12 has to be rebuilt too — which changes
 *     R12 for rows nowhere near the edit. That is the complete recalculation,
 *     and it costs ~50ms.
 *
 * "Local input, global normalisation" is deliberately the model here because it
 * is the common one: anything ranked, percentile-scored, z-scored or normalised
 * against its peers has exactly this fan-out.
 */

/**
 * Arithmetic passes per element in the composite loop.
 *
 * Calibrated so a full recalculation over 50,000 rows lands near the 50ms
 * figure we're designing against. It is real, data-dependent work rather than a
 * busy-wait, because a `while (Date.now() - t < 50)` spin would behave
 * differently under time-slicing and would vanish when moved to a worker — it
 * would measure the wrong thing in exactly the cases we care about.
 */
export const KERNEL_PASSES = 24;

/**
 * Population statistics the per-row pass reads. Recomputing these is what makes
 * a full pass necessary; reusing them is what makes an incremental pass
 * possible.
 */
export interface Baselines {
  /** Mean of each *input* column across all rows. */
  mean: Float64Array;
  /** Reciprocal of each input column's standard deviation, pre-divided. */
  invStd: Float64Array;
  /** Cumulative histogram of R10 over the population, for percentile lookup. */
  compositeCdf: Float64Array;
  /** Lowest R10 seen in the population. */
  compositeMin: number;
  /** Histogram bucket width for R10. */
  compositeScale: number;
  /** False until `computeBaselines` has run at least once. */
  valid: boolean;
}

const HISTOGRAM_BUCKETS = 2048;

export function createBaselines(): Baselines {
  return {
    mean: new Float64Array(INPUT_RESULT_COLUMNS),
    invStd: new Float64Array(INPUT_RESULT_COLUMNS).fill(1),
    compositeCdf: new Float64Array(HISTOGRAM_BUCKETS),
    compositeMin: 0,
    compositeScale: 1,
    valid: false,
  };
}

/**
 * Pass 1 of a full recalculation: mean and standard deviation of each input
 * column over every row.
 */
export function computeBaselines(
  results: Float64Array,
  rowCount: number,
  out: Baselines,
): void {
  const sum = new Float64Array(INPUT_RESULT_COLUMNS);
  const sumSq = new Float64Array(INPUT_RESULT_COLUMNS);

  for (let row = 0; row < rowCount; row++) {
    const base = row * RESULT_SIZE;
    for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
      const v = results[base + col];
      sum[col] += v;
      sumSq[col] += v * v;
    }
  }

  for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
    const mean = sum[col] / rowCount;
    const variance = Math.max(sumSq[col] / rowCount - mean * mean, 1e-9);
    out.mean[col] = mean;
    out.invStd[col] = 1 / Math.sqrt(variance);
  }
  out.valid = true;
}

/**
 * R10 for a single row. The inner loop of the full pass and the whole of the
 * incremental path, so it allocates nothing and costs the same whether called
 * once or 50,000 times.
 */
export function computeComposite(
  results: Float64Array,
  row: number,
  b: Baselines,
): number {
  const base = row * RESULT_SIZE;
  const { mean, invStd } = b;
  let acc = 0;

  for (let pass = 0; pass < KERNEL_PASSES; pass++) {
    for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
      const z = (results[base + col] - mean[col]) * invStd[col];
      // Soft-clipped z-score: keeps outliers from dominating, and keeps the
      // arithmetic data-dependent so it cannot be hoisted out of the loop.
      const shaped = Math.sqrt(Math.abs(z) + 1) - 1;
      acc += z >= 0 ? shaped : -shaped;
      acc += acc * 1e-12;
    }
  }

  return (acc / KERNEL_PASSES) * 10;
}

/** R11 for a single row. Row-local, so it never needs a full pass of its own. */
export function computeDispersion(results: Float64Array, row: number): number {
  const base = row * RESULT_SIZE;
  let sum = 0;
  for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) sum += results[base + col];
  const mean = sum / INPUT_RESULT_COLUMNS;

  let sumSq = 0;
  for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
    const d = results[base + col] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / INPUT_RESULT_COLUMNS);
}

/**
 * Pass 3: the R10 distribution, as a cumulative histogram.
 *
 * A histogram rather than a sort of 50,000 composites — O(n) and allocation-free
 * per call against O(n log n) plus a 400KB copy. Resolution is one part in 2048,
 * well below what a percentile rounded for display can express.
 */
export function computeCompositeDistribution(
  composite: Float64Array,
  rowCount: number,
  out: Baselines,
): void {
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < rowCount; row++) {
    const c = composite[row];
    if (c < min) min = c;
    if (c > max) max = c;
  }

  const span = max - min;
  const scale = span > 0 ? (HISTOGRAM_BUCKETS - 1) / span : 0;
  out.compositeMin = min;
  out.compositeScale = scale;

  const cdf = out.compositeCdf;
  cdf.fill(0);
  for (let row = 0; row < rowCount; row++) {
    cdf[((composite[row] - min) * scale) | 0]++;
  }

  let running = 0;
  const inv = 100 / rowCount;
  for (let bucket = 0; bucket < HISTOGRAM_BUCKETS; bucket++) {
    running += cdf[bucket];
    cdf[bucket] = running * inv;
  }
}

/** R12: percentile of a composite against the population distribution. */
export function percentileOf(composite: number, b: Baselines): number {
  if (b.compositeScale === 0) return 50;
  let bucket = ((composite - b.compositeMin) * b.compositeScale) | 0;
  if (bucket < 0) bucket = 0;
  else if (bucket >= HISTOGRAM_BUCKETS) bucket = HISTOGRAM_BUCKETS - 1;
  return b.compositeCdf[bucket];
}

/**
 * How far the population has drifted from the baselines currently in use, as
 * the largest per-column mean shift measured in standard deviations.
 *
 * This is the invalidation test, and it answers "are the cached baselines still
 * a fair description of the data?" without reading a single row — the caller
 * maintains the column sums incrementally, so this is O(9) no matter how much
 * data changed.
 */
export function baselineDrift(
  columnSum: Float64Array,
  rowCount: number,
  b: Baselines,
): number {
  let worst = 0;
  for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
    const drift = Math.abs(columnSum[col] / rowCount - b.mean[col]) * b.invStd[col];
    if (drift > worst) worst = drift;
  }
  return worst;
}

/** Input-column sums over every row. Seeds the incrementally-maintained running sums. */
export function computeColumnSums(
  results: Float64Array,
  rowCount: number,
  out: Float64Array,
): void {
  out.fill(0);
  for (let row = 0; row < rowCount; row++) {
    const base = row * RESULT_SIZE;
    for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) out[col] += results[base + col];
  }
}

// --- Row writes -------------------------------------------------------------

/** Values differing by less than this are treated as unchanged. */
const EPSILON = 1e-9;

/**
 * Writes R10/R11/R12 for one row and reports whether anything actually moved.
 *
 * The "did it change" answer is what keeps the UI quiet: a full recalculation
 * touches all 50,000 rows, but typically only a fraction end up with different
 * values, and only those are worth telling the grid about.
 */
export function writeRow(
  results: Float64Array,
  row: number,
  composite: number,
  dispersion: number,
  percentile: number,
): boolean {
  const base = row * RESULT_SIZE;
  const changed =
    Math.abs(results[base + COL_COMPOSITE] - composite) > EPSILON ||
    Math.abs(results[base + COL_DISPERSION] - dispersion) > EPSILON ||
    Math.abs(results[base + COL_PERCENTILE] - percentile) > EPSILON;

  results[base + COL_COMPOSITE] = composite;
  results[base + COL_DISPERSION] = dispersion;
  results[base + COL_PERCENTILE] = percentile;
  return changed;
}

// ---------------------------------------------------------------------------
// The black box
// ---------------------------------------------------------------------------

/**
 * Everything past this point models the property that matters most about the
 * real calculation: **the caller cannot predict what it will do.**
 *
 * Not which rows it will touch, and not how long it will take. The caller hands
 * it the rows whose inputs changed and gets back a set of rows whose outputs
 * changed — and the two have no reliable relationship. A one-cell edit may
 * settle in 1ms touching a few hundred rows, or cascade across the entire
 * population and cost 50ms+.
 *
 * That unpredictability is a hard constraint on scheduling, not a detail:
 *
 *   - You cannot route cheap runs inline and expensive runs elsewhere, because
 *     you do not know which one you have until it has already run.
 *   - You cannot compute the visible rows first, because you do not know
 *     whether the visible rows are even in the affected set.
 *   - Every single run has to be treated as though it might be the 50ms one.
 *
 * The propagation rules below are therefore deliberately sealed inside this
 * boundary. The engine could technically import them; it must not, because the
 * real calculation will not offer them.
 */

/**
 * Rows a single changed row drags in with it, as a range.
 *
 * Sized so a lone edit lands in the 1-5ms band at roughly 0.8µs/row, and varied
 * per row so cost is not a constant — two edits that look identical from the
 * outside legitimately cost different amounts, which is the property being
 * modelled.
 */
const CONE_MIN = 800;
const CONE_SPREAD = 4200;

/**
 * Once this share of the population is implicated, propagating further is
 * pointless — recompute everything and rebuild the global baselines while we're
 * here. This is the main path from a small edit to a 50ms pass.
 */
const CASCADE_FRACTION = 0.25;

/**
 * Rows recomputable locally before the cached R10 distribution is rebuilt.
 *
 * Each local run is correct for the rows it touches while leaving the
 * population-level percentile progressively less true, so this bounds how far
 * that can rot. It must sit comfortably above the cone size, or every run
 * cascades and the cheap path never happens.
 */
const CHURN_LIMIT_FRACTION = 0.2;


/**
 * How many rows are processed between deadline checks.
 *
 * `performance.now()` is not free, so checking it per row would show up in a
 * kernel this hot. 256 rows is ~0.2ms of work on a fast machine and ~1.2ms on a
 * slow one — fine-grained enough to honour a 4ms budget, coarse enough to be
 * invisible.
 */
const DEADLINE_CHECK_INTERVAL = 256;

/** Phases of a run, in order. A run always ends at DONE. */
const PHASE_PROPAGATE = 0;
const PHASE_LOCAL = 1;
const PHASE_BASELINE = 2;
const PHASE_COMPOSITE = 3;
const PHASE_RANGE = 4;
const PHASE_HISTOGRAM = 5;
const PHASE_FINALISE = 6;
const PHASE_DONE = 7;

export interface CalcState {
  baselines: Baselines;
  /** Rows recomputed without a cascade since the last full pass. */
  churn: number;
  /** Marks which rows are in the current affected set; stamped by generation to avoid clearing. */
  mark: Int32Array;
  generation: number;
  /** The affected set, materialised. */
  affected: Int32Array;
  /** Scratch for R10 across the population, needed before percentiles can be assigned. */
  composite: Float64Array;
}

export function createCalcState(rowCount: number): CalcState {
  return {
    baselines: createBaselines(),
    churn: 0,
    mark: new Int32Array(rowCount),
    generation: 0,
    affected: new Int32Array(rowCount),
    composite: new Float64Array(rowCount),
  };
}

/**
 * A run in progress.
 *
 * All the mutable position of a calculation, lifted out of the call stack so it
 * can be put down and picked up again. This is what makes the kernel resumable
 * *without* restructuring it: the inner loops below are byte-identical to what
 * they would be in a straight-line implementation, and only the outer bounds
 * and a phase counter differ.
 *
 * Generators were the obvious alternative and were rejected. `yield` inside a
 * hot numeric loop costs real throughput, and this kernel runs on the server
 * too, where nothing yields and every cycle counts.
 */
export interface CalcRun {
  phase: number;
  /** Position within the current phase. */
  cursor: number;
  seeds: Int32Array;
  seedCount: number;
  affectedCount: number;
  cascaded: boolean;
  visited: number;
  /** Rows written into `changedOut` so far. Grows across slices. */
  changedCount: number;
  /** How many of those the caller has already been handed. */
  publishedCount: number;

  // Accumulators that must survive a yield.
  sum: Float64Array;
  sumSq: Float64Array;
  min: number;
  max: number;
}

export function createRun(): CalcRun {
  return {
    phase: PHASE_DONE,
    cursor: 0,
    seeds: new Int32Array(0),
    seedCount: 0,
    affectedCount: 0,
    cascaded: false,
    visited: 0,
    changedCount: 0,
    publishedCount: 0,
    sum: new Float64Array(INPUT_RESULT_COLUMNS),
    sumSq: new Float64Array(INPUT_RESULT_COLUMNS),
    min: Infinity,
    max: -Infinity,
  };
}

export interface CalcResult {
  /** Rows the calculation actually visited. Discovered, never predicted. */
  visited: number;
  /** Rows whose computed outputs actually moved. */
  changed: number;
  /** Whether it ended up recomputing the whole population. */
  cascaded: boolean;
}

/** Arms a run. Does no work — the first `advanceRun` does. */
export function beginRun(
  run: CalcRun,
  state: CalcState,
  seeds: Int32Array,
  seedCount: number,
): void {
  run.cursor = 0;
  run.seeds = seeds;
  run.seedCount = seedCount;
  run.affectedCount = 0;
  run.visited = 0;
  run.changedCount = 0;
  run.publishedCount = 0;
  run.min = Infinity;
  run.max = -Infinity;
  run.sum.fill(0);
  run.sumSq.fill(0);

  // Fresh stamp for the affected-set marks, so nothing has to be cleared.
  state.generation++;

  // No baselines yet, or the caller asked for everything: skip propagation.
  const mustCascade = !state.baselines.valid || seedCount === 0;
  run.cascaded = mustCascade;
  run.phase = mustCascade ? PHASE_BASELINE : PHASE_PROPAGATE;
}

/**
 * Run to completion in one call.
 *
 * The server path, and the one the synchronous runner uses. It delegates to the
 * resumable machinery rather than duplicating it, so there is exactly one
 * implementation of the arithmetic and the two schedules cannot drift apart.
 */
export function calculate(
  results: Float64Array,
  rowCount: number,
  seeds: Int32Array,
  seedCount: number,
  state: CalcState,
  run: CalcRun,
  changedOut: Int32Array,
): CalcResult {
  beginRun(run, state, seeds, seedCount);
  advanceRun(results, rowCount, state, run, changedOut, Infinity);
  return runResult(run);
}

export function runResult(run: CalcRun): CalcResult {
  return { visited: run.visited, changed: run.changedCount, cascaded: run.cascaded };
}

/**
 * Advances a run until `deadlineMs`, then returns.
 *
 * Returns `true` when the run is complete.
 *
 * Pass `Infinity` to run straight through with no yielding — that is the server
 * path, and it costs one predictable-branch comparison per 256 rows against a
 * straight-line implementation. Pass `performance.now() + 4` in the browser to
 * get the same work spread across frames.
 *
 * Slicing by *time* rather than by row count is deliberate. A fixed 4,000-row
 * chunk is ~4ms on a development machine and ~25ms on a low-end laptop, so a
 * row-count budget silently stops working on exactly the hardware it was
 * supposed to protect. A time budget self-calibrates.
 */
export function advanceRun(
  results: Float64Array,
  rowCount: number,
  state: CalcState,
  run: CalcRun,
  changedOut: Int32Array,
  deadlineMs: number,
): boolean {
  const { baselines, affected, composite, mark } = state;
  const cascadeLimit = rowCount * CASCADE_FRACTION;
  const churnLimit = rowCount * CHURN_LIMIT_FRACTION;

  while (run.phase !== PHASE_DONE) {
    switch (run.phase) {
      case PHASE_PROPAGATE: {
        // Expand seeds into the affected set. Cascades if it gets too large.
        while (run.cursor < run.seedCount) {
          const seed = run.seeds[run.cursor++];
          let cursor = seed;
          const cone = CONE_MIN + ((Math.imul(seed, 2654435761) >>> 0) % CONE_SPREAD);
          for (let step = 0; step < cone; step++) {
            cursor = (cursor * 1103515245 + 12345 + step) >>> 0;
            const row = cursor % rowCount;
            if (mark[row] !== state.generation) {
              mark[row] = state.generation;
              affected[run.affectedCount++] = row;
              if (run.affectedCount >= cascadeLimit) {
                run.cascaded = true;
                break;
              }
            }
          }
          if (run.cascaded) break;
          if (mark[seed] !== state.generation) {
            mark[seed] = state.generation;
            affected[run.affectedCount++] = seed;
          }
          if (performance.now() >= deadlineMs) return false;
        }

        if (!run.cascaded && state.churn + run.affectedCount > churnLimit) {
          run.cascaded = true;
        }
        run.phase = run.cascaded ? PHASE_BASELINE : PHASE_LOCAL;
        run.cursor = 0;
        break;
      }

      case PHASE_LOCAL: {
        // The cheap path: recompute only the affected rows, against cached baselines.
        let checked = 0;
        while (run.cursor < run.affectedCount) {
          const row = affected[run.cursor++];
          const c = computeComposite(results, row, baselines);
          const d = computeDispersion(results, row);
          const p = percentileOf(c, baselines);
          if (writeRow(results, row, c, d, p)) changedOut[run.changedCount++] = row;

          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        state.churn += run.affectedCount;
        run.visited = run.affectedCount;
        run.phase = PHASE_DONE;
        break;
      }

      case PHASE_BASELINE: {
        // Accumulate column sums. Sliced because at 6x CPU throttling a single
        // pass over 450k reads is well past a frame on its own.
        let checked = 0;
        const { sum, sumSq } = run;
        while (run.cursor < rowCount) {
          const base = run.cursor++ * RESULT_SIZE;
          for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
            const v = results[base + col];
            sum[col] += v;
            sumSq[col] += v * v;
          }
          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
          const mean = sum[col] / rowCount;
          const variance = Math.max(sumSq[col] / rowCount - mean * mean, 1e-9);
          baselines.mean[col] = mean;
          baselines.invStd[col] = 1 / Math.sqrt(variance);
        }
        baselines.valid = true;
        run.phase = PHASE_COMPOSITE;
        run.cursor = 0;
        break;
      }

      case PHASE_COMPOSITE: {
        // The dominant phase: R10 for every row.
        let checked = 0;
        while (run.cursor < rowCount) {
          composite[run.cursor] = computeComposite(results, run.cursor, baselines);
          run.cursor++;
          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        run.phase = PHASE_RANGE;
        run.cursor = 0;
        break;
      }

      case PHASE_RANGE: {
        let checked = 0;
        let { min, max } = run;
        while (run.cursor < rowCount) {
          const c = composite[run.cursor++];
          if (c < min) min = c;
          if (c > max) max = c;
          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            run.min = min;
            run.max = max;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        run.min = min;
        run.max = max;

        const span = max - min;
        baselines.compositeMin = min;
        baselines.compositeScale = span > 0 ? (HISTOGRAM_BUCKETS - 1) / span : 0;
        baselines.compositeCdf.fill(0);
        run.phase = PHASE_HISTOGRAM;
        run.cursor = 0;
        break;
      }

      case PHASE_HISTOGRAM: {
        let checked = 0;
        const cdf = baselines.compositeCdf;
        const { compositeMin, compositeScale } = baselines;
        while (run.cursor < rowCount) {
          cdf[((composite[run.cursor++] - compositeMin) * compositeScale) | 0]++;
          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        // Turn counts into a cumulative percentage. 2048 buckets: never worth slicing.
        let running = 0;
        const inv = 100 / rowCount;
        for (let bucket = 0; bucket < HISTOGRAM_BUCKETS; bucket++) {
          running += cdf[bucket];
          cdf[bucket] = running * inv;
        }
        run.phase = PHASE_FINALISE;
        run.cursor = 0;
        break;
      }

      case PHASE_FINALISE: {
        // Write R10/R11/R12 and record which rows actually moved.
        let checked = 0;
        while (run.cursor < rowCount) {
          const row = run.cursor++;
          const d = computeDispersion(results, row);
          const p = percentileOf(composite[row], baselines);
          if (writeRow(results, row, composite[row], d, p)) changedOut[run.changedCount++] = row;
          if (++checked >= DEADLINE_CHECK_INTERVAL) {
            checked = 0;
            if (performance.now() >= deadlineMs) return false;
          }
        }
        state.churn = 0;
        run.visited = rowCount;
        run.phase = PHASE_DONE;
        break;
      }
    }
  }

  return true;
}
