# Research thread: lamella tracing for the myelin OUTER boundary

Status: **implemented — ON by default, self-gated to single-neuron images**
(`gratio/lamella.py`). This records how the owner's line-detection + extend-&-trim
algorithm was evaluated against the outer-boundary wall, what worked, and — just as
important — the four things that did not and why.
Read alongside [`learned_outer_boundary.md`](learned_outer_boundary.md): both
attack the **same** problem (sample_02's outer over-reach); this is the
**classical-CV** route, that one is the learned-prior route. They are
complementary, not alternatives.

> **Standing after R31/R32 (re-measured).** The R31 boundary re-sweep tightened
> the isolated-fibre cap (`myelin_thickness_mult_isolated` 1.8 → 1.4) and lifted
> sample_02's baseline myelin IoU **0.842 → 0.883** on its own — the biggest single
> move, from a purely geometric change. The question that raises is whether the
> lamella trim is now redundant. **It is not: the trim STACKS on the tighter cap,
> 0.883 → 0.897** (+0.014, official per-axon scorer; mean myelin 0.856 → 0.861).
> The reason is structural — 1.4 is the tightest *isotropic* cap (the "measured
> elbow": max over-reach removed before under-reach starts), and the residual
> over-reach it leaves is *anisotropic* (thin at the shared top wall, thick on the
> sides), which no single radius can remove but the lamella line can. Combined vs
> the pre-R31 baseline: **0.842 → 0.897.** Numbers below are refreshed to this
> baseline; the earlier 0.842 → 0.858 was measured on the 1.8 cap.

## The idea (owner's algorithm)

Detect the myelin lamellae as **ridge lines**, trace them into clean polyline
fragments, and reconnect fragments of the same line by **good continuation**:

- **Phase A** — denoise → Frangi/Sato vesselness → threshold → skeletonize →
  split at junctions → nearest-neighbour trace → length + **tortuosity** filter.
  Output: ordered polyline **lamella fragments** (blobs rejected by tortuosity).
- **Phase B** — each endpoint emits a tangent **ray**; pairwise ray-ray meets that
  are ahead-of-both, within a max extension, and **shallow-bend** are accepted by
  greedy shortest-extension matching; a **consensus cull** keeps only junctions
  that cluster. Output: the reconnected lamellae.

The insight that makes this worth trying even though the project had declared
geometry "exhausted": every prior outer-boundary method is **subtractive** — it
bounds / caps / splits / floods the dark region (`myelin_thickness_mult`,
neighbour-split, `membrane_outer_boundary` flood). This method is
**constructive** — it traces the *specific outermost lamella line* and puts the
boundary there. That is a different family (tensor-voting / perceptual grouping),
and it keys on the thin ridge **crest**, not on how dark or how thick the tissue
is — which is exactly the axis on which the subtractive methods fail.

## What the evidence showed

Baseline sample_02 myelin IoU **0.842**; the error is almost all outer
**over-reach** (FP 39.7k vs FN 3.7k) into sparse extracellular neuropil — see
`outputs/diag/s02_diff.png`.

**Phase A works well.** Along the compact sheath the traced fragments follow the
concentric lamellae cleanly and the GT outer line sits on the outermost of them
(`outputs/diag/s02_lamella_trim.png`, light-blue = traced lamellae). The pipeline
did not previously have this vectorised lamella representation.

**The blocker is selection, not breakage.** Phase B's premise is "reconnect a
broken line," but the outer boundary's real question is "*which* concentric line
is this fibre's outer edge?" — among the sheath's own lamellae **and** the
scattered neuropil membrane fragments from other cells (which are line-like too,
so they survive tortuosity). Every **local** selection cue tried traded FP for FN
with **no operating point beating 0.842** — the same coupling the isotropic-cap
sweep found (`diag_s02_capsweep.py`):

| selection cue | result on sample_02 | failure |
|---|---|---|
| existing ridge-flood (`membrane_outer_boundary`) | 0.842 → 0.845 | flood leaks *back through gaps* in the outer lamella; trims 1.1k of 40k FP |
| close the flood barrier first (proxy for Phase B) | bigger kernel → **less** trim | the over-reach is itself dark, ridge-y tissue that **reads as barrier**, so no inward flood reaches it |
| outermost ridge within a radius (no noise-reject) | FP 40k → **135k** | grabs floating neuropil ridges |
| + connectivity to the sheath | FN 3.7k → **168k** | over-corrects to an inner lamella |
| + crossing-density (compact-stack) | 0.842 → ~0.02 | outer lamellae are 30–40 px apart on a large axon — not a tight stack |
| + concentricity / orientation | best 0.781 | FP↔FN trade, no point ≥ 0.842 |

Four independent local cues, one wall. That **independently reproduces**, via the
owner's method, the conclusion `learned_outer_boundary.md` reached: no local
signal cleanly separates this fibre's outer boundary from the tissue around it.

## What worked: trim-only, bounded by the current boundary

The one configuration that beats baseline **anchors** to the existing (good)
boundary and only pulls it **inward** to the outermost traced lamella lying within
a fraction of the fibre's own measured thickness:

- it **cannot chase floaters** — they sit *outside* the current boundary, so a
  trim-only rule ignores them by construction;
- it **cannot over-trim** to an inner lamella — the band cap stops it;
- it is **isolated-gated** — a clustered fibre's outer lamella merges with its
  neighbour's (selection ambiguous), so clusters are a strict no-op and
  recall/precision stay 1.00.

Result (official per-axon scorer, post-R31 baseline; `python diag_lamella_trace.py`):

| sample | baseline | + lamella-trim | note |
|--------|----------|----------------|------|
| sample_01 | 0.853 | 0.853 | clustered → strict no-op |
| **sample_02** | **0.883** | **0.897** | FP 27.2k → 19.7k over-reach trimmed |
| sample_03 | 0.832 | 0.832 | clustered → strict no-op |
| **mean** | **0.856** | **0.861** | |

`band_frac ≈ 0.3` (× the fibre's own myelin thickness — scale-free) is the peak;
above ~0.4 it keeps cutting FP but FN grows past the gain. This is the **first**
method to move sample_02's outer boundary at all. It does **not** fully close it:
the residual FP is the **top-left shared wall**, where sample_02's outer lamella
*is* the edge-cropped neighbour's lamella — the same spot line cues can't resolve,
and where the learned/global route is still wanted.

## Integration

The lamella code lives in its **own module** `gratio/lamella.py` (not in
`pipeline.py`), because it is an optional, skimage-dependent, prior-bearing
refinement of the myelin **outer boundary** — not part of the core g-ratio path.
`pipeline.py` imports it and calls it from one gated hook.

- `gratio/lamella.py::trace_lamellae()` — Phase A (skimage-guarded; returns `None`
  and no-ops if scikit-image is absent, like `_refine_outer_membrane`).
- `gratio/lamella.py::lamella_trim_outer()` — single-neuron-gated trim-only
  extraction; called from `segment()` after `junction_fill` and **before** the
  spline refit, so the trimmed outline is smoothed like every other border.
- `DEFAULTS['lamella_trim_outer'] = True` — **ON, but self-gated**: it fires only
  when the image has **exactly one detected neuron** (a strict no-op otherwise), so
  the multi-neuron samples 01/03 are byte-identical to before; only the lone fibre
  (sample_02) is affected. Params: `lamella_band_frac=0.3`, `lamella_ridge_pct=80`,
  `lamella_min_len=14`, `lamella_max_tort=1.35`.

Default `evaluate_segmentation.py` (trim ON): axon 0.943 / myelin **0.861** /
fibre **0.958**; sample_02 myelin **0.897**, g 0.688 → 0.696; 49 tests pass. Pass
`lamella_trim_outer=False` for the pre-trim baseline.

Assumption **A-MYELIN-LAMELLAR-CONTINUOUS** in
[`assumptions.md`](assumptions.md); tagged inline in `gratio/lamella.py`. The
tracer's other potential uses are pointered in
[`neurobiology_applications.md`](neurobiology_applications.md) — not in the code.

## Honest caveats

- **+0.015 on one isolated fibre.** sample_02 is the only isolated axon in the
  learning set, so this is calibrated on one image (same weakness as
  `A-ISOLATED-TIGHTER`). `band_frac` and `ridge_pct` want more isolated fibres to
  firm up.
- **Phase B did not contribute the win.** Reconnection runs and produces sensible
  junctions, but the outer boundary improved via Phase A tracing + the trim-only
  selection; the blocker was never line breakage. Phase B is kept in
  `diag_lamella_trace.py`'s history for the record, not in the pipeline path.
- **Needs a resolvable outermost lamella** (A-MYELIN-LAMELLAR-CONTINUOUS): immature
  / compact-only or low-magnification myelin gives nothing to trim to (no-op, not
  a regression).
- **Shared-wall over-reach remains** — see above; complementary to the learned route.

## Files

- `diag_lamella_trace.py` — reproduces the table, the band sweep, and the figure.
- `outputs/diag/s02_lamella_trim.png` — traced lamellae + current / trimmed / GT
  boundaries.
- `gratio/pipeline.py` — `_trace_lamellae`, `_lamella_trim_outer`, the DEFAULTS.
