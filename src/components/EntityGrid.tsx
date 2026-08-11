import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  colorSchemeDark,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type IRowNode,
  type ValueGetterParams,
  type ValueSetterParams,
} from 'ag-grid-community';

import { INPUT_RESULT_COLUMNS, RESULT_SIZE, isComputedResultColumn } from '../types';
import { useAppStore } from '../store/hooks';
import { readAspect, readExtra, readResult } from '../store/selectors';
import { setResultCell } from '../store/resultsSlice';
import { subscribeToGridChanges, type GridChangeBatch } from '../store/gridSync';
import { completeTask, measureDispatch } from '../perf/perfMonitor';
import { GRID_ROWS, type GridRow } from './gridRows';

const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  spacing: 6,
  headerHeight: 38,
  rowHeight: 30,
  backgroundColor: '#171a21',
  headerBackgroundColor: '#1e222b',
  oddRowBackgroundColor: '#1b1f27',
  borderColor: '#2a2f3a',
  foregroundColor: '#e6e8ec',
  accentColor: '#6ea8fe',
});

export const RESULT_COLUMN_IDS: string[] = Array.from(
  { length: RESULT_SIZE },
  (_, col) => `result-${col}`,
);

/** R10-R12 — the calculation's output. */
export const COMPUTED_COLUMN_IDS: string[] = RESULT_COLUMN_IDS.filter((_, col) =>
  isComputedResultColumn(col),
);

/** What each computed column means, for its header tooltip. */
const COMPUTED_COLUMN_HELP: Record<number, string> = {
  [INPUT_RESULT_COLUMNS]:
    'Composite — R1-R9 normalised against population baselines. Computed; depends on every row.',
  [INPUT_RESULT_COLUMNS + 1]:
    'Dispersion — spread of R1-R9 around their own mean. Computed; depends on this row only.',
  [INPUT_RESULT_COLUMNS + 2]:
    'Percentile — rank of this row’s composite among all 50,000. Computed; depends on every row.',
};
const ASPECT_COLUMN_PREFIX = 'aspect-col-';
const EXTRA_COLUMN_ID = 'extraData';

interface EntityGridProps {
  onGridReady: (api: GridApi<GridRow>) => void;
}

export function EntityGrid({ onGridReady }: EntityGridProps) {
  const store = useAppStore();
  const apiRef = useRef<GridApi<GridRow> | null>(null);

  /**
   * Column definitions are built once. Every getter reads the store
   * non-reactively via `store.getState()` — the component itself never
   * subscribes, so nothing here re-renders when data changes.
   *
   * These getters run once per *visible* cell per refresh: roughly 30 rows by
   * 18 columns, about 540 calls, each an O(1) typed-array or array index. Row
   * virtualisation is what makes reading from the store on every paint viable.
   */
  const columnDefs = useMemo<ColDef<GridRow>[]>(() => {
    const aspectPool = store.getState().aspects;

    const extraColumn: ColDef<GridRow> = {
      colId: EXTRA_COLUMN_ID,
      headerName: 'Extra Data',
      width: 150,
      pinned: 'left',
      valueGetter: (p: ValueGetterParams<GridRow>) =>
        p.data ? readExtra(store.getState(), p.data.row) : undefined,
    };

    const aspectColumns: ColDef<GridRow>[] = aspectPool.ids.map((aspectId, poolIndex) => ({
      colId: `${ASPECT_COLUMN_PREFIX}${poolIndex}`,
      headerName: aspectPool.byId[aspectId].label,
      headerTooltip: `Shared aspect "${aspectId}" — blank where the entity doesn't carry it`,
      width: 130,
      valueGetter: (p: ValueGetterParams<GridRow>) =>
        p.data ? readAspect(store.getState(), p.data.row, poolIndex) : undefined,
    }));

    const resultColumns: ColDef<GridRow>[] = RESULT_COLUMN_IDS.map((colId, col) => {
      const computed = isComputedResultColumn(col);
      return {
      colId,
      headerName: computed ? `R${col + 1} ƒ` : `R${col + 1}`,
      headerTooltip: computed ? COMPUTED_COLUMN_HELP[col] : undefined,
      headerClass: computed ? 'computed-header' : undefined,
      cellClass: computed ? 'computed-cell' : undefined,
      width: computed ? 96 : 86,
      /**
       * Computed columns are outputs, not inputs. Making them editable would
       * let a user type a value that the next calculation silently overwrites —
       * the edit appears to work and then vanishes, which is worse than not
       * offering it.
       */
      editable: !computed,
      cellDataType: 'number',
      type: 'numericColumn',
      valueGetter: (p: ValueGetterParams<GridRow>) =>
        p.data ? readResult(store.getState(), p.data.row, col) : undefined,
      valueFormatter: computed
        ? (p) => (typeof p.value === 'number' ? p.value.toFixed(2) : '')
        : undefined,

      /**
       * The write path for an inline edit. Redux is the only place the value
       * lives, so committing an edit *is* a dispatch — there is no local grid
       * state to keep in step, and no chance of the two diverging.
       */
      valueSetter: (p: ValueSetterParams<GridRow>) => {
        if (!p.data) return false;
        const next = Number(p.newValue);
        if (!Number.isFinite(next)) return false;
        if (readResult(store.getState(), p.data.row, col) === next) return false;

        measureDispatch('inline edit', 1, () =>
          store.dispatch(setResultCell(p.data!.row, col, next)),
        );
        // `true` tells ag-grid the value moved, so it repaints this cell now;
        // the gridSync batch repaints anything else the change implied.
        return true;
      },
      };
    });

    return [extraColumn, ...aspectColumns, ...resultColumns];
  }, [store]);

  const defaultColDef = useMemo<ColDef<GridRow>>(
    () => ({ sortable: false, filter: false, resizable: true, suppressMovable: true }),
    [],
  );

  /**
   * Applies a change batch to the grid.
   *
   * Cost is proportional to the number of *changed* rows, not to the dataset:
   * `getRowNode` is a hash lookup, and `refreshCells` on a row that isn't
   * currently rendered does no DOM work at all.
   */
  const applyBatch = useCallback((batch: GridChangeBatch) => {
    const api = apiRef.current;
    if (!api) return;

    const startedAt = performance.now();
    let touched = 0;

    const refresh = (rows: ReadonlySet<number>, columns: string[]) => {
      if (rows.size === 0) return;
      const nodes: IRowNode<GridRow>[] = [];
      for (const row of rows) {
        const node = api.getRowNode(GRID_ROWS[row].id);
        if (node) nodes.push(node);
      }
      if (nodes.length === 0) return;
      touched += nodes.length;
      api.refreshCells({ rowNodes: nodes, columns, force: true });
      api.flashCells({ rowNodes: nodes, columns });
    };

    refresh(batch.resultRows, RESULT_COLUMN_IDS);
    refresh(
      batch.aspectRows,
      store.getState().aspects.ids.map((_, i) => `${ASPECT_COLUMN_PREFIX}${i}`),
    );
    refresh(batch.extraRows, [EXTRA_COLUMN_ID]);

    /**
     * Bulk path: too many rows changed to be worth naming individually, so
     * refresh every rendered cell of that family instead. Omitting `rowNodes`
     * means "all rendered rows" — around 30, whatever the change count was.
     */
    if (batch.bulk.has('result')) {
      touched += 1;
      api.refreshCells({ columns: RESULT_COLUMN_IDS, force: true });
      /**
       * Flash only the computed columns, not the whole viewport. A full
       * recalculation can change every row on screen; strobing all 18 columns
       * would say "everything moved" when the informative signal is narrower —
       * these three are what the calculation actually rewrote.
       */
      api.flashCells({ columns: COMPUTED_COLUMN_IDS });
    }

    if (touched > 0) completeTask(performance.now() - startedAt);
  }, [store]);

  useEffect(() => subscribeToGridChanges(applyBatch), [applyBatch]);

  const handleGridReady = useCallback(
    (event: GridReadyEvent<GridRow>) => {
      apiRef.current = event.api;
      onGridReady(event.api);
    },
    [onGridReady],
  );

  return (
    <div className="grid-shell">
      <AgGridReact<GridRow>
        theme={theme}
        rowData={GRID_ROWS}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        /* Stable row identity. Without it ag-grid falls back to index-based
           matching and `getRowNode` lookups by id stop working. */
        getRowId={(p) => p.data.id}
        onGridReady={handleGridReady}
        /* Row animation re-lays-out on every change for no informational gain
           at this size, and cell flashing already shows what moved. */
        animateRows={false}
        cellFlashDuration={450}
        cellFadeDuration={450}
        /* Values live in the store, not on the row objects, so ag-grid's own
           row-level change detection has nothing to compare and would only
           cost time. Refreshes are driven explicitly by gridSync instead. */
        suppressChangeDetection
        rowBuffer={8}
        enableCellTextSelection={false}
        stopEditingWhenCellsLoseFocus
        suppressCellFocus={false}
      />
    </div>
  );
}
