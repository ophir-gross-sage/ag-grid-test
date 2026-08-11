import type { Middleware } from '@reduxjs/toolkit';
import { RESULT_MUTATION_TYPES } from './resultsSlice';
import { ENTITY_MUTATION_TYPES } from './mainEntitiesSlice';
import { EXTRA_DATA_MUTATION_TYPES } from './extraDataSlice';

/**
 * Tells the grid *which rows* changed, so a refresh costs O(changed) instead of
 * O(50,000).
 *
 * The alternative — subscribing the grid to the store and diffing state — is
 * the thing that makes big Redux grids slow: every action walks the whole
 * dataset looking for what moved. Here the reducers already know the row they
 * touched, so the middleware simply forwards it.
 *
 * Changes are coalesced into one `requestAnimationFrame` flush. A burst of
 * dispatches (a paste, a bulk mutation, a rapid sequence of edits) therefore
 * produces exactly one grid refresh, on the next frame, instead of one refresh
 * per action.
 */

export interface GridChangeBatch {
  /** Rows whose result values changed. */
  resultRows: ReadonlySet<number>;
  /** Rows whose aspect values changed. */
  aspectRows: ReadonlySet<number>;
  /** Rows whose extra-data value changed. */
  extraRows: ReadonlySet<number>;
}

type Listener = (batch: GridChangeBatch) => void;

const listeners = new Set<Listener>();

// Reused across flushes; cleared rather than reallocated.
const resultRows = new Set<number>();
const aspectRows = new Set<number>();
const extraRows = new Set<number>();
const batch: GridChangeBatch = { resultRows, aspectRows, extraRows };

let scheduled = 0;

export function subscribeToGridChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function flush(): void {
  scheduled = 0;
  if (listeners.size > 0) {
    for (const listener of listeners) listener(batch);
  }
  resultRows.clear();
  aspectRows.clear();
  extraRows.clear();
}

function schedule(): void {
  if (scheduled === 0) scheduled = requestAnimationFrame(flush);
}

/** Force the pending batch out now instead of waiting for the frame. Used by tests and benchmarks. */
export function flushGridChangesNow(): void {
  if (scheduled !== 0) {
    cancelAnimationFrame(scheduled);
    flush();
  }
}

export const gridSyncMiddleware: Middleware = () => (next) => (action) => {
  const result = next(action);

  const type = (action as { type?: string })?.type;
  if (typeof type !== 'string') return result;

  const payload = (action as { payload?: { row?: number } }).payload;
  const row = payload?.row;
  if (typeof row !== 'number') return result;

  if (RESULT_MUTATION_TYPES.has(type)) {
    resultRows.add(row);
    schedule();
  } else if (ENTITY_MUTATION_TYPES.has(type)) {
    aspectRows.add(row);
    schedule();
  } else if (EXTRA_DATA_MUTATION_TYPES.has(type)) {
    extraRows.add(row);
    schedule();
  }

  return result;
};
