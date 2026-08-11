# Scheduling the calculation

## Position

The calculation is the product, not an implementation detail. It runs in this
frontend and on the server, it will be optimised repeatedly, and its cost must
stay visible while that happens.

That rules out moving it to a worker as the *first* move. A worker makes the
symptom disappear without making the calculation any faster, and it removes the
pressure that keeps it fast — "it works well" starts meaning "we stopped
looking". Everything below keeps the calculation on the main thread, in the same
profiler, in the same flame chart.

**Implemented:** time-slicing (chunking with yields) + coalescing.
**Not implemented, deliberately:** workers, in either form.

## What the calculation does that makes this hard

It cannot predict which rows it will affect or what it will cost until it has
run. Measured, unthrottled:

| Trigger | Outcome | Longest block | Frequency |
| --- | --- | --- | --- |
| Single cell edit | local | 1.0–3.3 ms | 12 / 14 |
| Single cell edit | **cascaded** | **46–67 ms** | 2 / 14 |
| Bulk 1,000 rows | cascaded | 51–58 ms | always |

Identically shaped triggers, both outcomes. So there is no cheap path to detect
and protect — every run has to be treated as though it will be the expensive one.

## Measured across hardware

Chrome CPU throttling, 5 cascades per run, production build. Throttling is a
wall-clock multiplier on script execution; 4–6× is a reasonable proxy for a
low-end laptop against an M2 Max.

| CPU | Runner | Worst block | Latency | Frames >50ms | Frames >100ms |
| --- | --- | --- | --- | --- | --- |
| 1× | synchronous | 64.7 ms | 56.5 ms | 3 | 0 |
| 1× | **sliced** | **4.2 ms** | 83.7 ms | **0** | 0 |
| 4× | synchronous | 275 ms | 232 ms | 5 | **5** |
| 4× | **sliced** | **5.1 ms** | 262.8 ms | 1 | **0** |
| 6× | synchronous | **408 ms** | 346 ms | 5 | **5** |
| 6× | **sliced** | **6.0 ms** | 450.7 ms | 1 | **0** |

Two things this makes clear that a fast dev machine hides:

1. **The synchronous freeze scales with the machine.** 65ms here, **408ms** at
   6×. Nearly half a second of dead UI per cascade, on the hardware most
   customers are using.
2. **The sliced budget barely moves: 4.2 → 5.1 → 6.0 ms.** That is the design
   working — see below.

The cost is latency: +48% at 1×, +30% at 6×. Wall clock gets *longer* while the
freeze disappears. That is the trade, and at these numbers it is clearly right —
450ms of responsive UI beats 350ms of frozen UI.

The residual "1 frame >50ms" at 4×/6× is **not** the calculation: the worst
*block* in those runs was 6.0ms. It is the grid repainting a bulk change, and it
is where to look next if this needs to go further.

## The three decisions that carry it

### 1. Budget by time, not by rows

The slice budget is a duration (`SLICE_BUDGET_MS = 4`), and the kernel checks the
clock as it goes.

A row-count budget would have been calibrated on the development machine and
would silently stop working everywhere else — 4,000 rows is ~4ms on an M2 Max
and ~25ms at 6×. It would break precisely on the hardware it exists to protect.
The measured 4.2 → 6.0ms across a 6× range is a time budget self-calibrating;
a row budget would have gone 4 → 24ms.

The small overshoot above 4ms is deadline-check granularity: the clock is read
every 256 rows, and on a slow machine those 256 rows take longer. Tunable if it
ever matters; 6ms is still comfortably inside a frame.

### 2. A resumable cursor, not a generator

`advanceRun()` is a phase-and-cursor state machine. All the position of a run
lives in a `CalcRun` object instead of on the call stack.

Generators were the obvious alternative and were rejected on the grounds that
matter most here: `yield` inside a hot numeric loop costs real throughput, and
**this kernel runs on the server too**, where nothing yields and every cycle
counts. With a cursor, the inner loops are byte-identical to a straight-line
implementation, and the only overhead is one predictable-branch comparison per
256 rows.

The server path is `advanceRun(..., Infinity)` — one call, runs to completion,
no yields, no scheduling. `calculate()` is a three-line wrapper around exactly
that, so there is one implementation of the arithmetic and the two schedules
cannot drift apart.

**Verified:** sliced and synchronous execution produce identical values across
sampled rows, and a re-run over unchanged inputs still changes 0 of 50,000 rows.

### 3. Coalescing, because the cheapest calculation is the one that never runs

Two rules, both in `calcEngine`:

- Bursts collapse on a frame boundary — 1,000 edits in a tick produce one run.
- **No second run starts while one is in flight.** Seeds accumulate and go out
  as a single follow-up. Without this, a sliced run spanning many frames would
  have a fresh run launched on top of it by every edit arriving meanwhile.

Measured honestly: 20 rapid mutations produced **20 runs at 1×, but 15 at 4×**.
Coalescing only pays when input outpaces computation, so its value concentrates
on slow hardware — which is where it is wanted, but it is not the headline. The
slicing is.

## Intrusiveness

What changed in the calculation itself: the outer loops gained bounds and a
phase counter, and the clock is read every 256 rows. The arithmetic is untouched.

What did not change: any inner loop, any numeric result, the server's call
signature (`calculate()`), or the memory layout.

Switching strategies is one line in `main.tsx`. Both runners are selectable at
runtime from the calculation panel, so they can be compared on a customer's
machine rather than argued about on ours.

## Still on the table

**Worker (`SharedArrayBuffer` or copied buffer).** Deliberately not built. If
cascades ever become continuous rather than interaction-driven, this is the next
move — but it should follow evidence that slicing is insufficient, not precede
it. Note the real cost is not the worker plumbing: it is that concurrent edits
during a run become a genuine race, plus cross-origin isolation for the SAB
variant.

**Cancelling superseded runs.** The runner supports `cancel()`, and the engine
currently lets in-flight runs finish. If a newer edit arrives mid-cascade,
abandoning the run would cut wasted work — worth doing if the latency increase
above becomes a complaint.

**Grid repaint of bulk changes.** Now the largest remaining main-thread block
during a cascade, at ~6ms of calculation against a worst frame of 92ms at 6×.
The next real target.

**Making the calculation itself faster.** The point of keeping it on the main
thread. `KERNEL_PASSES` in `calcKernel.ts` scales the arithmetic — raising it
simulates a heavier calculation, and the numbers above can be regenerated
against it.
