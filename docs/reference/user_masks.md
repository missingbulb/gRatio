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

## Implications / next steps (not done here)

1. **Inner-boundary refinement** — the axolemma is being drawn too far out into
   the myelin (sample_02 proves it quantitatively); this inflates g across the board.
2. **Recover missed/fragmented axons** — sample_03 #3 and sample_01 #3.
3. **Omit regions** — exclude the orange areas from `A_myelin`/`A_fiber` once we
   decide how they enter the model.
4. **Wire these tracings in as reference g-ratios** so `render(references=…)` can
   print truth beside our value, and add a pipeline-vs-truth regression test.
