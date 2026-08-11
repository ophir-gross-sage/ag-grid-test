import { useCallback } from 'react';
import { useAppSelector } from '../store/hooks';
import { calcEngine } from '../calc/calcEngine';
import { FRAME_BUDGET_MS } from '../perf/perfMonitor';
import type { CalcStatus } from '../store/calcSlice';

const STATUS_TEXT: Record<CalcStatus, string> = {
  idle: 'up to date',
  scheduled: 'queued',
  calculating: 'calculating…',
  stale: 'showing stale values',
};

/**
 * Reads the engine's published state.
 *
 * `useSelector` is safe here in a way it would not be over cell data: this
 * component is tiny, it re-renders a handful of times per calculation rather
 * than per keystroke, and it is a sibling of the grid rather than an ancestor,
 * so nothing it does can re-render 50,000 rows.
 */
export function CalcPanel() {
  const calc = useAppSelector((s) => s.calc);

  const forceFull = useCallback(() => calcEngine.requestFullRecalc(), []);

  const overBudget = calc.lastLongestBlockMs > FRAME_BUDGET_MS;

  return (
    <div className="calc-panel">
      <div className="calc-head">
        <span className={`calc-dot calc-${calc.status}`} />
        <span className="calc-status">Calculation · {STATUS_TEXT[calc.status]}</span>
        <button type="button" className="secondary small" onClick={forceFull}>
          Force full recalc
        </button>
      </div>

      <dl className="calc-stats">
        <div>
          <dt>last pass</dt>
          <dd>{calc.scope === 'none' ? '—' : calc.scope}</dd>
        </div>
        <div>
          <dt title="Time from the input change to computed values on screen">latency</dt>
          <dd>{calc.scope === 'none' ? '—' : `${calc.lastLatencyMs.toFixed(1)} ms`}</dd>
        </div>
        <div>
          <dt title="Longest uninterrupted main-thread block. Over one frame means dropped frames.">
            longest block
          </dt>
          <dd className={overBudget ? 'bad' : 'good'}>
            {calc.scope === 'none' ? '—' : `${calc.lastLongestBlockMs.toFixed(2)} ms`}
          </dd>
        </div>
        <div>
          <dt>rows changed</dt>
          <dd>
            {calc.lastChangedRows.toLocaleString()}
            <span className="calc-sub"> / {calc.lastVisitedRows.toLocaleString()} visited</span>
          </dd>
        </div>
        <div>
          <dt title="Population drift that decided incremental vs full">drift</dt>
          <dd>
            {calc.lastDrift.toFixed(3)} σ
          </dd>
        </div>
        <div>
          <dt>passes</dt>
          <dd>
            {calc.incrementalCount.toLocaleString()} inc ·{' '}
            {calc.fullCount.toLocaleString()} full
          </dd>
        </div>
      </dl>
    </div>
  );
}
