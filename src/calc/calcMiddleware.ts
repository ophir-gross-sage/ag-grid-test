import type { Middleware } from '@reduxjs/toolkit';
import { INPUT_RESULT_COLUMNS } from '../types';
import { setResultCell, setResultInputs, setResultValue } from '../store/resultsSlice';
import { calcEngine } from './calcEngine';

/**
 * Turns input changes into calculation triggers.
 *
 * The only wire between the store and the engine, and it is deliberately thin:
 * it reports *that* a row's inputs changed and nothing else. An earlier version
 * also computed per-column deltas so the engine could maintain running sums and
 * predict whether a full pass was needed. That was deleted along with the
 * prediction it fed — the real calculation decides its own scope internally, so
 * computing inputs for a decision nobody makes anymore was pure overhead.
 *
 * Two things keep the system from feeding itself:
 *
 *   - The engine writes its output (R10-R12) straight into the results buffer
 *     and announces it through `gridSync`, never through an action. So there is
 *     no dispatch here to ignore.
 *   - Even if there were, only input columns are watched. Computed columns are
 *     never inputs, so a computed write cannot dirty the row that produced it.
 */
export const calcMiddleware: Middleware = () => (next) => (action) => {
  const result = next(action);
  const type = (action as { type?: string })?.type;

  if (type === setResultCell.type) {
    const { row, col } = (action as ReturnType<typeof setResultCell>).payload;
    // Writes to computed columns are the engine's own; they trigger nothing.
    if (col < INPUT_RESULT_COLUMNS) calcEngine.markRowDirty(row);
    return result;
  }

  if (type === setResultInputs.type || type === setResultValue.type) {
    const { row } = (action as ReturnType<typeof setResultInputs>).payload;
    calcEngine.markRowDirty(row);
  }

  return result;
};
