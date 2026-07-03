# Continuation guide — picking this up in a new session

Everything needed to resume is committed. Start here.

## Where things stand

Raw-data axon/myelin segmentation validated against the owner's hand masks.
Current agreement (`evaluate_segmentation.py`, means over the 3 TEM samples):

| metric | value |
|--------|-------|
| axon IoU   | 0.94 |
| myelin IoU | 0.86 |
| fibre IoU  | 0.96 |
| detection precision / recall | **1.00 / 1.00** |

(after R31 — the boundary re-sweep against the updated sample_03 GT — and R32,
which scores sample_01 myelin against the omit-corrected GT; before them,
axon 0.93 / myelin 0.85 / fibre 0.95.)

(Baseline before any tuning was axon 0.74 / myelin 0.51 / fibre 0.80, recall 0.80.)
Per-sample numbers and the full narrative are in `user_masks.md`; the durable
requirement list is in `requirements.md`.

## How to run

```bash
pip install -r requirements.txt            # cv2, numpy, scipy, scikit-image
python build_ground_truth.py               # register hand masks onto raw images -> data/samples/masks/native/
python evaluate_segmentation.py            # segment raw, score vs GT -> outputs/eval/ + scores.csv
python render_labeled.py                   # per-axon coloured, numbered review figures -> outputs/eval/*_labeled.png
python analyze.py data/samples/*.png -o outputs/   # g-ratio overlays (g deferred, but the masks are the same)
pytest -q                                  # 38 tests
```

Diagnostics used during tuning (kept for reference):
`border_survey.py` (12 edge/ridge detectors → `outputs/borders/`),
`reference_run.py` (pipeline on the AxonDeepSeg SEM set → `outputs/reference_run/`).
Per-sample error maps + the sample_02 "why geometry can't win" evidence:
`diag_s02_diff.py`, `diag_s03_diff.py`, `diag_s02_boundary.py`,
`diag_s02_capsweep.py` (→ `outputs/diag/`); see `learned_outer_boundary.md`.

## Pipeline shape (`gratio/pipeline.py`, `segment()`)

1. optional **scale-bar removal** (`_remove_scalebar`, gated: only in clean background).
2. bilateral filter; **myelin threshold** (`myelin_percentile`) seals rings, isolates axon compartments.
3. **axon detection**: compartments passing area/solidity/brightness (`min_axon_frac` etc.).
4. **myelin assignment**: dark material touching an axon, capped at `myelin_thickness_mult` × the axon's own measured ring thickness (median distance-to-axon of its dark material); shared bands split by nearest axon.
5. **inner border** refined per fibre by an Otsu **peel** (`axon_otsu_bias`) + smoothing (`axon_smooth_frac`).
6. **dense-dark extension** (`dense_extend`, A-MYELIN-DENSE) follows the solid dark sheath outward past the cap where it ends in neuropil; **junction fill** (`junction_fill`, A-JUNCTION-MYELIN) reclaims dense-dark myelin trapped between two clustered fibres (a strict no-op for isolated fibres).
7. **fibre outer** smoothed (`fiber_smooth_frac`, open+close); **bubbles** = bright interior gaps excluded from myelin.
7b. **lamella trim** (`lamella_trim_outer`, A-MYELIN-LAMELLAR-CONTINUOUS; `gratio/lamella.py`) — on a **single-neuron** image only, pull the lone fibre's outer over-reach inward to the outermost traced lamella (trim-only). Strict no-op otherwise.
8. **final border refit** as least-squares smooth curves (`border_smooth_tol`/`border_smooth_tol_fiber`, `border_min_radius`).
9. **Phase 3 — non-myelin pockets** (`detect_nonmyelin`, A-NONMYELIN-BRIGHT): bright vacuoles/splits inside the band (the tracer's orange *omit* regions) that survive a thickness-scaled opening are excluded from `A_myelin`; each pocket boundary is spline-smoothed (`nonmyelin_smooth_tol`) like the axon/fibre borders; a per-fibre cap (`nonmyelin_max_frac`) bounds removal. Returned as `seg['nonmyelin']`.

## The parameters that were tuned against the masks (why they exist)

| param | value | purpose / requirement |
|-------|-------|-----------------------|
| `myelin_percentile` / `myelin_fill_percentile` | 28 / 42 | decouple axon-separation threshold from the myelin-band threshold; the fill % is raised to capture lighter lamellae (~20-33% of GT myelin is brighter than the separation %) without spawning false axons — R10/R11/**R21** |
| `min_axon_frac` | 0.02 | size floor that culls false-positive background pockets while keeping every real axon — R11 |
| `myelin_thickness_mult` (+`_isolated`) | 3.0 / 1.4 | outer myelin cap = this × the axon's **own measured ring thickness**; scale-free (no pixel constant), independent of axon radius (no g-ratio circularity). Isolated axons ramp to the tighter 1.4 (`isolation_ramp`); 1.4 is the measured elbow — max over-reach removed with under-reach still at baseline — R20/R21/R22/R24/**R31** |
| `fiber_vacuole_close_frac` | 1.0 | wrap the fibre outer boundary over edge vacuoles by closing it with a kernel = this × the axon's own band thickness; one scale-free rule for every fibre (replaced the single-sample R19 enclosure heuristic) — **R24** |
| `axon_otsu_bias` | 10 | per-fibre Otsu peel places the axolemma at the true inner-myelin edge — R13 |
| `axon_smooth_frac` | 0.8 | smooth the axon border into a simple curve; 0.8 removes residual inner-border wobble, 0.9+ over-rounds sample_03's elongated axons — R13/**R31** |
| `fiber_smooth_frac` | 0.2 | smooth the fibre outer envelope, remove spikes — R15 |
| `border_smooth_tol` / `border_smooth_tol_fiber` / `border_min_radius` | 1.0 / 0.5 / 6.0 | final spline curve refit (no shrink; protects tiny axons). The INNER (axon) tol dropped 2.0 → 1.0 so the spline tracks non-circular axons instead of rounding them off (sample_03 axon 0.934 → 0.944); the OUTER (fibre) border keeps an even tighter tol → many more control points, since the myelin outline is longer/undulating — R14/R29/**R31** |
| `remove_scalebar` | True | detect + inpaint the "200 nm" ruler, but only in clean background — R22/R12 |
| `detect_nonmyelin` (+`nonmyelin_open_frac`, `nonmyelin_max_frac`) | True / 0.8 / 0.5 | **Phase 3 (R32)**: exclude bright non-myelin pockets (orange *omit*) from `A_myelin`. A pocket = a region brighter than the dark-myelin cut that survives an opening of `nonmyelin_open_frac` × the fibre's own measured ring thickness (fat blob, not a thin lamella); each pocket boundary is spline-smoothed. Scale-free; byte-neutral on fibres with no pockets (sample_02/03); a per-fibre cap (`nonmyelin_max_frac`) bounds removal. Lifts sample_01 omit-corrected myelin IoU 0.819→0.853; omit IoU 0.64, precision 0.90 |

Note: the remaining px values (`speckle_min`, `close_fiber`, `myelin_close`,
`border_*`, `vacuole_*`) are still **calibrated to these images' magnification**;
revisit them for data at a different scale (see F5). The outer-myelin cap
(`myelin_thickness_mult`) is no longer among them — it is measured in-image.

## Active research thread — LEARNED outer boundary (next up)

**sample_02's outer myelin over-reach is a proven wall for geometry** (isotropic
cap can't fit a sheath that's thin at its shared top wall and thick on the sides;
neighbour-split cuts inside GT; no local signal separates the over-reach because
it *is* the neighbour's myelin). The owner found that macOS Preview's **Remove
Background** — Apple's on-device `VNGenerateForegroundInstanceMaskRequest`, a
trained foreground-segmentation DNN — isolates sample_02's outer boundary
perfectly. The next route is a **learned outer boundary** (rembg+BiRefNet / SAM /
fine-tuned model), gated to isolated fibres only. Full analysis, recreation
routes, and the concrete next experiment are in
[`learned_outer_boundary.md`](learned_outer_boundary.md). Reproduce the evidence
with `python diag_s02_boundary.py` / `diag_s02_capsweep.py` / `diag_s02_diff.py`.

**Complementary classical route — implemented, ON for single-neuron images
(`gratio/lamella.py`).** The owner's line-detection + extend-&-trim algorithm was
evaluated against this same wall. Tracing the myelin **lamellae** as ridge
polylines and pulling a lone fibre's over-reach **inward** to the outermost lamella
(trim-only) **stacks on the R31 cap re-sweep**: on top of the tighter 1.4 isotropic
cap (baseline 0.883) it trims sample_02 to myelin IoU **0.897** (+0.014; mean myelin
0.856 → **0.861**, g 0.688 → 0.696), because 1.4 is the tightest *isotropic* cap and
the residual over-reach is anisotropic. `lamella_trim_outer=True` by default but a
**strict no-op unless exactly one neuron is detected**, so the multi-neuron samples
01/03 are byte-identical. The residual shared-wall over-reach still wants the
learned route above. Full analysis (incl. the four local selection cues that hit the
FP↔FN wall) and reproduction: [`lamella_continuation.md`](lamella_continuation.md) /
`python diag_lamella_trace.py`.

## Open items (see requirements.md for the full list)

- **R19** — sample_01 #2: outer myelin border still cut *before* its bubbles;
  needs a surgical intramyelin-vacuole enclosure (bright pockets *surrounded by
  myelin*, so it won't disturb sample_02's extracellular bright bits). A prior
  global close/enclosure attempt is documented as rejected because it re-spiked
  sample_02.
- sample_01 **#3/#4** inner-axon marking.
- ~~**F1** exclude orange omit regions from myelin area~~ — **done (Phase 3, R32)**;
  residual: two faint/thin sample_01 pockets left in (a dim outer sliver + a thin
  edge-bay) — not recoverable without gutting sample_02's clean myelin.
- **F2** inter-cell separation along the hand-drawn line (R9).
- **F3** vector/SVG export (borders are already fitted curves).
- **F4** area g-ratio once masks are trusted.
- **F5** tuned dense-SEM regime.

## Key files

```
gratio/pipeline.py        segment() + render(); all tuned params in DEFAULTS
gratio/mask_extract.py    extract purple/red hand masks -> label masks
gratio/gt_register.py     register hand masks onto raw images (native coords)
gratio/evaluate.py        IoU/Dice + axon detection matching
render_labeled.py         coloured, numbered review figures
build_ground_truth.py     writes data/samples/masks/native/*
evaluate_segmentation.py  scores segmentation vs GT
tests/                    test_evaluate.py (segmentation+GT+scalebar+border),
                          test_mask_extract.py, test_reference.py, test_synthetic.py
docs/reference/requirements.md   the owner's requirements (start here)
docs/reference/user_masks.md     full method narrative + per-sample results
docs/reference/assumptions.md    registry of biological/equipment assumptions (A-*) + failure modes
```

## Biological vs image-processing assumptions

Choices that encode a **specimen/microscope prior** (not pure image processing)
are registered in [`assumptions.md`](assumptions.md) and tagged inline in
`pipeline.py` as `# BIOLOGICAL ASSUMPTION [A-*]`. With only 3 learning images,
some of these are thinly supported (esp. `A-ISOLATED-TIGHTER`, one axon). When a
new sample looks wrong, check that registry first. The ridge-guided outer-boundary
refinement (`membrane_outer_boundary`, `A-MYELIN-LAMELLAR`) is implemented but
**OFF by default**: on the current set it trims real compact myelin through
lamella gaps (net ≈ −0.003), so it waits for data with clearer lamellae.
