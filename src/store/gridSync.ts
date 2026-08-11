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

/** Column families the grid can refresh independently. */
export type ChangeKind = 'result' | 'aspect' | 'extra' | 'derived';

export interface GridChangeBatch {
  resultRows: ReadonlySet<number>;
  aspectRows: ReadonlySet<number>;
  extraRows: ReadonlySet<number>;
  derivedRows: ReadonlySet<number>;
  /**
   * Families where so many rows changed that enumerating them costs more than
   * refreshing every visible cell of that family. See `BULK_THRESHOLD`.
   */
  bulk: ReadonlySet<ChangeKind>;
}

type Listener = (batch: GridChangeBatch) => void;

/**
 * Above this many changed rows, stop tracking individual rows and refresh the
 * whole viewport for that family instead.
 *
 * A full recalculation can change tens of thousands of rows. Adding 50,000
 * entries to a Set and then looking up 50,000 row nodes costs several
 * milliseconds, to produce a refresh of the ~30 rows that are actually on
 * screen. Past this point the bulk path is both cheaper and visually identical.
 */
const BULK_THRESHOLD = 256;

const listeners = new Set<Listener>();

// Reused across flushes; cleared rather than reallocated.
const resultRows = new Set<number>();
const aspectRows = new Set<number>();
const extraRows = new Set<number>();
const derivedRows = new Set<number>();
const bulk = new Set<ChangeKind>();
const batch: GridChangeBatch = { resultRows, aspectRows, extraRows, derivedRows, bulk };

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
  derivedRows.clear();
  bulk.clear();
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

/**
 * Report changed rows for a family, from code that writes buffers directly
 * rather than through an action payload (the calculation engine).
 */
export function notifyRowsChanged(
  kind: ChangeKind,
  rows: Int32Array,
  count: number,
): void {
  if (count === 0) return;

  if (count > BULK_THRESHOLD) {
    bulk.add(kind);
  } else {
    const target =
      kind === 'result' ? resultRows
      : kind === 'aspect' ? aspectRows
      : kind === 'extra' ? extraRows
      : derivedRows;
    for (let i = 0; i < count; i++) target.add(rows[i]);
  }
  schedule();
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
