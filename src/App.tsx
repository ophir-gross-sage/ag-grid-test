import { useCallback, useRef } from 'react';
import type { GridApi } from 'ag-grid-community';

import { EntityGrid } from './components/EntityGrid';
import { Toolbar } from './components/Toolbar';
import { PerfHud } from './components/PerfHud';
import { CalcPanel } from './components/CalcPanel';
import type { GridRow } from './components/gridRows';
import { ASPECT_POOL_SIZE, ENTITY_COUNT, INPUT_RESULT_COLUMNS } from './types';

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
            {INPUT_RESULT_COLUMNS} input + 3 computed result columns · every value read from and
            written to Redux
          </p>
        </div>
        <PerfHud />
      </header>

      <Toolbar gridApiRef={gridApiRef} />
      <CalcPanel />

      <p className="hint">
        <strong>R1–R9</strong> are editable inputs — double-click a cell, type a number and press
        Enter. The edit goes to Redux, which triggers the calculation engine; it writes{' '}
        <strong>R10–R12</strong> back into the same results. A small edit recomputes one row; a
        large enough shift invalidates the population baselines and forces a full 50,000-row pass.
      </p>

      <EntityGrid onGridReady={handleGridReady} />
    </div>
  );
}
