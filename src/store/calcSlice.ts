import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Observable state of the calculation engine.
 *
 * The engine writes its *output* into `resultsSlice` (R10-R12), so this slice
 * holds no data — only the freshness and cost of the last pass. It exists so
 * the UI can show what the engine is doing without importing the engine, and so
 * the engine never needs to know a UI exists.
 */

export type CalcScope = 'none' | 'incremental' | 'full';

export type CalcStatus =
  /** Computed results agree with their inputs. */
  | 'idle'
  /** Inputs changed; a pass is queued but hasn't started. */
  | 'scheduled'
  /** A pass is in flight. */
  | 'calculating'
  /**
   * On-screen computed values are known to be behind their inputs.
   *
   * Worth distinguishing from 'calculating': this is the state where the grid
   * is showing numbers it knows are wrong, which is the thing the user asked
   * to minimise.
   */
  | 'stale';

export interface CalcState {
  status: CalcStatus;
  scope: CalcScope;
  /** Wall-clock time from scheduling to results applied. */
  lastLatencyMs: number;
  /** Main-thread time the last pass occupied. Equals latency only when it ran synchronously. */
  lastBlockingMs: number;
  /** Longest uninterrupted main-thread block during the last pass. */
  lastLongestBlockMs: number;
  /** Rows whose computed values actually moved. */
  lastChangedRows: number;
  /** Rows the last pass had to visit, changed or not. */
  lastVisitedRows: number;
  fullCount: number;
  incrementalCount: number;
  /** How far the population had drifted when a full pass was last triggered. */
  lastDrift: number;
}

const initialState: CalcState = {
  status: 'idle',
  scope: 'none',
  lastLatencyMs: 0,
  lastBlockingMs: 0,
  lastLongestBlockMs: 0,
  lastChangedRows: 0,
  lastVisitedRows: 0,
  fullCount: 0,
  incrementalCount: 0,
  lastDrift: 0,
};

export interface CalcCompletedPayload {
  scope: CalcScope;
  latencyMs: number;
  blockingMs: number;
  longestBlockMs: number;
  changedRows: number;
  visitedRows: number;
  drift: number;
}

const calcSlice = createSlice({
  name: 'calc',
  initialState,
  reducers: {
    calcScheduled(state, action: PayloadAction<{ scope: CalcScope; stale: boolean }>) {
      state.status = action.payload.stale ? 'stale' : 'scheduled';
      state.scope = action.payload.scope;
    },
    calcStarted(state) {
      state.status = 'calculating';
    },
    calcCompleted(state, action: PayloadAction<CalcCompletedPayload>) {
      const p = action.payload;
      state.status = 'idle';
      state.scope = p.scope;
      state.lastLatencyMs = p.latencyMs;
      state.lastBlockingMs = p.blockingMs;
      state.lastLongestBlockMs = p.longestBlockMs;
      state.lastChangedRows = p.changedRows;
      state.lastVisitedRows = p.visitedRows;
      state.lastDrift = p.drift;
      if (p.scope === 'full') state.fullCount++;
      else if (p.scope === 'incremental') state.incrementalCount++;
    },
    calcCountersReset(state) {
      state.fullCount = 0;
      state.incrementalCount = 0;
    },
  },
});

export const { calcScheduled, calcStarted, calcCompleted, calcCountersReset } =
  calcSlice.actions;
export const calcReducer = calcSlice.reducer;

/** Action types the engine emits. The calc middleware ignores these, which is what breaks the loop. */
export const CALC_ACTION_TYPES: ReadonlySet<string> = new Set([
  calcScheduled.type,
  calcStarted.type,
  calcCompleted.type,
  calcCountersReset.type,
]);
