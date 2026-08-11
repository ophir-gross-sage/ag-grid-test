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

export interface CalcResult {
  /** Rows the calculation actually visited. Discovered, never predicted. */
  visited: number;
  /** Rows whose computed outputs actually moved. */
  changed: number;
  /** Whether it ended up recomputing the whole population. */
  cascaded: boolean;
}

/**
 * Expands the seed rows into the affected set, or reports that it cascaded.
 *
 * The cone is deterministic in the row index rather than random, so a given
 * edit implicates the same rows every time — real dependency graphs are fixed
 * structure, not dice.
 */
function propagate(
  state: CalcState,
  seeds: Int32Array,
  seedCount: number,
  rowCount: number,
): number {
  const cascadeLimit = rowCount * CASCADE_FRACTION;
  state.generation++;
  const { mark, affected, generation } = state;
  let count = 0;

  for (let i = 0; i < seedCount; i++) {
    const seed = seeds[i];
    let cursor = seed;
    const cone = CONE_MIN + ((Math.imul(seed, 2654435761) >>> 0) % CONE_SPREAD);
    for (let step = 0; step < cone; step++) {
      // Cheap invertible scatter: dependents are spread across the population
      // rather than sitting next to each other, as a real dependency graph would.
      cursor = (cursor * 1103515245 + 12345 + step) >>> 0;
      const row = cursor % rowCount;
      if (mark[row] !== generation) {
        mark[row] = generation;
        affected[count++] = row;
        if (count >= cascadeLimit) return -1;
      }
    }
    if (mark[seed] !== generation) {
      mark[seed] = generation;
      affected[count++] = seed;
    }
  }
  return count;
}

/** Recomputes the whole population, rebuilding baselines and the percentile distribution. */
function recomputeAll(
  results: Float64Array,
  rowCount: number,
  state: CalcState,
  changedOut: Int32Array,
): number {
  const { baselines, composite } = state;

  computeBaselines(results, rowCount, baselines);
  for (let row = 0; row < rowCount; row++) {
    composite[row] = computeComposite(results, row, baselines);
  }
  computeCompositeDistribution(composite, rowCount, baselines);

  let changed = 0;
  for (let row = 0; row < rowCount; row++) {
    const dispersion = computeDispersion(results, row);
    const percentile = percentileOf(composite[row], baselines);
    if (writeRow(results, row, composite[row], dispersion, percentile)) {
      changedOut[changed++] = row;
    }
  }
  state.churn = 0;
  return changed;
}

/**
 * Run the calculation.
 *
 * The single entry point, and the only thing the engine is allowed to call.
 * Scope, cost and affected set are all outputs.
 */
export function calculate(
  results: Float64Array,
  rowCount: number,
  seeds: Int32Array,
  seedCount: number,
  state: CalcState,
  changedOut: Int32Array,
): CalcResult {
  // No baselines yet, or the caller asked for everything.
  if (!state.baselines.valid || seedCount === 0) {
    return { visited: rowCount, changed: recomputeAll(results, rowCount, state, changedOut), cascaded: true };
  }

  const affectedCount = propagate(state, seeds, seedCount, rowCount);
  const churnLimit = rowCount * CHURN_LIMIT_FRACTION;

  if (affectedCount < 0 || state.churn + affectedCount > churnLimit) {
    return { visited: rowCount, changed: recomputeAll(results, rowCount, state, changedOut), cascaded: true };
  }

  const { baselines, affected } = state;
  let changed = 0;
  for (let i = 0; i < affectedCount; i++) {
    const row = affected[i];
    const composite = computeComposite(results, row, baselines);
    const dispersion = computeDispersion(results, row);
    const percentile = percentileOf(composite, baselines);
    if (writeRow(results, row, composite, dispersion, percentile)) {
      changedOut[changed++] = row;
    }
  }
  state.churn += affectedCount;

  return { visited: affectedCount, changed, cascaded: false };
}

/**
 * The same calculation, yielding between chunks.
 *
 * Whether the *real* calculation can offer this is the single most important
 * unknown for choosing a scheduling strategy — a black box that cannot be
 * interrupted rules out every main-thread option at once, leaving only "move it
 * to another thread". It is implemented here so that the option can be measured
 * rather than assumed.
 *
 * Note what it still cannot do: yield *early with useful partial results for a
 * particular row*. The percentile phase needs every composite before any row's
 * final value is known, so the first two thirds of the work produce nothing
 * displayable. Interruptibility buys responsiveness, not earlier answers.
 */
export function* calculateChunked(
  results: Float64Array,
  rowCount: number,
  seeds: Int32Array,
  seedCount: number,
  state: CalcState,
  changedOut: Int32Array,
  chunkRows: number,
): Generator<number, CalcResult> {
  const affectedCount =
    state.baselines.valid && seedCount > 0
      ? propagate(state, seeds, seedCount, rowCount)
      : -1;
  const churnLimit = rowCount * CHURN_LIMIT_FRACTION;
  const cascaded = affectedCount < 0 || state.churn + affectedCount > churnLimit;

  const { baselines, composite, affected } = state;
  let changed = 0;

  if (!cascaded) {
    for (let start = 0; start < affectedCount; start += chunkRows) {
      const end = Math.min(start + chunkRows, affectedCount);
      for (let i = start; i < end; i++) {
        const row = affected[i];
        const c = computeComposite(results, row, baselines);
        const d = computeDispersion(results, row);
        const p = percentileOf(c, baselines);
        if (writeRow(results, row, c, d, p)) changedOut[changed++] = row;
      }
      yield end;
    }
    state.churn += affectedCount;
    return { visited: affectedCount, changed, cascaded: false };
  }

  computeBaselines(results, rowCount, baselines);
  yield 0;

  for (let start = 0; start < rowCount; start += chunkRows) {
    const end = Math.min(start + chunkRows, rowCount);
    for (let row = start; row < end; row++) {
      composite[row] = computeComposite(results, row, baselines);
    }
    yield end;
  }

  computeCompositeDistribution(composite, rowCount, baselines);

  for (let start = 0; start < rowCount; start += chunkRows) {
    const end = Math.min(start + chunkRows, rowCount);
    for (let row = start; row < end; row++) {
      const d = computeDispersion(results, row);
      const p = percentileOf(composite[row], baselines);
      if (writeRow(results, row, composite[row], d, p)) changedOut[changed++] = row;
    }
    yield rowCount + end;
  }

  state.churn = 0;
  return { visited: rowCount, changed, cascaded: true };
}
