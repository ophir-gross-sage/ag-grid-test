import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { ASPECT_POOL_SIZE, type Aspect } from '../types';

/**
 * The shared aspect pool.
 *
 * There are exactly `ASPECT_POOL_SIZE` aspects and every main entity draws its
 * (at most 3) aspects from this pool, so the pool doubles as the column
 * vocabulary for the grid: one column per pool entry.
 *
 * The pool entry carries the canonical/default `value`; an individual entity
 * may override it with its own value (stored columnar-ly in `mainEntitiesSlice`).
 */

export interface AspectDefinition extends Aspect {
  /** Human-readable column header. Not part of the `Aspect` contract. */
  label: string;
}

export interface AspectsState {
  ids: string[];
  byId: Record<string, AspectDefinition>;
}

const POOL_LABELS = ['Region', 'Tier', 'Channel', 'Segment', 'Owner'] as const;

function buildPool(): AspectsState {
  const ids: string[] = [];
  const byId: Record<string, AspectDefinition> = {};
  for (let i = 0; i < ASPECT_POOL_SIZE; i++) {
    const id = `aspect-${i}`;
    ids.push(id);
    byId[id] = { id, label: POOL_LABELS[i] ?? `Aspect ${i}`, value: '' };
  }
  return { ids, byId };
}

const aspectsSlice = createSlice({
  name: 'aspects',
  initialState: buildPool(),
  reducers: {
    /** Rename a pool aspect's canonical value. The pool is tiny, so plain immutable updates are fine here. */
    setAspectValue(state, action: PayloadAction<{ id: string; value: string }>) {
      const entry = state.byId[action.payload.id];
      if (entry) entry.value = action.payload.value;
    },
  },
});

export const { setAspectValue } = aspectsSlice.actions;
export const aspectsReducer = aspectsSlice.reducer;
