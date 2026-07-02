# User hand masks — ground-truth tracings for the sample micrographs

The user supplied hand-drawn masks (delivered as a PDF) over the **same three
micrographs** already in `data/samples/`. The base rasters embedded in the PDF
are **pixel-identical** to `sample_01/02/03.png` (verified: `absdiff == 0` on all
three), so these masks are a ground-truth annotation of our existing samples, not
new images.

The rendered masked images (raster + the vector ink baked in, 300 dpi crops) are
saved in [`data/samples/masks/`](../../data/samples/masks/):

| masked file            | sample        | contents                                  |
|------------------------|---------------|-------------------------------------------|
| `sample_01_masked.png` | `sample_01`   | malformed cluster, 4 axons + 4 omit areas |
| `sample_02_masked.png` | `sample_02`   | one healthy concentric axon               |
| `sample_03_masked.png` | `sample_03`   | 5-axon cluster                            |

## Mask legend (the user's convention)

- **purple** — the axon boundary (inner border of the myelin / the axolemma).
- **red** — the myelin **outer** boundary (outer border of the fiber).
  So the myelin band is the annulus **between the red and the purple** loops.
- **orange** — regions to **omit**: bright vacuoles / splits / non-myelin
  inclusions sitting in the periaxonal/extracellular space that must be excluded
  from any area measurement. (These are handled *later*, not yet in the pipeline.)
- Enclosed areas (axons and omit regions) are **numbered by hand** per image.

## Contrast with the current pipeline

### sample_02 — single healthy axon (the clean, unambiguous case)

Filling the user's purple and red loops gives a **numeric ground-truth g-ratio**:

```
A_axon  = 0.487 * A_fiber      (axon is 49% of fiber area)
g_truth = sqrt(A_axon / A_fiber) = 0.698
pipeline                          = 0.810   (outputs/sample_02_gratio.csv)
```

The pipeline **over-estimates g by ~0.11** here. Cause is visible in
`outputs/contrast_sample_02.png`: our inner (axon) border bulges **outward into
the myelin lamellae**, so we over-count axon area and under-count myelin. The
user's purple sits at the true inner edge of the dark band; the myelin they
traced is genuinely thick (≈half the fiber area). This is the boundary-refinement
issue flagged in the README, now with a concrete target: **0.70, not 0.81**.

### sample_01 — malformed cluster (`outputs/contrast_sample_01.png`)

- User marks **4 axons** (#1 top-left, #2 large central, #3 bottom-left,
  #4 bottom-right) and **4 omit regions** (#5–#8: bright blebs between fibers).
- Pipeline detects all 4 axons but #3 only as a **tiny 2403 px fragment**
  (`g=0.73`) instead of a full body — the malformed/edge boundary collapses there.
- Pipeline does **not** yet exclude the orange omit regions.

### sample_03 — 5-axon cluster (`outputs/contrast_sample_03.png`)

- User marks **5 axons** (#1–#5).
- Pipeline detects **4** (#1, #2, #4, #5) and **misses #3**, the thin elongated
  axon wedged between #2 and #5.

## Algorithmic extraction of the purple/red areas

`extract_masks.py` (module `gratio/mask_extract.py`) turns the hand annotations
into clean, filled label masks, deterministically (same image → same masks):

```
python extract_masks.py            # runs all three, self-checks axon counts
```

How it works:

1. **Colour gates (HSV)** split the ink: purple `H≈125–160`, red `H≤9 or ≥170`,
   orange `H≈9–26` — thresholds picked from the ink hue histogram.
2. **Axons** = filled closed purple loops. Shapes below 0.4 % of the image are
   dropped, which discards the handwritten region numbers (also purple ink).
3. **Fibres** = marker-controlled **watershed**: each axon is a seed, an
   "outside" seed floods the extracellular space, and the red line is burned in
   as a ridge. Each fibre is its axon's catchment, so fibres that share a myelin
   wall split cleanly on the red centre-line — one fibre per axon, no leaks.
4. **Myelin** = fibre minus axon.

Outputs per image, in `outputs/masks/`:

| file                    | contents                                        |
|-------------------------|-------------------------------------------------|
| `*_axon_labels.png`     | 16-bit label image, 0 = bg, 1..N per axon       |
| `*_fiber_labels.png`    | 16-bit label image, fibre id == its axon id     |
| `*_myelin_mask.png`     | 8-bit 0/255 myelin annulus                      |
| `*_extract.png`         | side-by-side [annotated | extracted] for review |
| `*_regions.csv`         | per-region area + centroid                      |

Region **IDs are positional** (top-to-bottom, left-to-right) and do **not**
necessarily match the handwritten numbers. Extraction is pinned by
`tests/test_mask_extract.py` (counts 4/1/5, axon⊂fibre, non-empty myelin,
determinism). The orange **omit** regions are detected and reported
(`orange_px`) but not yet subtracted — that is the deferred step.

## Validating raw-data segmentation against the ground truth

The point of the hand masks is to **score a segmentation that runs on the raw
grayscale micrographs** (`data/samples/sample_0X.png`), not on the annotations.
Two steps:

```
python build_ground_truth.py        # register annotations onto the raw images
python evaluate_segmentation.py     # segment raw data, score vs ground truth
```

1. **Register** (`gratio/gt_register.py`): the annotated crop is the same
   micrograph scaled + padded, so multi-scale template matching recovers the
   (scale, offset) that places the raw image inside the crop (match score
   0.78–0.89). The extracted label masks are warped into native raw coordinates
   and saved under `data/samples/masks/native/` with a `_gt_check.png` overlay.
2. **Segment + score** (`gratio/evaluate.py`): run `gratio.segment` on the raw
   image and compare to the registered ground truth — semantic IoU/Dice per
   class and axon detection precision/recall. Writes a 3-panel
   `[raw | prediction | ground truth]` figure per sample to `outputs/eval/`.

### Result

Recall is the hard constraint: a **missed axon merges its myelin into the
neighbouring fibre**, corrupting that fibre's measurement, so false negatives are
unacceptable. The tuning was driven by the harness to reach **recall = 1.0 with
no false positives**, then maximise class overlap.

| sample     | axon IoU | myelin IoU | fibre IoU | detect P / R |
|------------|---------:|-----------:|----------:|:------------:|
| sample_01  | 0.91 | 0.86 | 0.95 | 1.00 / 1.00 |
| sample_02  | 0.96 | 0.85 | 0.94 | 1.00 / 1.00 |
| sample_03  | 0.92 | 0.80 | 0.94 | 1.00 / 1.00 |
| **mean**   | **0.93** | **0.83** | **0.94** | **1.00 / 1.00** |

(baseline before tuning was axon 0.74 / myelin 0.51 / fibre 0.80, recall 0.80.)

Border refinements: the axon border is **smoothed** (`axon_smooth_frac`) and the
fibre outer bound **smoothed** (`fiber_smooth_frac`, open+close) into clean
rounded envelopes like a hand tracing — the fibre smoothing removes the spiky
extracellular over-reach on sample_02. Masks are per-axon labelled;
`outputs/eval/*_labeled.png` renders each axon in its own colour with a numbered
centre for review.

Borders are refit as **smooth closed curves** (`border_smooth_tol`, a least-squares
periodic spline in the spirit of Schneider's Bezier fitting) as a final pass: it
removes the pixel staircase without shrinking the region (unlike Gaussian contour
averaging), giving a hand-tracing look at IoU-neutral cost. `border_min_radius`
protects tiny axons from over-rounding.

**What was wrong and how it was fixed.** The predicted axon border bulged
outward into the myelin — axon too big, myelin too thin (the same effect that
read the g-ratio high; sample_02 g fell 0.81 → 0.73, close to the hand-traced
~0.70). Two coupled problems, fixed independently:

1. *Myelin under-captured.* The single dark-pixel threshold that **separates**
   axons was also defining the myelin band. Raising it globally thickened the
   myelin but spawned false "axons" in the extracellular space. Fix:
   `myelin_fill_percentile` **decouples** the band/inner-border threshold (more
   inclusive, 30) from the axon-separation threshold (28) — thicker myelin and a
   tighter axon border without loosening the walls between axons.
2. *False-positive axons.* Reaching recall 1.0 admits a few small bright
   extracellular pockets as axons. On the ground truth these are cleanly
   separable by size — every true axon is ≥ 2× the area of the largest false
   pocket — so `min_axon_frac` (0.02) culls them while keeping every real axon.

3. *Myelin over-reaching outward* (sample_02). A loose thickness cap
   (`myelin_band=1.0` ≈ one axon radius ≈ 300 px here) let the band swallow dark
   **extracellular** material abutting the myelin — a large false lobe. A
   physiological cap (`myelin_band=0.5`) removes most of it: sample_02 myelin
   0.58→0.65, fibre 0.83→0.90.

4. *Axon border ran systematically ~15 % large.* Diagnosed with a 12-detector
   border survey (`border_survey.py`, montages in `outputs/borders/`): the
   ridge filters (frangi/sato) and the structure-tensor coherence map showed the
   axon body was stopping one dark lamella *past* the true axolemma on every
   axon. The over-reach is a smooth radial bias, so `axon_shrink_frac=0.06`
   pulls the border in by 6 % of the axon radius and hands the freed periaxonal
   ring to myelin (done after bubble detection so the light ring is not mistaken
   for a vacuole). This lifted mean axon 0.87→0.90 and myelin 0.66→0.71, and
   brought the sample_02 g-ratio 0.75→0.69 (hand-traced ~0.70).

   Note: guiding that shrink with the structure-tensor / frangi ridge directly
   (snap-to-innermost-lamella) was tried and *underperformed* the uniform
   correction (axon 0.87 vs 0.90) — the ridge/coherence signal penetrates the
   axoplasm irregularly and carves the border unevenly. So the structure tensor
   was the diagnostic, but a geometric bias correction is the fix.

5. *Outer myelin notch at vacuoles* (R19; sample_01 axon #2). Where the myelin
   ring has bright gaps (vacuoles) at its outer edge that are not fully enclosed
   by the assigned dark-material band, `binary_fill_holes` cannot close the
   boundary — the fibre outline notches inward before each gap rather than
   wrapping around it. Fix: `enclose_outer_vacuoles` (`vacuole_search_px=5`,
   `vacuole_min_px=150`, `vacuole_enclosed_frac=0.50`) searches for bright
   blobs just outside the fibre boundary whose perimeter is ≥ 50 % surrounded by
   myelin/fibre and folds them in, after which `binary_fill_holes` closes the
   now-sealed ring. Gain: sample_01 myelin +0.04, mean +0.01 (sample_02 -0.01
   as a minority of near-boundary bright pockets get included there too).

6. *Outer myelin cap was resolution-dependent and g-ratio-circular* (R20).
   The band was capped at `max(myelin_band · r_axon, myelin_band_floor)` — a
   fraction of the axon radius, floored by an absolute pixel count. Both parts
   are unsound as general defaults: the pixel floor is pinned to *these images'
   magnification* (a scan at another pixel size clips at a different physical
   distance), and capping myelin thickness at a fraction of the axon radius
   **bakes a g-ratio prior into a g-ratio measurement** — for a circular axon,
   `myelin_band=0.5` makes it structurally impossible to report g < √(1/2.25) ≈
   0.67, so genuinely thick myelin (low g) is clipped and read back high.

   Why a cap is needed at all: an *isolated* fibre (sample_02, one axon in the
   field) has no neighbouring axon to arbitrate its territory, so "dark material
   connected to the axon" grows across bright extracellular gaps and vacuums up
   unrelated dark blobs (≈30 % over-reach with no cap). In multi-axon fields the
   nearest-axon (Voronoi) split already bounds each fibre, so the cap barely
   binds there (2–4 % over-reach). Appearance cannot separate the over-reach —
   it is texturally identical to real myelin (brightness, structure-tensor
   coherence, local variance all indistinguishable), because it *is* myelin from
   adjacent unannotated fibres. Only geometry separates it.

   Fix (`myelin_thickness_mult=3.0`): cap the band at a multiple of the axon's
   **own measured ring thickness** — the median distance-to-axon of the dark
   material hugging it. This is derived from the image (resolution-independent,
   no pixel constant) and is **not** a fraction of the axon radius (no g-ratio
   circularity): a thickly-myelinated axon gets a larger cap because its measured
   ring is genuinely thicker, not because we assumed a thickness. The measured
   thickness scales correctly and unsupervised — sample_03's thin myelin yields a
   small cap (~40 px), sample_02's thick myelin a large one (~155 px) — and the
   result is accuracy-neutral vs the old radius+floor cap (mean myelin 0.777 →
   0.772, fibre 0.912 → 0.909; recall still 1.00/1.00). The only residual
   assumption is intra-fibre: the outer boundary lies within a few ring
   thicknesses (a wedge ballooning many-fold is a neighbour, not this myelin).
   An optional absolute ceiling (`myelin_band`, default off) remains for datasets
   that need to hard-limit the measured cap (e.g. inverted-contrast SEM).

7. *Lighter lamellae fell below the dark threshold* (R21). The binding limit on
   myelin IoU was not the cap but the fill threshold: ~20-33 % of the hand-traced
   myelin (sample_01 33 %, sample_02 27 %, sample_03 19 %) is **brighter** than
   `myelin_fill_percentile=34`, so it was never marked as dark material and no cap
   could recover it — the hand tracer includes lighter transitional lamellae and
   inclusions the percentile excludes. Raising the fill threshold to 42 captures
   them; because it is decoupled from the axon-separation threshold
   (`myelin_percentile=28`) it does **not** loosen the inter-axon walls, so recall
   stays 1.0 with no false positives. The extra dark material would over-reach on
   the open extracellular side, so the thickness cap is tightened in tandem
   (`myelin_thickness_mult` 3.0 → 2.5) to absorb it. Net: mean myelin 0.77 → 0.80,
   fibre 0.91 → 0.93; sample_01 (most under-captured) myelin 0.71 → 0.82, fibre
   0.88 → 0.95. The trade redistributes slightly toward the harder malformed
   cluster (sample_03 myelin −0.03) but is a clear net gain and attacks the true
   ceiling rather than the cap.

8. *Isolated axons over-reach into open extracellular space* (R22). sample_02 is
   a lone axon; 88 % of its myelin error was outer-side over-reach (52 k px) into
   dark adjacent tissue that connects to its myelin and is *texturally identical*
   to it — brightness, structure-tensor coherence, fine-scale texture, and even a
   radial-lamellar-organization score all fail to separate the two (verified
   pixel-wise; the same features flip sign on sample_01, whose over-reach is
   adjacent *real* myelin). So local appearance cannot cut it. What separates the
   two samples is structural, not local: sample_02's myelin faces open space on
   all sides with no neighbouring axon to bound it, whereas sample_01/03 are
   touching clusters whose thick myelin is genuinely bounded by neighbours. Fix:
   an axon whose nearest neighbour is more than `isolation_ratio`=8 of its own
   measured myelin thicknesses away is treated as **isolated** and uses a tighter
   cap (`myelin_thickness_mult_isolated`=1.8) instead of the clustered default
   (2.5); the test is scale-free (a ratio to the axon's own thickness). Isolation
   is cleanly separable on this data (clustered axons sit at neighbour-ratio ≤ 6,
   sample_02 at ∞). Gain: sample_02 myelin 0.79 → 0.84, fibre 0.90 → 0.93;
   sample_01/03 unchanged (they stay clustered). A per-*pixel* open-vs-corridor
   variant was tried and rejected: sample_01's open-facing myelin is itself thick,
   so a tight open-side cap starved it — the decision must be per-axon, not
   per-pixel.

9. *Bubbles, edge-cut vacuoles, over-tight cluster cap* (R23, from owner review).
   Three targeted fixes: (a) `detect_bubbles` now defaults **False** — the hand
   tracing counts intramyelin vacuoles inside the myelin (their exclusion is a
   deferred stage), so keeping them lifts sample_01 myelin 0.82 → 0.87; (b)
   `fill_edge_holes` closes a bright vacuole that is enclosed by myelin on its
   visible sides but touches the image edge (`binary_fill_holes` cannot close a
   border-touching hole) via reflection-padding — fixes the hole in sample_01 #3's
   myelin near the left border; (c) the clustered cap was restored 2.5 → 3.0 now
   that isolated axons are separately capped (R22), recovering some of sample_03
   #5's outer myelin. Net mean myelin 0.81 → 0.83.

10. *Audit for single-case code* (R24, owner directive: nothing that only holds
    for one sample). Three changes: (a) **removed `enclose_outer_vacuoles` (R19)**
    — an audit showed it added mostly-correct myelin on sample_01 (77 %) but
    mostly over-reach on sample_02 (20 %) and sample_03 (44 %), and no enclosure
    threshold separated the two, so it was overfit to one image. It is replaced by
    a general rule: close each fibre by `fiber_vacuole_close_frac` × **that axon's
    own measured band thickness**, which wraps outer-edge vacuoles identically for
    every fibre (the kernel scales with each axon's myelin, so it cannot grab the
    extracellular blobs R19 did). This recovers sample_01 (0.84 → 0.86) with **no**
    cost to the others; (b) the isolated/clustered cap is now a **smooth ramp**
    (`isolation_ramp`) instead of a hard threshold, so an axon near the boundary is
    not treated abruptly; (c) the border spline refit (`border_smooth_tol`) is off
    by default — it was costing a little IoU and the morphological smoothing
    already gives clean borders. The vacuole close now runs **after** the axon peel
    so it only shapes the outer boundary, never the g-ratio. Net mean myelin
    0.83 → 0.83 (steady) but sample_02/03 up and the pipeline is free of
    one-sample special-casing.

The relevant `segment` defaults are now `myelin_percentile=28`,
`myelin_fill_percentile=42`, `myelin_thickness_mult=3.0`,
`myelin_thickness_mult_isolated=1.8`, `isolation_ramp=(7,13)`,
`fiber_vacuole_close_frac=1.0`, `detect_bubbles=False`, `fill_edge_holes=True`,
`min_axon_frac=0.02`; every outer-myelin rule scales with each axon's own measured
thickness (no pixel constant, no axon-radius/g-ratio prior), and the only cap
value calibrated on a single isolated example (`myelin_thickness_mult_isolated`)
is documented as such.

**Still open after R23 (owner-review items not fully solved):**
- *sample_02 bottom corner under-reach.* The isolated cap is a single uniform
  radial distance; at a convex axon corner the true myelin reaches a larger
  distance-to-axon than on the flat sides, so a uniform cap that stops the top
  over-reach also clips the bottom corner. Fixing both at once needs a
  per-location outer-membrane terminator (a bright-gap stop), which was tried and
  found fragile; deferred.
- *inner myelin eaten by the axon border* (sample_01 #2 inner arc, sample_03 #5
  inner). The Otsu peel is already at its best global bias (10); raising it to
  recover inner myelin over-shrinks sample_03's small axons. Needs a local, not
  global, inner-border refinement.
- *shared wall sample_03 #3–#5* partly not dark material, so not recoverable by
  the cap alone.

**Known residual limits:**
- An isolated fibre's outer bound rests on the measured-thickness cap, not on an
  image edge, because the over-reaching material is texturally identical to real
  myelin (adjacent unannotated fibres) and only geometry separates it. The cap is
  now scale-free and prior-free but is still a geometric heuristic, not evidence
  of an outer membrane (sample_02, ≈−0.01 residual).
- Touching cells are not yet split *along the hand-drawn inter-cell line*; the
  outer border of each fibre is captured but the shared wall between two cells'
  myelin is assigned by nearest-axon, not by that line.
- sample_01's myelin IoU stays lowest, partly definitional — the hand-traced
  myelin there is generous and includes the orange omit regions (not yet excluded).
- Cluster axons with the thickest myelin walls (sample_01 #3, per-axon IoU ≈ 0.48)
  under-capture myelin for an *upstream* reason, not the cap: much of that hand-
  traced myelin is never marked dark by the fill threshold or is not connected to
  the axon's dark ring, so raising the cap alone cannot recover it.

The harness and the perfect-recall / no-false-positive guarantees are pinned by
`tests/test_evaluate.py`.

## Implications / next steps (not done here)

1. **Inner-boundary refinement** — the axolemma is being drawn too far out into
   the myelin (sample_02 proves it quantitatively); this inflates g across the board.
2. **Recover missed/fragmented axons** — sample_03 #3 and sample_01 #3.
3. **Omit regions** — exclude the orange areas from `A_myelin`/`A_fiber` once we
   decide how they enter the model.
4. **Wire these tracings in as reference g-ratios** so `render(references=…)` can
   print truth beside our value, and add a pipeline-vs-truth regression test.
