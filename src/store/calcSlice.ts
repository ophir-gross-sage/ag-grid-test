import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Observable state of the calculation engine.
 *
 * The engine writes its *output* into `resultsSlice` (R10-R12), so this slice
 * holds no data — only the freshness and cost of the last run. It exists so the
 * UI can show what the engine is doing without importing the engine, and so the
 * engine never needs to know a UI exists.
 */

export type CalcStatus =
  /** Computed results agree with their inputs. */
  | 'idle'
  /**
   * Inputs changed and the computed values on screen no longer match them.
   *
   * There is deliberately no separate 'queued' state. We cannot say whether the
   * pending run will settle in 1ms or cascade for 50ms, so promising anything
   * more specific than "what you're looking at is behind" would be a guess.
   */
  | 'stale'
  /** A run is in flight. */
  | 'calculating';

export interface CalcState {
  status: CalcStatus;
  /** Whether the last run recomputed the whole population. Discovered, not requested. */
  cascaded: boolean;
  /** Wall-clock time from the input change to results on screen. */
  lastLatencyMs: number;
  /** Main-thread time the last run occupied. Equals latency only when it ran synchronously. */
  lastBlockingMs: number;
  /** Longest uninterrupted main-thread block during the last run. */
  lastLongestBlockMs: number;
  /** Rows whose computed values actually moved. */
  lastChangedRows: number;
  /** Rows the last run visited, changed or not. */
  lastVisitedRows: number;
  /** Runs so far, split by what they turned out to be. */
  localCount: number;
  cascadeCount: number;
  /** Worst blocking time seen this session. The tail is the thing being managed. */
  worstBlockingMs: number;
  /** True until the first run completes. */
  cold: boolean;
}

const initialState: CalcState = {
  status: 'idle',
  cascaded: false,
  lastLatencyMs: 0,
  lastBlockingMs: 0,
  lastLongestBlockMs: 0,
  lastChangedRows: 0,
  lastVisitedRows: 0,
  localCount: 0,
  cascadeCount: 0,
  worstBlockingMs: 0,
  cold: true,
};

export interface CalcCompletedPayload {
  cascaded: boolean;
  latencyMs: number;
  blockingMs: number;
  longestBlockMs: number;
  changedRows: number;
  visitedRows: number;
}

const calcSlice = createSlice({
  name: 'calc',
  initialState,
  reducers: {
    calcScheduled(state, action: PayloadAction<{ stale: boolean }>) {
      if (action.payload.stale) state.status = 'stale';
    },
    calcStarted(state) {
      state.status = 'calculating';
    },
    calcCompleted(state, action: PayloadAction<CalcCompletedPayload>) {
      const p = action.payload;
      state.status = 'idle';
      state.cold = false;
      state.cascaded = p.cascaded;
      state.lastLatencyMs = p.latencyMs;
      state.lastBlockingMs = p.blockingMs;
      state.lastLongestBlockMs = p.longestBlockMs;
      state.lastChangedRows = p.changedRows;
      state.lastVisitedRows = p.visitedRows;
      if (p.cascaded) state.cascadeCount++;
      else state.localCount++;
      if (p.longestBlockMs > state.worstBlockingMs) {
        state.worstBlockingMs = p.longestBlockMs;
      }
    },
    calcCountersReset(state) {
      state.localCount = 0;
      state.cascadeCount = 0;
      state.worstBlockingMs = 0;
    },
  },
});

export const { calcScheduled, calcStarted, calcCompleted, calcCountersReset } =
  calcSlice.actions;
export const calcReducer = calcSlice.reducer;
