import type { RootState } from './index';
import type { Aspect, ExtraData, MainEntity, Result } from '../types';
import { DATASET } from './dataset';
import { materialiseResult, readResultCell } from './resultsSlice';
import { materialiseMainEntity, readAspectValue } from './mainEntitiesSlice';
import { materialiseExtraData, readExtraDataValue } from './extraDataSlice';
import type { AspectDefinition } from './aspectsSlice';

/**
 * The boundary where columnar storage turns back into the documented domain
 * shapes.
 *
 * Two tiers on purpose:
 *   - `read*` — O(1), allocation-free scalar reads. The grid's valueGetters use
 *     these, because they run once per *visible* cell on every refresh.
 *   - `select*` — materialise a full `MainEntity` / `Result` / `ExtraData`.
 *     These allocate, so they're for application code handling one entity at a
 *     time, never for feeding the grid.
 */

// --- Row-index lookups (static; assignments never change) -------------------

export function rowOfMainEntityId(id: string): number | undefined {
  return DATASET.entityIndexById.get(id);
}

export function rowOfResultId(id: string): number | undefined {
  return DATASET.resultIndexById.get(id);
}

export function rowOfExtraDataId(id: string): number | undefined {
  return DATASET.extraIndexById.get(id);
}

export function mainEntityIdOfRow(row: number): string {
  return DATASET.entityIds[row];
}

// --- Hot reads (allocation-free) --------------------------------------------

export function readResult(state: RootState, row: number, col: number): number {
  return readResultCell(state.results, row, col);
}

export function readAspect(state: RootState, row: number, poolIndex: number): string | undefined {
  return readAspectValue(state.mainEntities, row, poolIndex);
}

export function readExtra(state: RootState, row: number): string {
  return readExtraDataValue(state.extraData, row);
}

// --- Materialising selectors (allocate) -------------------------------------

export function selectAspectPool(state: RootState): AspectDefinition[] {
  return state.aspects.ids.map((id) => state.aspects.byId[id]);
}

export function selectMainEntity(state: RootState, id: string): MainEntity | undefined {
  const row = rowOfMainEntityId(id);
  if (row === undefined) return undefined;
  return materialiseMainEntity(state.mainEntities, row, state.aspects.ids);
}

/** The `Result` whose `mainEntityId` is `id` — the "results that reference the id". */
export function selectResultForMainEntity(state: RootState, id: string): Result | undefined {
  const row = rowOfMainEntityId(id);
  if (row === undefined) return undefined;
  return materialiseResult(state.results, row);
}

export function selectExtraDataForMainEntity(state: RootState, id: string): ExtraData | undefined {
  const row = rowOfMainEntityId(id);
  if (row === undefined) return undefined;
  return materialiseExtraData(state.extraData, row);
}

/** An entity's aspects in the specified `Record<string, Aspect>` form. */
export function selectAspectsOfMainEntity(
  state: RootState,
  id: string,
): Record<string, Aspect> | undefined {
  return selectMainEntity(state, id)?.aspects;
}
