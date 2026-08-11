import { DATASET } from '../store/dataset';
import { ENTITY_COUNT } from '../types';

/**
 * The row objects handed to ag-grid, built once at module load and never
 * replaced.
 *
 * A row carries no data — only the identity of its main entity and the row
 * index every slice is keyed by. All actual cell values are pulled from the
 * store by valueGetters at render time, for visible cells only.
 *
 * This is what keeps updates cheap. If rows carried denormalised values, every
 * change would mean rebuilding row objects and handing ag-grid a new array,
 * which re-evaluates 50,000 rows. Instead `rowData` is set once and stays
 * referentially identical forever; changes are surgical cell refreshes.
 */
export interface GridRow {
  /** Main entity id — the row's identity, used by `getRowId`. */
  id: string;
  /** Shared row index into every slice's columnar storage. */
  row: number;
}

export const GRID_ROWS: GridRow[] = (() => {
  const rows = new Array<GridRow>(ENTITY_COUNT);
  for (let row = 0; row < ENTITY_COUNT; row++) {
    rows[row] = { id: DATASET.entityIds[row], row };
  }
  return rows;
})();
