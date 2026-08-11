import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { MAX_ASPECTS_PER_ENTITY, type Aspect, type MainEntity } from '../types';
import { DATASET } from './dataset';

/**
 * Main entities — one per grid row.
 *
 * Same columnar reasoning as `resultsSlice`: an entity's (at most 3) aspects
 * live in two parallel arrays of `ENTITY_COUNT * MAX_ASPECTS_PER_ENTITY` slots
 * rather than 50,000 nested `Record<string, Aspect>` objects, which would be
 * ~150,000 extra allocations for data the viewport reads 30 rows of at a time.
 *
 * `selectMainEntity` reassembles the specified `MainEntity` shape on demand.
 */

export interface MainEntitiesState {
  /** Entity ids, indexed by row. */
  ids: string[];
  /** Pool index of each aspect slot, or -1 when the slot is unused. */
  slotPoolIndex: Int8Array;
  /** Value of each aspect slot. */
  slotValue: string[];
  revision: number;
}

const initialState: MainEntitiesState = {
  ids: DATASET.entityIds,
  slotPoolIndex: DATASET.aspectSlotPoolIndex,
  slotValue: DATASET.aspectSlotValue,
  revision: 0,
};

export interface SetEntityAspectValuePayload {
  row: number;
  /** Index into the shared aspect pool. */
  poolIndex: number;
  value: string;
}

const mainEntitiesSlice = createSlice({
  name: 'mainEntities',
  initialState,
  reducers: {
    /** Set an entity's value for a pooled aspect it already carries. No-op if it doesn't carry it. */
    setEntityAspectValue(state, action: PayloadAction<SetEntityAspectValuePayload>) {
      const { row, poolIndex, value } = action.payload;
      const base = row * MAX_ASPECTS_PER_ENTITY;
      for (let slot = 0; slot < MAX_ASPECTS_PER_ENTITY; slot++) {
        if (state.slotPoolIndex[base + slot] === poolIndex) {
          state.slotValue[base + slot] = value;
          state.revision++;
          return;
        }
      }
    },
  },
});

export const { setEntityAspectValue } = mainEntitiesSlice.actions;
export const mainEntitiesReducer = mainEntitiesSlice.reducer;

export const ENTITY_MUTATION_TYPES: ReadonlySet<string> = new Set([
  setEntityAspectValue.type,
]);

// --- Reads ------------------------------------------------------------------

/**
 * O(3) read of one entity's value for a pooled aspect, or `undefined` when the
 * entity doesn't carry that aspect. This is what the aspect valueGetters call.
 */
export function readAspectValue(
  state: MainEntitiesState,
  row: number,
  poolIndex: number,
): string | undefined {
  const base = row * MAX_ASPECTS_PER_ENTITY;
  for (let slot = 0; slot < MAX_ASPECTS_PER_ENTITY; slot++) {
    if (state.slotPoolIndex[base + slot] === poolIndex) {
      return state.slotValue[base + slot];
    }
  }
  return undefined;
}

/** Materialise a `MainEntity`, including its `Record<string, Aspect>`. Allocates. */
export function materialiseMainEntity(
  state: MainEntitiesState,
  row: number,
  aspectIds: string[],
): MainEntity {
  const base = row * MAX_ASPECTS_PER_ENTITY;
  const aspects: Record<string, Aspect> = {};
  for (let slot = 0; slot < MAX_ASPECTS_PER_ENTITY; slot++) {
    const poolIndex = state.slotPoolIndex[base + slot];
    if (poolIndex < 0) continue;
    const id = aspectIds[poolIndex];
    aspects[id] = { id, value: state.slotValue[base + slot] };
  }
  return { id: state.ids[row], aspects };
}
