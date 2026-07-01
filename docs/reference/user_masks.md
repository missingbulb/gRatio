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

## Implications / next steps (not done here)

1. **Inner-boundary refinement** — the axolemma is being drawn too far out into
   the myelin (sample_02 proves it quantitatively); this inflates g across the board.
2. **Recover missed/fragmented axons** — sample_03 #3 and sample_01 #3.
3. **Omit regions** — exclude the orange areas from `A_myelin`/`A_fiber` once we
   decide how they enter the model.
4. **Wire these tracings in as reference g-ratios** so `render(references=…)` can
   print truth beside our value, and add a pipeline-vs-truth regression test.
