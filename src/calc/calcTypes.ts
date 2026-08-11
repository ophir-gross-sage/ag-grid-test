import type { CalcResult } from './calcKernel';

/**
 * The seam between *what* is calculated and *when* it runs.
 *
 * The engine collects seeds and publishes outcomes; a `CalcRunner` decides how
 * the work reaches the CPU — all at once, sliced across frames, or off-thread.
 * Every option in `docs/calculation-options.md` is a different implementation of
 * this one interface, which is why picking a route is a swap in `main.tsx`
 * rather than a rewrite.
 */

export interface CalcRequest {
  /** Rows whose inputs changed. What the calculation does with them is its own business. */
  seeds: Int32Array;
  seedCount: number;
  /**
   * When the work became necessary. Latency is measured from here rather than
   * from the start of execution, because time spent queued is time the user
   * spends looking at stale values.
   */
  requestedAt: number;
}

export interface CalcOutcome {
  /**
   * Whether the run ended up recomputing the whole population.
   *
   * An outcome, not a request. Nothing upstream chose this or could have
   * predicted it.
   */
  cascaded: boolean;
  /** Requested-to-applied wall clock. What the user actually waits. */
  latencyMs: number;
  /** Total main-thread time consumed. */
  blockingMs: number;
  /** Longest single uninterrupted main-thread block. The number that decides whether frames drop. */
  longestBlockMs: number;
  changedRows: number;
  visitedRows: number;
}

/**
 * The work a runner can perform, already bound to the data. Runners call these;
 * they never look at the store themselves.
 */
export interface CalcWork {
  /** Arm a run. Does no work. */
  begin(seeds: Int32Array, seedCount: number): void;

  /**
   * Advance the armed run until `deadlineMs`. Returns `true` when complete, and
   * publishes any rows that changed since the last call.
   *
   * `Infinity` runs it straight through — that is what the synchronous runner
   * and the server both do.
   */
  advance(deadlineMs: number): boolean;

  /** Result of the run that just completed. */
  outcome(): CalcResult;
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
