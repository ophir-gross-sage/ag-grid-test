import {
  ASPECT_POOL_SIZE,
  ENTITY_COUNT,
  MAX_ASPECTS_PER_ENTITY,
  RESULT_SIZE,
} from '../types';

/**
 * Generates the whole dataset in one pass.
 *
 * All four slices are seeded from here so that their cross-references line up
 * by construction: row `i` is main entity `ids[i]`, its result is `resultIds[i]`
 * and its extra data is `extraIds[i]`. That shared row index is what lets every
 * lookup in the app be O(1) array indexing instead of a hash lookup.
 *
 * Layout is columnar (parallel typed arrays) rather than 50k object graphs:
 *   - 50,000 `Result` objects each holding a 12-element `number[]` costs roughly
 *     40MB and 100k allocations. The same numbers in one `Float64Array` cost
 *     4.8MB in a single contiguous allocation, and reading a cell becomes
 *     `buffer[row * 12 + col]` — no property access, no bounds-crossing.
 *   - It also makes edits allocation-free, which is what keeps a write inside
 *     the frame budget (see `resultsSlice`).
 *
 * The `Result` / `MainEntity` / `ExtraData` shapes are still what selectors
 * return; they're materialised on demand, only for the handful of rows anyone
 * actually asks about.
 */

/** Deterministic PRNG so every reload produces the same grid. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-aspect value vocabularies. Values are interned, so 150k slots share ~25 strings. */
const ASPECT_VOCABULARY: readonly (readonly string[])[] = [
  ['EMEA', 'APAC', 'LATAM', 'NA', 'ANZ'],
  ['Gold', 'Silver', 'Bronze', 'Platinum'],
  ['Direct', 'Partner', 'Online', 'Retail'],
  ['SMB', 'Mid-Market', 'Enterprise'],
  ['ops', 'finance', 'growth', 'platform', 'research'],
];

const EXTRA_PREFIXES = [
  'batch',
  'ingest',
  'replay',
  'backfill',
  'stream',
  'snapshot',
] as const;

export interface Dataset {
  /** Main entity ids, indexed by row. */
  entityIds: string[];
  /** row index -> entity id. */
  entityIndexById: Map<string, number>;

  /**
   * Aspect assignments, `MAX_ASPECTS_PER_ENTITY` slots per row.
   * Holds the aspect's index in the shared pool, or -1 for an unused slot.
   */
  aspectSlotPoolIndex: Int8Array;
  /** Value for the corresponding slot in `aspectSlotPoolIndex` (interned). */
  aspectSlotValue: string[];

  /** Result ids, indexed by row (result `i` belongs to entity `i`). */
  resultIds: string[];
  resultIndexById: Map<string, number>;
  /** Flat `ENTITY_COUNT * RESULT_SIZE` matrix; cell = `resultValues[row * RESULT_SIZE + col]`. */
  resultValues: Float64Array;

  /** Extra-data ids, indexed by row. */
  extraIds: string[];
  extraIndexById: Map<string, number>;
  extraValues: string[];
}

export function generateDataset(seed = 0xa9c1e3): Dataset {
  const rand = mulberry32(seed);

  const entityIds = new Array<string>(ENTITY_COUNT);
  const entityIndexById = new Map<string, number>();

  const aspectSlotPoolIndex = new Int8Array(ENTITY_COUNT * MAX_ASPECTS_PER_ENTITY);
  const aspectSlotValue = new Array<string>(ENTITY_COUNT * MAX_ASPECTS_PER_ENTITY);

  const resultIds = new Array<string>(ENTITY_COUNT);
  const resultIndexById = new Map<string, number>();
  const resultValues = new Float64Array(ENTITY_COUNT * RESULT_SIZE);

  const extraIds = new Array<string>(ENTITY_COUNT);
  const extraIndexById = new Map<string, number>();
  const extraValues = new Array<string>(ENTITY_COUNT);

  // Scratch buffer for picking a subset of the pool without allocating per row.
  const pool = new Int8Array(ASPECT_POOL_SIZE);

  for (let row = 0; row < ENTITY_COUNT; row++) {
    const entityId = `me-${row}`;
    entityIds[row] = entityId;
    entityIndexById.set(entityId, row);

    // --- aspects: pick 1..MAX distinct pool entries via partial Fisher-Yates ---
    for (let i = 0; i < ASPECT_POOL_SIZE; i++) pool[i] = i;
    const take = 1 + Math.floor(rand() * MAX_ASPECTS_PER_ENTITY);
    const slotBase = row * MAX_ASPECTS_PER_ENTITY;
    for (let slot = 0; slot < MAX_ASPECTS_PER_ENTITY; slot++) {
      if (slot >= take) {
        aspectSlotPoolIndex[slotBase + slot] = -1;
        aspectSlotValue[slotBase + slot] = '';
        continue;
      }
      const pick = slot + Math.floor(rand() * (ASPECT_POOL_SIZE - slot));
      const poolIndex = pool[pick];
      pool[pick] = pool[slot];
      pool[slot] = poolIndex;

      const vocab = ASPECT_VOCABULARY[poolIndex];
      aspectSlotPoolIndex[slotBase + slot] = poolIndex;
      aspectSlotValue[slotBase + slot] = vocab[Math.floor(rand() * vocab.length)];
    }

    // --- result: 12 numbers ---
    const resultId = `res-${row}`;
    resultIds[row] = resultId;
    resultIndexById.set(resultId, row);
    const valueBase = row * RESULT_SIZE;
    for (let col = 0; col < RESULT_SIZE; col++) {
      resultValues[valueBase + col] = Math.round(rand() * 10000) / 100;
    }

    // --- extra data ---
    const extraId = `xd-${row}`;
    extraIds[row] = extraId;
    extraIndexById.set(extraId, row);
    const prefix = EXTRA_PREFIXES[Math.floor(rand() * EXTRA_PREFIXES.length)];
    extraValues[row] = `${prefix}-${(row % 9973).toString(36).padStart(3, '0')}`;
  }

  return {
    entityIds,
    entityIndexById,
    aspectSlotPoolIndex,
    aspectSlotValue,
    resultIds,
    resultIndexById,
    resultValues,
    extraIds,
    extraIndexById,
    extraValues,
  };
}

/** Built once at module load and split across the four slices below. */
export const DATASET = generateDataset();
