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
