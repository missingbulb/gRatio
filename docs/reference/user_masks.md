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
| sample_01  | 0.91 | 0.65 | 0.83 | 1.00 / 1.00 |
| sample_02  | 0.96 | 0.81 | 0.91 | 1.00 / 1.00 |
| sample_03  | 0.92 | 0.82 | 0.96 | 1.00 / 1.00 |
| **mean**   | **0.93** | **0.76** | **0.90** | **1.00 / 1.00** |

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

The relevant `segment` defaults are now `myelin_percentile=28`,
`myelin_fill_percentile=34`, `myelin_band=0.5`, `min_axon_frac=0.02`,
`axon_shrink_frac=0.06`; the size / shrink values are calibrated against this
ground truth.

**Known residual limits:**
- A small dark extracellular lobe can abut the myelin with no bright gap
  between them; a radial cap that keeps genuinely thick myelin cannot fully
  reject it (sample_02, top-left).
- Touching cells are not yet split *along the hand-drawn inter-cell line*; the
  outer border of each fibre is captured but the shared wall between two cells'
  myelin is assigned by nearest-axon, not by that line.
- sample_01's myelin IoU stays lowest, partly definitional — the hand-traced
  myelin there is very generous and still includes the orange omit regions.

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
