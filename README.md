# Entity Grid

50,000 main entities in an ag-grid, with Redux as the single source of truth for
every cell, engineered so that any change lands inside one 60fps frame.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
npm run preview    # serve the production build
```

## What's on the page

One grid, 18 columns:

| Columns | Source |
| --- | --- |
| `Extra Data` (pinned) | `extraData` slice |
| `Region · Tier · Channel · Segment · Owner` | the 5 shared aspects; blank where an entity doesn't carry that aspect |
| `R1 … R12` | the 12 numbers of the entity's `Result` — **editable** |

A row *is* a `MainEntity`. Double-click any `R` cell to edit it; the value is
written to Redux and read back from there.

Three buttons:

- **Mutate random entity** — picks a random main entity id anywhere in the
  50,000 and rewrites the `Result` that references it. Usually off-screen; the
  status line links to it.
- **Mutate entity on screen** — same, restricted to a currently visible row, so
  you see the changed cells flash.
- **Stress: 1,000 entities** — 1,000 dispatches rewriting 12,000 numbers, to
  show the design holds under a burst rather than a single click.

The HUD in the top right measures every change live.

## The data model

The four slices carry the interfaces as specified:

```ts
interface Aspect     { id: string; value: string }
interface MainEntity { id: string; aspects: Record<string, Aspect> }
interface Result     { id: string; mainEntityId: string; value: number[] }  // always 12
interface ExtraData  { id: string; mainEntityId: string; value: string }
```

**Reading of "shared aspect pool":** the pool of 5 defines the *vocabulary* —
which aspect ids exist, and therefore which aspect columns the grid has. Each
main entity carries at most 3 of them with its own value. The alternative
reading (entities share the aspect *objects* by reference) would mean every
entity holding aspect `Region` shows the same value, which makes the aspect
columns carry no information. The pool lives in `aspectsSlice`; per-entity
values live in `mainEntitiesSlice`.

## How it stays inside the frame

Four decisions do the work. Each is a comment at its own call site; this is the
summary.

### 1. Row data never changes

`GRID_ROWS` is 50,000 objects of `{ id, row }`, built once at module load and
handed to ag-grid once. It holds no values.

Every cell value comes from a `valueGetter` that reads `store.getState()`
directly. Because ag-grid virtualises rows, those getters run for the ~30
visible rows only — about 540 O(1) array reads per refresh.

The alternative, denormalising Redux state into row objects, means every change
rebuilds an array ag-grid must re-evaluate across all 50,000 rows. That is the
usual reason large Redux grids are slow.

### 2. React renders the grid once

Nothing in the render path subscribes to result data. `useSelector` over cell
values would re-render the component owning 50,000 rows on every keystroke.
Instead the components read the store non-reactively (`useStore`), and updates
are applied to the grid imperatively.

### 3. Reducers report which row they touched

`gridSync` middleware reads the row index off each mutating action and collects
it. The grid subscribes and refreshes exactly those rows — no diffing the store
to discover what moved. Refreshing a row that isn't currently rendered does no
DOM work at all.

The batch is flushed on one `requestAnimationFrame`, so a burst of 1,000
dispatches produces one refresh on the next frame rather than 1,000 refreshes.

### 4. Result values live in a flat `Float64Array`

This is the deliberate departure from textbook Redux, and the reason for the
`revision` counters.

A conventional normalised slice stores `Record<string, Result>`, so an edit
produces `{...entities}` — copying 50,000 keys on every keystroke, plus a new
`Result` and a new 12-element array. The copy alone is a few milliseconds, a
meaningful share of a 16.7ms frame in which the grid still has to lay out and
paint, and it gets worse as the dataset grows.

Storing the numbers as one `Float64Array(50_000 * 12)` and mutating in place
makes a write O(1) and allocation-free — the same cost at 50,000 rows as at 50 —
and cuts result memory from roughly 40MB of objects to 4.8MB contiguous.
`mainEntitiesSlice` and `extraDataSlice` use the same columnar layout.

**The tradeoffs, explicitly:**

- Value buffers aren't referentially immutable, so change detection keys off the
  `revision` counter instead of object identity. Anything subscribing to result
  data must select `revision`, not the buffer.
- Redux DevTools time-travel over result values is given up. DevTools is off
  regardless (`store/index.ts`) — serialising a 50,000-row snapshot per action
  is by itself the most expensive thing that could happen here.
- RTK's `serializableCheck` and `immutableCheck` are off, and immer's
  `autoFreeze` with them. All three walk the whole state tree per action.

`Result` / `MainEntity` / `ExtraData` objects remain the public currency:
`store/selectors.ts` materialises them on demand, for one entity at a time. The
grid uses the allocation-free `read*` tier instead.

## Measured

Chromium, production build, 50,000 rows, 1600×900. Numbers from
the HUD and a scripted run; reproduce them by clicking the buttons and watching
the readout.

| Action | Reducer | Grid refresh | CPU total | Frame budget |
| --- | --- | --- | --- | --- |
| Inline cell edit | ~0.0 ms | ~0.2 ms | **~0.2 ms** | 1% |
| Mutate random entity | ~0.0 ms | ~0.2 ms | **~0.2 ms** | 1% |
| Mutate on-screen entity | ~0.1 ms | ~0.2 ms | **~0.3 ms** | 2% |
| Stress: 1,000 entities (12,000 numbers) | ~2.0 ms | ~0.8 ms | **~2.8 ms** | 17% |

Continuous wheel-scrolling across the 50,000 rows: median frame 8.3ms, p95
16.6ms, **0 dropped frames** over 250 frames.

A note on the HUD's two numbers. **cpu** is `reducer + grid refresh` — the
main-thread time the change actually consumes, and the figure that has to stay
under budget. **end-to-end** additionally includes idling until the next
animation frame, so it sits around 5-6ms; that is latency, not cost, and it is
what the rAF batching buys in exchange.

## Layout

```
src/
  types.ts                  the four interfaces + domain constants
  store/
    dataset.ts              one-pass generator; the columnar arrays every slice shares
    aspectsSlice.ts         the shared pool of 5
    mainEntitiesSlice.ts    50k entities + their aspect slots
    resultsSlice.ts         the hot slice: flat Float64Array, in-place writes
    extraDataSlice.ts       50k extra-data records
    gridSync.ts             middleware: which rows changed -> rAF-batched notifications
    selectors.ts            read* (hot, allocation-free) and select* (materialising)
    index.ts, hooks.ts      store config and typed hooks
  calc/
    calcKernel.ts           pure arithmetic + the resumable run state machine
    calcEngine.ts           orchestration, coalescing, publishing
    calcTypes.ts            the CalcRunner seam
    calcMiddleware.ts       store changes -> calculation triggers
    runners/                sync (server path) and time-sliced (browser path)
  components/
    gridRows.ts             the immutable row array
    EntityGrid.tsx          column defs, valueGetters/valueSetters, batch refresh
    Toolbar.tsx             the mutation buttons
    PerfHud.tsx             live frame-budget readout
  perf/perfMonitor.ts       task timings + frame-health loop
```

## The calculation

`R1–R9` are user inputs; `R10–R12` are computed by the calculation engine and
written back into the same results. Editing an input triggers a run.

The engine cannot predict what a run will do. Most settle in 1–3ms touching a few
thousand rows; some cascade across all 50,000 and cost 50ms+. Identical triggers
produce both, so every run is treated as though it will be the expensive one.

It runs **on the main thread, in 4ms time-sliced chunks**, yielding between them
so the browser can paint. Not on a worker — the calculation is the product, it
runs on the server too, and hiding its cost behind a thread boundary would
remove the pressure that keeps it fast.

| CPU throttle | Synchronous | Time-sliced |
| --- | --- | --- |
| 1× | 64.7 ms block | **4.2 ms** |
| 4× | 275 ms block | **5.1 ms** |
| 6× | **408 ms block** | **6.0 ms** |

The budget is a *duration*, not a row count, which is why it holds across a 6×
hardware range — a fixed 4,000-row chunk would have gone 4 → 24ms and broken on
exactly the machines it was meant to protect.

Both runners are selectable at runtime from the calculation panel.
`docs/calculation-options.md` covers the design decisions and what's still open.

## Where this would need more work

- **Sorting and filtering are off.** Both would need the comparator to read
  through the store, and sorting 50,000 rows is itself a multi-frame operation
  that wants a different approach (pre-computed index, or the server-side row
  model).
- **The dataset is generated in-process at load.** A real backend means the
  server-side row model, at which point row-index-keyed columnar storage needs
  to become page-keyed.
- **`AllCommunityModule` is registered** for convenience. Registering only the
  modules actually used would cut the 1.1MB grid chunk substantially.
