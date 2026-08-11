import type { Middleware } from '@reduxjs/toolkit';
import { INPUT_RESULT_COLUMNS, RESULT_SIZE } from '../types';
import {
  setResultCell,
  setResultInputs,
  setResultValue,
  type ResultsState,
} from '../store/resultsSlice';
import { calcEngine } from './calcEngine';

/**
 * Turns input changes into calculation triggers.
 *
 * This is the only wire between the store and the engine, and it runs *before*
 * the reducer so it can read the previous value. The engine needs the delta,
 * not the new value: it maintains running column sums so it can answer "have
 * the population baselines drifted?" in O(9), without rescanning 50,000 rows
 * just to decide whether a rescan is needed.
 *
 * Two things keep the system from feeding itself:
 *
 *   - The engine writes its output (R10-R12) straight into the results buffer
 *     and announces it through `gridSync`, never through an action. So there is
 *     no dispatch here to ignore.
 *   - Even if there were, only input columns are watched. Computed columns are
 *     never inputs, so a computed write cannot dirty the row that produced it.
 */

/** Reused across dispatches; the middleware runs on a hot path and must not allocate. */
const deltaScratch = new Float64Array(INPUT_RESULT_COLUMNS);

export const calcMiddleware: Middleware = (api) => (next) => (action) => {
  const type = (action as { type?: string })?.type;

  if (type === setResultCell.type) {
    const { row, col, value } = (action as ReturnType<typeof setResultCell>).payload;
    // Writes to computed columns are the engine's own; they trigger nothing.
    if (col >= INPUT_RESULT_COLUMNS) return next(action);

    const previous = (api.getState() as { results: ResultsState }).results.values[
      row * RESULT_SIZE + col
    ];
    const result = next(action);

    deltaScratch.fill(0);
    deltaScratch[col] = value - previous;
    calcEngine.markRowDirty(row, deltaScratch);
    return result;
  }

  if (type === setResultInputs.type || type === setResultValue.type) {
    const { row, value } = (action as ReturnType<typeof setResultInputs>).payload;
    const values = (api.getState() as { results: ResultsState }).results.values;
    const base = row * RESULT_SIZE;

    deltaScratch.fill(0);
    for (let col = 0; col < INPUT_RESULT_COLUMNS; col++) {
      deltaScratch[col] = value[col] - values[base + col];
    }

    const result = next(action);
    calcEngine.markRowDirty(row, deltaScratch);
    return result;
  }

  return next(action);
};
