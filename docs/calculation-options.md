# Scheduling the calculation — options

## The constraint that determines everything

**The calculation cannot predict which rows it will affect, or what it will
cost, until it has run.**

Most runs settle quickly. Occasionally one cascades across the whole population.
The same trigger produces both, and nothing upstream can tell them apart in
advance. Measured, production build, 50,000 rows:

| Trigger | Outcome | Longest block | Frequency |
| --- | --- | --- | --- |
| Single cell edit | local | **1.0–3.3 ms** (median 2.1) | 12 / 14 |
| Single cell edit | **cascaded** | **46.1 ms and 67.1 ms** | 2 / 14 |
| Bulk 1,000 rows | cascaded | 51–58 ms | always |

Twelve cheap runs and two expensive ones, from *identically shaped triggers*.
That is the whole problem in one line.

Three consequences, and they eliminate more options than they leave:

1. **You cannot route by cost.** "Run cheap ones inline, expensive ones
   elsewhere" is unimplementable — by the time you know which you have, you have
   already paid for it.
2. **You cannot compute the visible rows first.** Prioritising the ~30 rows on
   screen requires knowing they are in the affected set. You don't, and often
   they aren't: a run that visited 1,465 rows changed exactly 1.
3. **Every run must be treated as though it will be the 50ms one.** There is no
   fast path to protect, only a tail to bound.

Consequence 2 is worth dwelling on, because viewport-first ordering is the
obvious idea and it does not survive here. It was my recommendation before this
constraint was clear; it is off the table now.

## The baseline, measured

`syncRunner`, main thread, run to completion:

- **1–3 ms** for the common case — genuinely optimal, nothing to improve
- **46–67 ms** on a cascade
- **6 dropped frames** per bulk mutation, 5 of them over 50ms
- The `calculating` status **cannot be shown at all** — `onStart` and
  `onOutcome` land in the same task, so it never reaches a paint

The common case needs no help. The entire decision is about the tail.

## The one unknown that splits the option space

**Can the real calculation be interrupted mid-run and resumed?**

Everything hinges on it:

- **If yes** → main-thread time-slicing (B) is available: no data movement, no
  concurrency, no headers.
- **If no** → every main-thread option is dead, because a 50ms opaque call
  cannot be made to yield from outside. The only remaining move is to run it
  somewhere that isn't the main thread (C/D).

`calculateChunked()` in the kernel implements the interruptible form so the
option can be measured rather than assumed. But note what interruptibility still
does **not** buy here: the percentile phase needs every composite before any
single row's final value is known, so two thirds of a cascade produces nothing
displayable. **Yielding buys responsiveness, not earlier answers.**

---

## Option A — Synchronous *(current)*

| | |
| --- | --- |
| Effort | none |
| Common case | **1–3 ms — optimal** |
| Tail | 46–67 ms block, 5–6 dropped frames |
| Cancellable | no |

Right for the common case, indefensible for the tail. Keep as the fallback path.

## Option B — Time-slice on the main thread

Chunk the run, yield via `scheduler.postTask()` (or `MessageChannel`; **not**
`requestIdleCallback`, which starves under load).

| | |
| --- | --- |
| Effort | **low** — a runner, ~60 lines; `calculateChunked` exists |
| Common case | ~1–4 ms *(estimate)* — yield overhead on work that was already cheap |
| Tail | **block bounded to chunk size (~4 ms)**; wall clock stretches to ~70–100 ms *(estimate)* |
| Cancellable | **yes, trivially** |
| Risk | low |
| Requires | the calculation to be interruptible |

Does not unblock the thread so much as **stop hogging it**. The tail gets
*longer* in wall-clock terms while becoming invisible — which is the correct
trade when the alternative is a 60ms freeze.

Its real weakness: it still spends main-thread CPU, so a cascade during
scrolling makes both worse.

## Option C — Web Worker + `SharedArrayBuffer`

| | |
| --- | --- |
| Effort | **high** |
| Common case | ~2–4 ms *(estimate)* — round-trip overhead added to cheap work |
| Tail | **<1 ms main thread**; ~50 ms off-thread |
| Cancellable | yes, via a shared abort flag |
| Risk | **moderate–high** |
| Requires | cross-origin isolation; concurrency handling |

The only option that leaves the main thread genuinely free, and the only one
that works if the calculation cannot be interrupted. Three costs:

1. **COOP/COEP headers.** Breaks third-party embeds, some auth iframes,
   analytics. Confirm before committing — this is the most common reason this
   option dies late.
2. **Concurrent mutation becomes a real race.** The user can edit R1–R9 while
   the worker reads them. Impossible today. Needs double-buffering, a generation
   counter, or `Atomics`. **This is the actual work**, not the worker plumbing.
3. Store buffers must be SAB-backed from allocation.

## Option D — Web Worker + copied `ArrayBuffer`

| | |
| --- | --- |
| Effort | moderate |
| Common case | ~3–6 ms *(estimate)* — copy dominates cheap runs |
| Tail | **~1–3 ms main thread** (the copy); ~50 ms off-thread |
| Cancellable | yes — ignore the stale reply |
| Risk | low–moderate |

No headers, and the copy makes C's race vanish: the worker gets a snapshot, so
concurrent edits simply belong to a newer generation. Costs ~1–3 ms of copying
per run and roughly doubles memory.

Transferring instead of copying does not work — transfer *moves* the buffer, and
the grid reads it every paint.

Note the asymmetry this creates: a fixed ~2ms tax on the 12 cheap runs to remove
the 2 expensive ones. At the measured ratio that is clearly worth it, but it is
a real cost, not a free win.

## Option E — Hybrid: speculative inline with a deadline

Start on the main thread. If the run hasn't finished within ~5ms, abandon it and
restart on a worker.

| | |
| --- | --- |
| Effort | high — needs both B and D built |
| Common case | **1–3 ms — optimal, no overhead** |
| Tail | ~5 ms wasted, then off-thread |
| Requires | interruptibility **and** a worker |

The only option that gets the common case *and* the tail right, because it is
the only one that makes the cheap/expensive decision **after** the information
exists. It pays for that with both implementations plus the abandon-and-restart
logic, and wastes ~5ms on every cascade.

Worth it only if the common case is latency-critical *and* cascades are frequent
enough to matter.

## Option F — Deduplicate and coalesce harder

Already partly present (rAF coalescing of bursts). Could extend to: drop
superseded runs, skip recalculation while a cell editor is open.

Cheap, complements everything else, solves nothing on its own. Worth doing
regardless of which option is chosen — at the measured 50ms tail, *not* running a
calculation is by far the cheapest way to make it fast.

---

## Recommendation

**If the calculation can be interrupted: B, then re-measure.**
Lowest effort, no headers, no concurrency, no data movement, trivially
reversible. It bounds the tail to ~4ms blocks, which is the stated requirement,
and it costs about a day. Go to D or E only if measurement shows the stretched
wall-clock hurts.

**If it cannot be interrupted: D.**
Not C. D gets you the same main-thread relief without cross-origin isolation and
without the concurrent-mutation race, which is the expensive part of C. Adopt C
over D only if the ~2ms copy per run is measurably a problem *and* isolation is
confirmed acceptable — in that order.

**Do F regardless.** It is nearly free.

The honest summary: the common case is already optimal and no option improves
it — every one of them makes it slightly worse. This is entirely a decision
about how to pay for the tail.

## What would sharpen this

1. **Can the real calculation yield?** Decides B vs D and therefore the whole
   plan. Nothing else matters as much.
2. **How often does a cascade actually fire?** The simulation says ~1 in 7 for
   single edits; that ratio drives whether a fixed per-run tax (D) beats a
   variable one (B).
3. **Is cross-origin isolation acceptable?** Only relevant if C is being
   considered over D.
4. **Can a cascade be superseded?** If a newer edit arrives mid-cascade, is
   abandoning the in-flight run correct, or must every run complete? Cancellable
   runs make B and D substantially more effective.

I can build the recommended runner behind the existing `CalcRunner` seam and
measure it against this baseline — B's and D's numbers here are estimates, and
they don't have to stay that way.
