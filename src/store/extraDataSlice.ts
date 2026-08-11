import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ExtraData } from '../types';
import { DATASET } from './dataset';

/**
 * Extra data — one record per main entity, joined on row index like the others.
 */

export interface ExtraDataState {
  /** Extra-data ids, indexed by row. */
  ids: string[];
  /** Values, indexed by row. */
  values: string[];
  revision: number;
}

const initialState: ExtraDataState = {
  ids: DATASET.extraIds,
  values: DATASET.extraValues,
  revision: 0,
};

export interface SetExtraDataValuePayload {
  row: number;
  value: string;
}

const extraDataSlice = createSlice({
  name: 'extraData',
  initialState,
  reducers: {
    setExtraDataValue(state, action: PayloadAction<SetExtraDataValuePayload>) {
      state.values[action.payload.row] = action.payload.value;
      state.revision++;
    },
  },
});

export const { setExtraDataValue } = extraDataSlice.actions;
export const extraDataReducer = extraDataSlice.reducer;

export const EXTRA_DATA_MUTATION_TYPES: ReadonlySet<string> = new Set([
  setExtraDataValue.type,
]);

// --- Reads ------------------------------------------------------------------

export function readExtraDataValue(state: ExtraDataState, row: number): string {
  return state.values[row];
}

export function materialiseExtraData(state: ExtraDataState, row: number): ExtraData {
  return {
    id: state.ids[row],
    mainEntityId: DATASET.entityIds[row],
    value: state.values[row],
  };
}
