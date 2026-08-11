import { useCallback, useState, type RefObject } from 'react';
import type { GridApi } from 'ag-grid-community';

import { ENTITY_COUNT, INPUT_RESULT_COLUMNS } from '../types';
import { useAppStore } from '../store/hooks';
import { setResultInputs } from '../store/resultsSlice';
import { mainEntityIdOfRow } from '../store/selectors';
import { measureDispatch } from '../perf/perfMonitor';
import type { GridRow } from './gridRows';

/**
 * Fresh values for one result's *inputs*. Randomness lives here, outside the
 * reducer.
 *
 * Only the 9 input slots: R10-R12 belong to the calculation, and writing
 * arbitrary numbers into them would put visibly wrong answers on screen for the
 * frame before the engine corrects them.
 */
function randomResultInputs(): number[] {
  const value = new Array<number>(INPUT_RESULT_COLUMNS);
  for (let i = 0; i < INPUT_RESULT_COLUMNS; i++) {
    value[i] = Math.round(Math.random() * 10000) / 100;
  }
  return value;
}

interface ToolbarProps {
  gridApiRef: RefObject<GridApi<GridRow> | null>;
}

interface LastMutation {
  mainEntityId: string;
  row: number;
  origin: 'anywhere' | 'on-screen' | 'stress';
  count: number;
}

export function Toolbar({ gridApiRef }: ToolbarProps) {
  const store = useAppStore();
  const [last, setLast] = useState<LastMutation | null>(null);

  /**
   * Pick any main entity in the dataset and rewrite the result that references
   * it. The row is almost certainly off-screen, which is the interesting case:
   * the dispatch costs the same either way, and the grid does no DOM work at
   * all until the row is scrolled into view.
   */
  const mutateRandomEntity = useCallback(() => {
    const row = Math.floor(Math.random() * ENTITY_COUNT);
    const value = randomResultInputs();

    measureDispatch('random entity', 1, () => store.dispatch(setResultInputs(row, value)));

    setLast({ mainEntityId: mainEntityIdOfRow(row), row, origin: 'anywhere', count: 1 });
  }, [store]);

  /**
   * Same mutation, but restricted to a row the user can actually see, so the
   * update is visible immediately (the changed cells flash).
   */
  const mutateVisibleEntity = useCallback(() => {
    const api = gridApiRef.current;
    if (!api) return;

    const first = api.getFirstDisplayedRowIndex();
    const lastIndex = api.getLastDisplayedRowIndex();
    if (first < 0 || lastIndex < first) return;

    const displayIndex = first + Math.floor(Math.random() * (lastIndex - first + 1));
    const node = api.getDisplayedRowAtIndex(displayIndex);
    if (!node?.data) return;

    const { row, id } = node.data;
    const value = randomResultInputs();

    measureDispatch('on-screen entity', 1, () => store.dispatch(setResultInputs(row, value)));

    setLast({ mainEntityId: id, row, origin: 'on-screen', count: 1 });
  }, [gridApiRef, store]);

  /**
   * Stress case: 1,000 random entities rewritten in one go — 9,000 individual
   * inputs. gridSync coalesces the whole burst into a single refresh on the
   * next frame, so this stays one frame's worth of work rather than 1,000
   * separate updates.
   *
   * It is also the reliable way to trigger a *full* recalculation: rewriting 2%
   * of the population moves the column means well past the drift threshold, so
   * the cached baselines stop being valid and all 50,000 rows have to be
   * recomputed.
   */
  const stressMutate = useCallback(() => {
    const count = 1000;
    const rows = new Array<number>(count);
    const values = new Array<number[]>(count);
    for (let i = 0; i < count; i++) {
      rows[i] = Math.floor(Math.random() * ENTITY_COUNT);
      values[i] = randomResultInputs();
    }

    measureDispatch('stress x1000', count, () => {
      for (let i = 0; i < count; i++) store.dispatch(setResultInputs(rows[i], values[i]));
    });

    setLast({ mainEntityId: mainEntityIdOfRow(rows[0]), row: rows[0], origin: 'stress', count });
  }, [store]);

  const jumpToLast = useCallback(() => {
    if (!last) return;
    gridApiRef.current?.ensureIndexVisible(last.row, 'middle');
  }, [gridApiRef, last]);

  return (
    <div className="toolbar">
      <button type="button" onClick={mutateRandomEntity}>
        Mutate random entity
      </button>
      <button type="button" onClick={mutateVisibleEntity}>
        Mutate entity on screen
      </button>
      <button type="button" className="secondary" onClick={stressMutate}>
        Stress: 1,000 entities
      </button>

      {last && (
        <span className="toolbar-status">
          {last.count > 1 ? (
            <>
              Rewrote <strong>{last.count.toLocaleString()}</strong> results —{' '}
              {(last.count * INPUT_RESULT_COLUMNS).toLocaleString()} inputs
            </>
          ) : (
            <>
              Rewrote results of <strong>{last.mainEntityId}</strong> (row{' '}
              {last.row.toLocaleString()})
            </>
          )}
          {last.origin !== 'on-screen' && (
            <button type="button" className="link" onClick={jumpToLast}>
              jump to row
            </button>
          )}
        </span>
      )}
    </div>
  );
}
