import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { calcEngine } from '../calc/calcEngine';
import { calcCountersReset, type CalcStatus } from '../store/calcSlice';
import { FRAME_BUDGET_MS } from '../perf/perfMonitor';

const STATUS_TEXT: Record<CalcStatus, string> = {
  idle: 'up to date',
  stale: 'stale — recalculating',
  calculating: 'calculating…',
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
  const dispatch = useAppDispatch();

  const forceFull = useCallback(() => calcEngine.requestFullRecalc(), []);
  const reset = useCallback(() => dispatch(calcCountersReset()), [dispatch]);

  const overBudget = calc.lastLongestBlockMs > FRAME_BUDGET_MS;
  const worstOverBudget = calc.worstBlockingMs > FRAME_BUDGET_MS;

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
          <dt title="Discovered by running it — nothing upstream chose this">outcome</dt>
          <dd>
            {calc.cold ? '—' : calc.cascaded ? 'cascaded (all rows)' : 'local'}
          </dd>
        </div>
        <div>
          <dt title="From the input change to computed values on screen">latency</dt>
          <dd>{calc.cold ? '—' : `${calc.lastLatencyMs.toFixed(1)} ms`}</dd>
        </div>
        <div>
          <dt title="Longest uninterrupted main-thread block. Over one frame means dropped frames.">
            longest block
          </dt>
          <dd className={overBudget ? 'bad' : 'good'}>
            {calc.cold ? '—' : `${calc.lastLongestBlockMs.toFixed(2)} ms`}
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
          <dt title="The tail is what the scheduling decision is about">worst block</dt>
          <dd className={worstOverBudget ? 'bad' : 'good'}>
            {calc.worstBlockingMs ? `${calc.worstBlockingMs.toFixed(1)} ms` : '—'}
          </dd>
        </div>
        <div>
          <dt>runs</dt>
          <dd>
            {calc.localCount.toLocaleString()} local ·{' '}
            {calc.cascadeCount.toLocaleString()} cascaded
            <button type="button" className="link" onClick={reset}>
              reset
            </button>
          </dd>
        </div>
      </dl>
    </div>
  );
}
