# MyelTracer paper — extracted reference notes

> Self-contained summary of the source article so we never have to re-read the
> PDF. Everything below that matters for building our area-based g-ratio tool is
> captured here, including the exact image-processing pipeline, the g-ratio
> formula, calibration, sanity-check values, and how their method relates to
> (and differs from) the method we are building.

## Citation

**MyelTracer: A Semi-Automated Software for Myelin g-Ratio Quantification.**
Tobias Kaiser, Harrison Mitchell Allen, Ohyoon Kwon, Boaz Barak, Jing Wang,
Zhigang He, Minqing Jiang, Guoping Feng. *eNeuro* 8(4), July/August 2021,
ENEURO.0558-20.2021. DOI: 10.1523/ENEURO.0558-20.2021. Open access (CC-BY 4.0).
Software: https://github.com/HarrisonAllen/MyelTracer (Python, OpenCV, PyQt5).

One-line summary: an installable GUI tool that semi-automates g-ratio
measurement from EM micrographs by thresholding + contour extraction (OpenCV),
with the user selecting/correcting contours. Reduces quantification time 40–60%
vs. manual tracing while matching manual accuracy.

---

## THE KEY PART — how g-ratio is defined and computed

g-ratio is the standard metric for **relative myelin sheath thickness** in
cross-sectional EM. It is **dimensionless** (a ratio), so image calibration does
NOT affect it — calibration only matters for reporting absolute diameters/areas.

MyelTracer measures **three nested contours** per fiber (see
`myeltracer_fig1_gratio_definition.png`, panel E):

| Symbol | Feature | Meaning |
|--------|---------|---------|
| `a` | **axon** | innermost — the axoplasm boundary (axon proper) |
| `d` | **inner myelin** | inner boundary of the myelin sheath |
| `D` | **outer myelin** | outer boundary of the myelin sheath |

Nesting: `a ⊂ d ⊂ D`. The gap between `a` and `d` is the **periaxonal space**
(a fixation artifact, marked `*` in Fig. 1A). The **myelin sheath** is the
annulus between `d` and `D`.

**Diameters are computed from areas as equivalent-circle diameters** (NOT by
measuring a width), which is exactly the rotation-invariant, direction-free
idea we want:

```
diameter = 2 * sqrt(area / pi)
```

**g-ratio formula (textbook, inner/outer, value < 1):**

```
g = d / D = sqrt(innerMyelinArea / outerMyelinArea)
```

i.e. they take the **sqrt of the area ratio** so it equals the diameter ratio.
This is the same parity construction we want (sqrt of the area ratio reproduces
the diameter ratio on a perfect circle). Note MyelTracer uses **inner myelin
`d`** (not axon `a`) in the numerator of the g-ratio; the axon diameter `a` is
used only as the **x-axis** when plotting g-ratio vs. axon size (panel F).

g-ratio interpretation: **higher g → thinner myelin** relative to axon;
**lower g → thicker myelin**. Typical CNS values ~0.6–0.8.

---

## Exact OpenCV image-processing pipeline (reproduce-able)

From the Methods (page 3). Pipeline per image, in order:

1. **Grayscale**: `cvtColor(src, COLOR_BGR2GRAY)` → scalar 0–255 per pixel.
2. **Denoise / edge-preserving smooth**:
   `bilateralFilter(src, d=9, sigmaColor=75, sigmaSpace=75)`.
3. **Binary threshold** at a user-chosen `t`:
   `threshold(src, thresh=t, maxval=255, type=THRESH_BINARY)`
   (pixels below `t` → black, above → white; myelin is dark → goes black).
   `t` is **interactive/dynamic** — the user drags a slider to match contours
   to the underlying ultrastructure.
4. **User correction lines** drawn onto the thresholded image via `polylines`
   (the cut/draw tools — see below).
5. **Contour extraction**:
   `findContours(src, mode=RETR_TREE, method=CHAIN_APPROX_SIMPLE)`
   — boundaries between black and white regions. `RETR_TREE` preserves the
   nesting hierarchy needed to pair inner/outer.
6. **Filter contours**: drop contours with **< 5 vertices**; drop contours whose
   `contourArea` falls outside user-defined **Min Size / Max Size**.
7. **Group features**: for each axon, nest **axon / inner myelin / outer myelin**
   together by testing containment with `pointPolygonTest`.
8. **Measure**: `contourArea` for area, `arcLength` for perimeter,
   `2*sqrt(area/pi)` for diameter, `sqrt(innerArea/outerArea)` for g-ratio.
9. **Export**: per-axon rows to a plain-text **CSV**; plus an **overlay image**
   (selected features filled, drawn on top of the original — teal/blue in the
   paper) for QC and publication.

Stack: OpenCV (vision) + PyQt5 (GUI) + fbs (packaging). Calibration entered as
**`um/px`** (GUI example value: `0.003951 um/px`; example threshold `122`).

### Recommended user workflow (Fig. 1H)
1. Enter calibration factor (um/px).
2. Set a threshold and mark **all axons**.
3. Use **cut/draw** tools to separate touching myelin sheaths / connect broken
   ones.
4. Change threshold and mark **inner and outer myelin** boundaries for each axon.
5. Save ROIs and export results.

### Handling hard cases
- **Myelin folds** (Fig. 1M–P): the fold would wrongly enclose extra area; the
  user draws a white line with the **cut tool** to connect the inside of the
  fold to the outside so the fold area is excluded.
- **Touching/contiguous sheaths**: cut tool separates adjacent fibers (needed
  for dense corpus callosum; rarely needed for sciatic nerve).
- **Discontinuous / broken myelin** (esp. remyelination, thin sheaths): the
  **draw tool** connects discontinuous contours so a closed outer boundary can
  be formed. *This is exactly the malformed-myelin situation our project cares
  about — and note their fix (manually closing the ring) deliberately
  reconstructs an idealized outer boundary, which is the behaviour we want to
  AVOID for our area-of-actual-myelin metric. See "Implications" below.*

---

## Sanity-check g-ratio values (use to validate our outputs)

Means ± SD reported with MyelTracer (matched manual values nearly identical):

| Tissue / condition | g-ratio (mean ± SD) | n |
|--------------------|---------------------|---|
| Corpus callosum, 1-month WT | 0.807 ± 0.044 | 173 |
| Optic nerve, 2-month WT | 0.798 ± 0.043 | 193 |
| Sciatic nerve, 1-month WT | 0.559 ± 0.071 | 104 |
| Optic nerve, 28d post-crush (remyelinated) | 0.821 ± 0.068 | 155 |
| Native optic nerve (control) | 0.782 ± 0.012 | 3 mice |
| Remyelinated optic nerve | 0.832 ± 0.019 | 3 mice |

Disease/abnormality signal (direction matters):
- **Williams syndrome model** (Gtf2i fl/fl; Nex-Cre) shows **hypomyelination →
  higher g-ratio** than control (regression y-intercept 0.713 vs 0.645).
- **Remyelination** → thinner myelin → **higher g-ratio** than native.

So across CNS/PNS, real g-ratios sit roughly in **0.5–0.85**. Any per-axon value
our tool emits far outside ~0.4–0.95 is suspect (bad segmentation).

g-ratio is typically plotted **vs. axon diameter** as a scatter + linear
regression; groups are compared by regression (ANCOVA) and/or mean (t-test).

---

## Other tools mentioned (context / fallback options)

- **GRatio for ImageJ** (Goebbels 2010): ImageJ plugin, non-automated; helps
  group traced structures + export. Manual tracing.
- **AxonSeg** (Zaimi 2016) and **AxonDeepSeg** (Zaimi 2018): MATLAB, fully
  automated (AxonDeepSeg uses CNNs). High-throughput but need preprocessing /
  parameter tuning / network retraining on user data. *AxonDeepSeg is the
  obvious ML fallback if classical CV proves too brittle on our images.*
- **Janjic et al. 2019**: deep-neural-network workflow for myelin/axon
  segmentation in human white matter; aimed at CS-savvy users.

Known limitation shared by all (incl. MyelTracer): performance degrades with
**poor contrast**, perfusion/fixation artifacts. Myelin ultrastructure is
heterogeneous (wide axon caliber range, varied sheath morphology), which is the
core challenge for automation.

---

## Implications for OUR project (area-based, malformed-myelin-robust g-ratio)

What the paper confirms for us:
- Our parity construction is **correct and standard**: g = sqrt(area ratio)
  reproduces the diameter ratio on a perfect circle. MyelTracer literally uses
  `sqrt(innerMyelinArea/outerMyelinArea)`.
- The **textbook convention** we're matching is **inner/outer, value < 1**,
  ~0.5–0.85. Confirmed.
- Area-from-contour + equivalent-circle-diameter is exactly the
  cross-section-independent, direction-free idea the project owner wants.
- A classical OpenCV pipeline (grayscale → bilateral filter → threshold →
  findContours → nest via point-in-polygon) is a proven baseline; we can start
  here. Their exact parameters (bilateral d=9/75/75; RETR_TREE;
  CHAIN_APPROX_SIMPLE; ≥5 vertices; min/max area filter) are good defaults.

Where OUR method intentionally DIVERGES from MyelTracer — this is the whole
point of the project:

- MyelTracer's g uses the **area enclosed by the outer myelin contour**
  (`outerMyelinArea`). For **malformed / non-hermetic myelin**, the user closes
  the broken ring (draw tool) so the outer contour still encloses a full disk —
  the missing myelin is **invisible** to the metric, which is precisely the
  skew the project owner wants to eliminate.
- **Our metric uses the area of the _actual myelin material_** (the dark
  lamellae pixels), not the area enclosed by an idealized outer boundary. So:

  ```
  g_ours = sqrt( A_axon / (A_axon + A_myelin_actual) )      # textbook, <1
  ```

  where `A_axon` = axon interior area and `A_myelin_actual` = real myelin pixel
  area belonging to that fiber. Broken/sparse myelin → smaller
  `A_myelin_actual` → g closer to 1 → correctly reads as poorly myelinated.

- **Parity check**: on a perfect circle, fully (hermetically) myelinated, with
  negligible periaxonal space, `A_axon ≈ innerMyelinArea` and
  `A_axon + A_myelin_actual ≈ outerMyelinArea`, so `g_ours = g_MyelTracer`.
  They diverge only when myelin is malformed — by design.

Open nuance to keep in mind (decide when implementing):
- **axon `a` vs inner-myelin `d`**: MyelTracer's g uses `d` (inner myelin),
  treating periaxonal space as inside the numerator. The project owner described
  the inner region as the **axon** (`a`). For our actual-material metric the
  natural inner region is the axon interior; periaxonal space is then excluded
  from both axon and myelin. On clean fibers with little periaxonal space this
  is immaterial, but it's a definitional choice worth surfacing.

## Figures stored alongside this file
- `myeltracer_fig1_pipeline.png` — Fig. 1A–D: Raw → Threshold → Contours →
  Overlay (the `*` in A marks periaxonal space).
- `myeltracer_fig1_gratio_definition.png` — Fig. 1E–F: the `a`/`d`/`D` nested
  contours and g-ratio = d/D.
- `myeltracer_fig1_full.png` — full Fig. 1 page (also shows GUI, workflow steps,
  and myelin-fold handling M–P).
