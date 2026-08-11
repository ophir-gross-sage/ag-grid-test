/**
 * Measures what the app actually costs, rather than trusting that it's fast.
 *
 * Two independent signals:
 *
 *  1. Task timings — for each user-initiated change, the time spent in the
 *     reducer (`dispatchMs`) and the time spent refreshing grid cells
 *     (`refreshMs`). `totalMs` spans from just before dispatch to the end of
 *     the refresh, which is the number that has to stay under one frame.
 *
 *  2. Frame health — a free-running rAF loop tracking instantaneous FPS and
 *     counting frames that overran the budget. A task can look fast in
 *     isolation and still cause a dropped frame downstream; this catches that.
 */

/** One frame at 60Hz. The budget every change has to fit inside. */
export const FRAME_BUDGET_MS = 1000 / 60;

export interface TaskSample {
  label: string;
  /** Time inside `store.dispatch`, i.e. the reducer plus middleware. */
  dispatchMs: number;
  /** Time spent refreshing grid cells. */
  refreshMs: number;
  /**
   * Dispatch start to refresh end — end-to-end latency, which includes idling
   * until the next animation frame. Latency, not cost: see `cpuMs`.
   */
  totalMs: number;
  /**
   * Main-thread time the change actually consumed (`dispatchMs + refreshMs`).
   * This is the number that competes with everything else in the frame, and
   * the one that has to stay well under the budget.
   */
  cpuMs: number;
  /** Rows the change touched. */
  rows: number;
  at: number;
}

export interface PerfSnapshot {
  last?: TaskSample;
  samples: TaskSample[];
  fps: number;
  /** Frames since load that took longer than `FRAME_BUDGET_MS`. */
  longFrames: number;
  totalFrames: number;
}

const MAX_SAMPLES = 30;

const state: PerfSnapshot = {
  samples: [],
  fps: 0,
  longFrames: 0,
  totalFrames: 0,
};

const listeners = new Set<(snapshot: PerfSnapshot) => void>();
let notifyScheduled = 0;

function notify(): void {
  // Coalesce: never let the meter itself cost a frame.
  if (notifyScheduled !== 0) return;
  notifyScheduled = requestAnimationFrame(() => {
    notifyScheduled = 0;
    const snapshot: PerfSnapshot = { ...state, samples: state.samples.slice() };
    for (const listener of listeners) listener(snapshot);
  });
}

/**
 * Frame stats update 60+ times a second, but a readout a human is looking at
 * doesn't need to. Publishing every frame would re-render the HUD every frame
 * and make the instrument a measurable share of what it's measuring — so the
 * frame loop publishes at this interval instead. Task completions still
 * publish immediately; those are the numbers that matter.
 */
const FRAME_STATS_PUBLISH_MS = 250;
let lastFrameStatsPublish = 0;

function notifyFrameStats(now: number): void {
  if (now - lastFrameStatsPublish < FRAME_STATS_PUBLISH_MS) return;
  lastFrameStatsPublish = now;
  notify();
}

export function subscribeToPerf(listener: (snapshot: PerfSnapshot) => void): () => void {
  listeners.add(listener);
  listener({ ...state, samples: state.samples.slice() });
  return () => {
    listeners.delete(listener);
  };
}

// --- Task timing ------------------------------------------------------------

interface PendingTask {
  label: string;
  startedAt: number;
  dispatchMs: number;
  rows: number;
}

let pending: PendingTask | null = null;

/**
 * Times `dispatchFn` and leaves the task open until the grid reports its
 * refresh. Returns whatever `dispatchFn` returns.
 */
export function measureDispatch<T>(label: string, rows: number, dispatchFn: () => T): T {
  const startedAt = performance.now();
  const value = dispatchFn();
  const dispatchMs = performance.now() - startedAt;
  pending = { label, startedAt, dispatchMs, rows };
  return value;
}

/** Closes the open task with the time the grid spent refreshing. */
export function completeTask(refreshMs: number): void {
  if (pending === null) return;
  const sample: TaskSample = {
    label: pending.label,
    dispatchMs: pending.dispatchMs,
    refreshMs,
    totalMs: performance.now() - pending.startedAt,
    cpuMs: pending.dispatchMs + refreshMs,
    rows: pending.rows,
    at: Date.now(),
  };
  pending = null;

  state.last = sample;
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) state.samples.shift();
  notify();
}

export function resetSamples(): void {
  state.samples.length = 0;
  state.last = undefined;
  state.longFrames = 0;
  state.totalFrames = 0;
  notify();
}

// --- Frame health -----------------------------------------------------------

let frameLoopRunning = false;

export function startFrameMonitor(): () => void {
  if (frameLoopRunning) return () => {};
  frameLoopRunning = true;

  let previous = performance.now();
  let handle = requestAnimationFrame(function tick(now: number) {
    const delta = now - previous;
    previous = now;

    state.totalFrames++;
    // >1.5 frames of delta means at least one frame was missed. The slack keeps
    // ordinary timer jitter from being reported as a drop.
    if (delta > FRAME_BUDGET_MS * 1.5) state.longFrames++;
    // Smoothed, so the readout is legible rather than a blur of jitter.
    state.fps = delta > 0 ? state.fps * 0.9 + (1000 / delta) * 0.1 : state.fps;

    notifyFrameStats(now);
    handle = requestAnimationFrame(tick);
  });

  return () => {
    cancelAnimationFrame(handle);
    frameLoopRunning = false;
  };
}
