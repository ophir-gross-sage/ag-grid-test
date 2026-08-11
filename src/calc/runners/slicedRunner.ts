import type { CalcRunnerFactory } from '../calcTypes';

/**
 * Runs the calculation on the main thread in short slices, yielding between
 * them so the browser can paint.
 *
 * The calculation stays exactly where it is — same thread, same code, same
 * profile, visible to the same devtools. Nothing is hidden behind a worker
 * boundary where "it works well" can quietly become "we stopped looking". If
 * the kernel gets slower, this gets visibly worse, which is the point.
 *
 * ---------------------------------------------------------------------------
 * Budgeting by time, not by rows
 *
 * The slice budget is a duration, and the kernel checks the clock. A row-count
 * budget would be calibrated on whatever machine the developer used and would
 * silently stop working on slower hardware — 4,000 rows is a few milliseconds
 * on a fast laptop and five times that on a low-end one. Since the whole point
 * is protecting customers whose machines are slower than ours, the budget has
 * to be expressed in the unit we actually care about.
 */

/**
 * Main-thread time per slice.
 *
 * Under a 16.7ms frame this leaves room for the grid to refresh, React to do
 * whatever it needs, and the browser to composite. Deliberately not larger:
 * the goal is not to finish sooner, it is to never be the reason a frame is
 * missed.
 */
const SLICE_BUDGET_MS = 4;

/**
 * Yields to the browser between slices.
 *
 * `scheduler.postTask` at 'user-visible' priority is the right primitive where
 * it exists — it is a real task, so rendering can interleave, and it is
 * prioritised against other work rather than running whenever the browser feels
 * idle.
 *
 * `requestIdleCallback` is deliberately *not* used: under sustained load it can
 * be starved indefinitely, which turns a 50ms calculation into one that never
 * finishes. `MessageChannel` is the fallback because `setTimeout(0)` is clamped
 * to ~4ms after nesting, which would roughly halve throughput.
 */
type Yielder = (resume: () => void) => () => void;

const postTaskYield: Yielder | null =
  typeof globalThis.scheduler?.postTask === 'function'
    ? (resume) => {
        const controller = new AbortController();
        globalThis.scheduler
          .postTask(resume, { priority: 'user-visible', signal: controller.signal })
          .catch(() => {
            /* aborted — expected on cancel */
          });
        return () => controller.abort();
      }
    : null;

const messageChannelYield: Yielder = (resume) => {
  const channel = new MessageChannel();
  let cancelled = false;
  channel.port1.onmessage = () => {
    if (!cancelled) resume();
  };
  channel.port2.postMessage(null);
  return () => {
    cancelled = true;
    channel.port1.onmessage = null;
  };
};

const yieldToBrowser: Yielder = postTaskYield ?? messageChannelYield;

export const createSlicedRunner: CalcRunnerFactory = (host) => {
  let cancelPending: (() => void) | null = null;
  let running = false;

  /** Accumulated across slices — the sum is what competes for the frame budget. */
  let blockingMs = 0;
  let longestBlockMs = 0;
  let requestedAt = 0;

  function finish(): void {
    running = false;
    cancelPending = null;
    const result = host.work.outcome();
    host.onOutcome({
      cascaded: result.cascaded,
      latencyMs: performance.now() - requestedAt,
      blockingMs,
      longestBlockMs,
      changedRows: result.changed,
      visitedRows: result.visited,
    });
  }

  function step(): void {
    cancelPending = null;
    const startedAt = performance.now();
    const done = host.work.advance(startedAt + SLICE_BUDGET_MS);
    const sliceMs = performance.now() - startedAt;

    blockingMs += sliceMs;
    if (sliceMs > longestBlockMs) longestBlockMs = sliceMs;

    if (done) {
      finish();
      return;
    }
    cancelPending = yieldToBrowser(step);
  }

  return {
    id: 'sliced',
    label: `Time-sliced (${SLICE_BUDGET_MS}ms)`,

    submit(request) {
      // A run already in flight is superseded; the engine folds the pending
      // seeds into the next one rather than interleaving two runs over the same
      // buffers.
      if (running) this.cancel();

      requestedAt = request.requestedAt;
      blockingMs = 0;
      longestBlockMs = 0;
      running = true;

      host.onStart();
      host.work.begin(request.seeds, request.seedCount);
      step();
    },

    cancel() {
      cancelPending?.();
      cancelPending = null;
      running = false;
    },

    dispose() {
      this.cancel();
    },
  };
};
