import { useEffect, useState } from 'react';
import {
  FRAME_BUDGET_MS,
  resetSamples,
  startFrameMonitor,
  subscribeToPerf,
  type PerfSnapshot,
} from '../perf/perfMonitor';

/**
 * Live readout of the frame budget, so "this fits in a frame" is something you
 * can watch rather than take on faith.
 */
export function PerfHud() {
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    const stopFrames = startFrameMonitor();
    const unsubscribe = subscribeToPerf(setPerf);
    return () => {
      unsubscribe();
      stopFrames();
    };
  }, []);

  if (!perf) return null;

  const { last, samples } = perf;

  // Headline the CPU cost, not the end-to-end latency. `totalMs` includes
  // idling until the next animation frame, which is unavoidable and is not
  // work — reporting it as the budget number would overstate the cost ~20x.
  const worst = samples.reduce((max, s) => Math.max(max, s.cpuMs), 0);
  const mean = samples.length
    ? samples.reduce((sum, s) => sum + s.cpuMs, 0) / samples.length
    : 0;
  const usage = last ? Math.min(last.cpuMs / FRAME_BUDGET_MS, 1) : 0;
  const overBudget = last ? last.cpuMs > FRAME_BUDGET_MS : false;

  return (
    <div className="hud">
      <div className="hud-row">
        <span className="hud-label">Last change · cpu</span>
        <span className={`hud-value ${overBudget ? 'bad' : 'good'}`}>
          {last ? `${last.cpuMs.toFixed(2)} ms` : '—'}
        </span>
        <span className="hud-budget">/ {FRAME_BUDGET_MS.toFixed(1)} ms frame</span>
      </div>

      <div className="hud-bar" title="Share of one 60fps frame of main-thread time used by the last change">
        <div
          className={`hud-bar-fill ${overBudget ? 'bad' : 'good'}`}
          style={{ width: `${usage * 100}%` }}
        />
      </div>

      <dl className="hud-stats">
        <div>
          <dt>reducer</dt>
          <dd>{last ? `${last.dispatchMs.toFixed(2)} ms` : '—'}</dd>
        </div>
        <div>
          <dt>grid refresh</dt>
          <dd>{last ? `${last.refreshMs.toFixed(2)} ms` : '—'}</dd>
        </div>
        <div>
          <dt>rows touched</dt>
          <dd>{last ? last.rows.toLocaleString() : '—'}</dd>
        </div>
        <div>
          <dt>cpu mean / worst</dt>
          <dd>
            {mean.toFixed(2)} / {worst.toFixed(2)} ms
          </dd>
        </div>
        <div>
          <dt title="Dispatch to painted, including the wait for the next frame">
            end-to-end
          </dt>
          <dd>{last ? `${last.totalMs.toFixed(1)} ms` : '—'}</dd>
        </div>
        <div>
          <dt>fps · dropped</dt>
          <dd>
            {perf.fps ? perf.fps.toFixed(0) : '—'} · {perf.longFrames.toLocaleString()}/
            {perf.totalFrames.toLocaleString()}
          </dd>
        </div>
      </dl>

      <button type="button" className="link" onClick={resetSamples}>
        reset counters
      </button>
    </div>
  );
}
