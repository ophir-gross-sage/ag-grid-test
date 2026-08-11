import { useCallback, useRef } from 'react';
import type { GridApi } from 'ag-grid-community';

import { EntityGrid } from './components/EntityGrid';
import { Toolbar } from './components/Toolbar';
import { PerfHud } from './components/PerfHud';
import type { GridRow } from './components/gridRows';
import { ASPECT_POOL_SIZE, ENTITY_COUNT, RESULT_SIZE } from './types';

export function App() {
  /**
   * The grid api is shared through a ref rather than state on purpose: putting
   * it in state would re-render this component (and therefore the grid) the
   * moment the grid becomes ready.
   */
  const gridApiRef = useRef<GridApi<GridRow> | null>(null);

  const handleGridReady = useCallback((api: GridApi<GridRow>) => {
    gridApiRef.current = api;
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Entity Grid</h1>
          <p className="subtitle">
            {ENTITY_COUNT.toLocaleString()} main entities · {ASPECT_POOL_SIZE} shared aspects ·{' '}
            {RESULT_SIZE} result columns · every value read from and written to Redux
          </p>
        </div>
        <PerfHud />
      </header>

      <Toolbar gridApiRef={gridApiRef} />

      <p className="hint">
        The <strong>R1–R12</strong> columns are editable — double-click a cell, type a number and
        press Enter. The edit is written to Redux, and the grid reads it back from there.
      </p>

      <EntityGrid onGridReady={handleGridReady} />
    </div>
  );
}
