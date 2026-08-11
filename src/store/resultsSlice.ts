import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { RESULT_SIZE, type Result } from '../types';
import { DATASET } from './dataset';

/**
 * Results — the only hot slice, and the one everything else is shaped around.
 *
 * Storage is a single flat `Float64Array` of `ENTITY_COUNT * RESULT_SIZE`
 * doubles, mutated in place, with an immutable `revision` counter marking each
 * write. That is a deliberate departure from textbook Redux, so here is the
 * reasoning:
 *
 * A conventional normalised slice would store `Record<string, Result>` and an
 * edit would produce `{...entities}` — copying 50,000 keys, ~2-4ms, *per
 * keystroke*, plus a new `Result` and a new 12-element array. At 60fps the
 * whole frame is 16.7ms and the grid still has to lay out and paint, so the
 * copy alone eats a quarter of the budget and gets worse as the dataset grows.
 *
 * Writing one double into a typed array is O(1) and allocates nothing, so an
 * edit costs the same at 50,000 rows as at 50. The tradeoff is that the value
 * buffer is not referentially immutable, so change detection keys off
 * `revision` instead of identity, and DevTools time-travel over result values
 * is given up (DevTools is off anyway — see `store/index.ts`).
 *
 * `Result` objects are still the public currency: `selectResult` materialises
 * one on demand, and only ever for rows someone actually asked about.
 */

export interface ResultsState {
  /** Result ids, indexed by row. */
  ids: string[];
  /** Flat matrix: cell = `values[row * RESULT_SIZE + col]`. Mutated in place. */
  values: Float64Array;
  /** Incremented on every write. The immutable signal that something changed. */
  revision: number;
}

const initialState: ResultsState = {
  ids: DATASET.resultIds,
  values: DATASET.resultValues,
  revision: 0,
};

/** Payload shared by every mutating action so the sync middleware can read affected rows uniformly. */
export interface ResultMutation {
  /** Row index of the owning main entity. */
  row: number;
}

export interface SetResultCellPayload extends ResultMutation {
  col: number;
  value: number;
}

export interface SetResultValuePayload extends ResultMutation {
  /** Exactly `RESULT_SIZE` numbers. */
  value: number[];
}

const resultsSlice = createSlice({
  name: 'results',
  initialState,
  reducers: {
    /** Single-cell edit, the grid's inline editor path. */
    setResultCell: {
      reducer(state, action: PayloadAction<SetResultCellPayload>) {
        const { row, col, value } = action.payload;
        state.values[row * RESULT_SIZE + col] = value;
        state.revision++;
      },
      prepare: (row: number, col: number, value: number) => ({
        payload: { row, col, value },
      }),
    },

    /** Replace all `RESULT_SIZE` numbers of one result. */
    setResultValue: {
      reducer(state, action: PayloadAction<SetResultValuePayload>) {
        const { row, value } = action.payload;
        const base = row * RESULT_SIZE;
        for (let i = 0; i < RESULT_SIZE; i++) state.values[base + i] = value[i];
        state.revision++;
      },
      prepare: (row: number, value: number[]) => ({ payload: { row, value } }),
    },
  },
});

export const { setResultCell, setResultValue } = resultsSlice.actions;
export const resultsReducer = resultsSlice.reducer;

/** Action types the grid-sync middleware watches. */
export const RESULT_MUTATION_TYPES: ReadonlySet<string> = new Set([
  setResultCell.type,
  setResultValue.type,
]);

// --- Reads ------------------------------------------------------------------

/** O(1) read of a single cell. This is what the grid's valueGetters call. */
export function readResultCell(state: ResultsState, row: number, col: number): number {
  return state.values[row * RESULT_SIZE + col];
}

/** Materialise a `Result` object. Allocates — call it for a row, not for a viewport. */
export function materialiseResult(state: ResultsState, row: number): Result {
  const base = row * RESULT_SIZE;
  const value = new Array<number>(RESULT_SIZE);
  for (let i = 0; i < RESULT_SIZE; i++) value[i] = state.values[base + i];
  return { id: state.ids[row], mainEntityId: DATASET.entityIds[row], value };
}
