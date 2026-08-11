import type { CalcScope } from '../store/calcSlice';

/**
 * The seam between *what* is calculated and *when* it runs.
 *
 * The engine decides scope and applies results; a `CalcRunner` decides how the
 * work reaches the CPU — all at once, sliced across frames, or off-thread. Every
 * option in `docs/calculation-options.md` is a different implementation of this
 * one interface, which is why picking a route is a swap in `calcEngine.ts`
 * rather than a rewrite.
 */

export interface CalcRequest {
  scope: Exclude<CalcScope, 'none'>;
  /** Rows to recompute for an incremental pass. Ignored when scope is 'full'. */
  rows: Int32Array;
  rowCount: number;
  /** When the work became necessary. Latency is measured from here, not from start of execution. */
  requestedAt: number;
  /** Population drift that triggered a full pass, for reporting. */
  drift: number;
}

export interface CalcOutcome {
  scope: CalcScope;
  /** Requested-to-applied wall clock. What the user actually waits. */
  latencyMs: number;
  /** Total main-thread time consumed. */
  blockingMs: number;
  /** Longest single uninterrupted main-thread block. The number that decides whether frames drop. */
  longestBlockMs: number;
  changedRows: number;
  visitedRows: number;
  drift: number;
}

/**
 * The work a runner can perform, already bound to the data. Runners call these;
 * they never look at the store themselves.
 */
export interface CalcWork {
  /**
   * Recompute the given rows using the cached baselines.
   * Cheap and always safe to run inline. Returns rows actually changed.
   */
  runIncremental(rows: Int32Array, rowCount: number): number;

  /**
   * Recompute baselines and every row. This is the ~50ms pass.
   * Returns rows actually changed.
   */
  runFull(): number;

  /**
   * A full pass expressed as resumable chunks, for runners that need to yield.
   *
   * Present on the interface from the start even though the synchronous runner
   * ignores it: a kernel that cannot be interrupted forecloses half the options
   * below, and discovering that after choosing one is the expensive way to find
   * out.
   */
  runFullChunked(): Iterator<ChunkProgress, number>;
}

export interface ChunkProgress {
  /** Rows completed so far. */
  done: number;
  total: number;
}

export interface CalcRunner {
  readonly id: string;
  readonly label: string;
  /** Submit work. The runner owns scheduling and calls `onOutcome` when results are applied. */
  submit(request: CalcRequest): void;
  /** Abandon in-flight work because newer input superseded it. */
  cancel(): void;
  dispose(): void;
}

export interface CalcRunnerHost {
  work: CalcWork;
  onStart(): void;
  onOutcome(outcome: CalcOutcome): void;
}

export type CalcRunnerFactory = (host: CalcRunnerHost) => CalcRunner;
