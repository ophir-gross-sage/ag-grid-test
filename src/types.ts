/**
 * The domain model, exactly as specified.
 *
 * These are the *public* shapes: what selectors hand back and what the rest of
 * the app reasons about. How the slices physically store 50,000 of them is an
 * implementation detail of each slice (see `store/resultsSlice.ts` for the
 * columnar layout and the reasoning behind it).
 */

export interface Aspect {
  id: string;
  value: string;
}

export interface MainEntity {
  id: string;
  /** Keyed by aspect id. At most `MAX_ASPECTS_PER_ENTITY` entries. */
  aspects: Record<string, Aspect>;
}

export interface Result {
  id: string;
  mainEntityId: string;
  /** Always exactly `RESULT_SIZE` numbers. */
  value: number[];
}

export interface ExtraData {
  id: string;
  mainEntityId: string;
  value: string;
}

// --- Domain constants -------------------------------------------------------

/** Number of main entities. */
export const ENTITY_COUNT = 50_000;

/** Size of the shared aspect pool. Every entity draws its aspects from this. */
export const ASPECT_POOL_SIZE = 5;

/** No main entity carries more than this many aspects. */
export const MAX_ASPECTS_PER_ENTITY = 3;

/** Fixed length of `Result.value`. */
export const RESULT_SIZE = 12;

// --- Input vs computed results ---------------------------------------------

/**
 * The calculation writes back into `Result.value`, so the 12 slots are split
 * into what a user supplies and what the engine derives.
 *
 * The split is what keeps the system acyclic. If the calculation both read and
 * wrote the same slots, every calculation would dirty its own inputs and
 * re-trigger itself; you would need a loop guard, and running the pass twice
 * would not give the same answer as running it once. Here the computed slots
 * are never read as inputs, so the calculation is idempotent and terminates by
 * construction.
 *
 * The cost is that R10-R12 are not editable — they are outputs, and an edit to
 * them would be overwritten by the next pass. See `docs/calculation-options.md`
 * for the alternative (all 12 editable, calculation writes tagged so they don't
 * re-trigger) and why it is harder to reason about.
 */
export const INPUT_RESULT_COLUMNS = 9;

/** R10 — composite of the 9 inputs, normalised against population baselines. */
export const COL_COMPOSITE = 9;
/** R11 — how far this entity's inputs spread around their own mean. */
export const COL_DISPERSION = 10;
/** R12 — percentile of R10 across all entities. Depends on every other row. */
export const COL_PERCENTILE = 11;

export const COMPUTED_RESULT_COLUMNS = [COL_COMPOSITE, COL_DISPERSION, COL_PERCENTILE];

export function isComputedResultColumn(col: number): boolean {
  return col >= INPUT_RESULT_COLUMNS;
}
