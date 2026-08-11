# Scheduling the calculation — options

## What is actually being decided

Only the **full pass** is in question.

| Pass | Trigger | Cost (measured) | Verdict |
| --- | --- | --- | --- |
| Incremental | one or a few rows dirty, baselines still valid | **0.1–1.3 ms** | Already optimal. Leave it inline. |
| Full | baselines drifted, or >0.5% of rows churned | **44–56 ms** | This is the problem. |

The incremental path is not worth scheduling. A pass costing 0.1ms gains nothing
from being deferred, sliced, or moved to a worker, and would pay scheduling
latency and coordination cost for the privilege. Every option below applies to
the full pass only, and every option keeps the incremental path exactly as it is.

## The baseline, measured

Chromium, production build, 50,000 rows. `syncRunner`, on the main thread:

- **44–56 ms** uninterrupted main-thread block per full pass
- **6 dropped frames** per bulk mutation, 2 of them over 50ms
- Nothing paints during it. Scrolling stops. The `calculating` status **cannot
  be shown at all** — `onStart` and `onOutcome` are dispatched inside the same
  task, so the spinner state never reaches a paint.

That last point is the one to sit with: with a synchronous full pass, the UI
cannot even tell the user it is busy.

## The two requirements are in tension

> keep the main thread unblocked … view changes and calculations as quickly as possible

Unblocking the thread means yielding it, and yielding costs wall-clock latency.
Anything that makes the calculation less disruptive makes it finish later. The
options differ mainly in *where they spend that tradeoff*, so the useful question
is not "which is fastest" but **"fast for whom"**:

- **Time to correct visible values** — what the user perceives.
- **Time to a globally consistent dataset** — what an export or a downstream
  consumer needs.

These can be separated, and Option E is the observation that they should be.

---

## Option A — Synchronous on the main thread *(current)*

Run it to completion, inline.

| | |
| --- | --- |
| Effort | none, already built |
| Time to visible values | ~50 ms |
| Time to consistent dataset | ~50 ms — **best possible** |
| Longest block | **44–56 ms** (3 frames) |
| Cancellable | no |
| Risk | none |

Genuinely the right answer when full passes are rare *and* user-initiated — a
brief freeze after an explicit "recalculate" click reads as "it's working". It is
the wrong answer when passes are triggered by ordinary editing, which is the case
here.

## Option B — Time-slice on the main thread

Run the full pass in chunks, yielding between them via `scheduler.postTask()`
(or `MessageChannel` for older targets — **not** `requestIdleCallback`, which can
starve indefinitely under load).

`calcEngine.runFullChunked()` already exists and already publishes partial
results per chunk, so this is a new runner and nothing else.

| | |
| --- | --- |
| Effort | **low** — ~50 lines, no data restructuring |
| Time to visible values | ~5 ms with Option E, else ~60–90 ms *(estimate)* |
| Time to consistent dataset | ~60–90 ms *(estimate)* — yield overhead + competing with render |
| Longest block | **bounded by chunk size** (~4 ms) *(estimate)* |
| Cancellable | **yes, trivially** — stop iterating |
| Risk | low |

Still consumes main-thread CPU, so it competes with scrolling — the calculation
gets slower while the user scrolls, and scrolling gets slightly less smooth.
It does not *unblock* the thread so much as **stop hogging it**, which for a
50ms job is usually enough.

Its quiet advantage: results appear progressively instead of all at once, which
serves "view changes as quickly as possible" directly rather than as a side
effect.

## Option C — Web Worker + `SharedArrayBuffer`

Move the kernel to a worker. The results buffer becomes shared memory, so there
is no copying at all.

| | |
| --- | --- |
| Effort | **high** |
| Time to visible values | ~50 ms, or ~5 ms with Option E *(estimate)* |
| Time to consistent dataset | ~50 ms *(estimate)* — full speed, nothing competing |
| Longest block | **<1 ms** — only the cell refresh |
| Cancellable | yes, with a shared abort flag |
| Risk | **moderate–high** |

The best steady-state answer, and the only one that leaves the main thread
genuinely free. Three costs, none of them small:

1. **`SharedArrayBuffer` requires cross-origin isolation** (COOP + COEP headers).
   That is a deployment constraint, and it breaks third-party embeds, some auth
   iframes, and analytics scripts. Confirm this is acceptable *before* choosing
   this route — it is the most common reason this option dies late.
2. **Concurrent mutation is now a real race.** The user can edit R1–R9 while the
   worker is reading them. Today that is impossible; with a worker it needs
   double-buffering, a generation counter, or `Atomics`. This is the actual
   engineering work, not the worker plumbing.
3. The store's buffers must be allocated as SAB-backed from the start.

## Option D — Web Worker + copied `ArrayBuffer`

Same, but post a copy of the inputs instead of sharing memory.

| | |
| --- | --- |
| Effort | moderate |
| Time to visible values | ~55 ms *(estimate)* |
| Time to consistent dataset | ~55 ms *(estimate)* |
| Longest block | **~1–3 ms** — the copy of 4.8 MB, each way |
| Cancellable | yes (ignore the stale reply) |
| Risk | low–moderate |

No COOP/COEP, and the copy makes the race in Option C disappear: the worker gets
a snapshot, so concurrent edits are simply applied to a newer generation.
Memory roughly doubles, and a copy is charged on every pass.

Note that *transferring* rather than copying does not work here — transfer moves
the buffer, and the grid reads it on every paint.

## Option E — Viewport-first ordering *(a modifier, not an alternative)*

Compute the ~30 visible rows first, publish them, then do the other 49,970.

Composable with B, C, or D, and it is the highest-leverage change available for
the stated primary requirement:

> **0.06% of the work covers 100% of what the user can see.**

Correct visible values in **~1–5 ms** instead of ~50ms, regardless of which
execution strategy sits underneath.

| | |
| --- | --- |
| Effort | **low** |
| Time to visible values | **~1–5 ms** *(estimate)* |
| Time to consistent dataset | unchanged |
| Risk | low |

The engine needs a viewport hint, which is a mild coupling — but it can be
pushed *in* (`engine.setPriorityRows(...)` called from the grid's scroll
handler) rather than pulled, so the engine still knows nothing about ag-grid or
React.

One caveat worth stating: rows are then briefly inconsistent with each other —
visible rows are computed against new baselines while off-screen rows still hold
old ones. Fine for display; **not** fine if something exports or aggregates
mid-pass.

## Option F — Optimistic incremental, then reconcile

Always run the cheap incremental pass immediately, show the result, and schedule
the full pass at lower priority. Mark values provisional until it lands.

| | |
| --- | --- |
| Effort | moderate |
| Time to visible values | **~1 ms** |
| Time to consistent dataset | deferred, possibly seconds |
| Risk | moderate — needs a "provisional" visual state |

Best perceived latency of any option. The cost is honesty: the grid shows values
that are approximately right and known to be so. That is a **product** decision,
not a technical one — worth surfacing before adopting.

---

## Recommendation

**Phase 1: E + B.** Viewport-first ordering on a time-sliced main-thread runner.

- Gets perceived latency to ~5ms, which is the stated primary requirement.
- Removes the dropped frames.
- No headers, no serialization, no concurrency, no data restructuring.
- Roughly a day's work, and `runFullChunked` is already written.
- Fully reversible: it is one runner swap in `main.tsx`.

**Phase 2: add C or D, if measurement says Phase 1 is not enough.** The reason to
defer is that a worker's benefit is bounded — it removes ~45ms of main-thread
*work*, but Option E has already removed ~45ms of main-thread *latency the user
can perceive*. Spending the concurrency budget before confirming the need is how
this kind of thing gets expensive.

Take the worker route earlier if any of these hold:
- Full passes fire continuously rather than per interaction.
- The real calculation is much heavier than 50ms (the kernel constant is one
  line, so this is easy to test — raise it and re-measure).
- The main thread already has other heavy work competing.

## What would sharpen this

Three things I could not determine from here, each of which moves the answer:

1. **How often does a full pass actually fire?** Once per user action, or
   continuously from a data feed? If it is continuous, B is not enough and C
   becomes the right first move rather than the second.
2. **Is cross-origin isolation acceptable in the real deployment?** If not, C is
   off the table entirely and the choice is B or D.
3. **May the grid show provisional values?** If yes, F is available and is
   strictly the fastest perceived option. If no, F is out regardless of cost.

I can prototype the recommended runner and measure it against the baseline in
this repo — say the word and I will, rather than leaving B's numbers as
estimates.
