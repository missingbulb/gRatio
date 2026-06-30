# gRatio — area-based myelin g-ratio from EM cross-sections

Computes the myelin **g-ratio** from electron-microscopy cross-sections of
axons, using an **area-based** definition that is robust to malformed /
non-hermetic myelin.

## Why area-based

The classical g-ratio is a ratio of diameters (inner axon / outer fiber)
measured along one chosen direction. That makes it sensitive to *which*
cross-section and *which* diameter you measure, and it is skewed when the myelin
does not hermetically enclose the axon (the missing myelin is invisible to a
diameter measured elsewhere). Areas are direction-independent, and measuring the
**actual myelin material present** lets malformed myelin correctly lower the
apparent sheath:

```
g = sqrt( A_axon / (A_axon + A_myelin) )        # textbook convention, value < 1
```

- `A_axon` — area of the axon interior (lumen).
- `A_myelin` — area of the actual myelin material around that axon.

On a perfectly circular, hermetically myelinated axon, `sqrt` of the area ratio
equals the radius ratio, so this reproduces the standard diameter-based g-ratio
exactly (**parity**); it only diverges when the myelin is malformed — which is
the point. Background and the full derivation, plus how this relates to the
MyelTracer reference tool, are in
[`docs/reference/myeltracer_notes.md`](docs/reference/myeltracer_notes.md).

## Usage

```bash
pip install -r requirements.txt

# write overlays + per-axon CSVs to outputs/
python analyze.py data/samples/*.png -o outputs/

# tunables can be overridden, e.g.
python analyze.py data/samples/sample_02.png -o outputs/ --myelin-percentile 25
```

Each input produces a side-by-side `<name>_gratio.png` (left: the original;
right: the overlay) and `<name>_gratio.csv` (per-axon `g_ratio`,
`axon_area_px`, `myelin_area_px`, centroid, equivalent radius, solidity). In the
overlay, **each axon+myelin pair gets its own colour**, the axon body is drawn
with a white border, the myelin band with a coloured outer border, **bubbles**
(holes in the sheath) are outlined in red, and the g-ratio is printed at the
axon centroid. Use `--overlay-only` to skip the side-by-side.

Programmatic use:

```python
import cv2
from gratio import segment, render, render_comparison
gray = cv2.cvtColor(cv2.imread("img.png"), cv2.COLOR_BGR2GRAY)
seg = segment(gray)
for a in seg["axons"]:
    print(a["id"], a["g"])
comparison = render_comparison(gray, seg)   # original | overlay
```

## Structural model

Each fiber is treated as a set of **contiguous bodies**, not loose pixels:

- **axon** — a contiguous bright body (the axoplasm), with intra-axonal granules
  filled in. Its border is the inner border of the myelin.
- **myelin** — a contiguous dark band that *touches* the axon, of bounded
  thickness, with an outer border and an inner border.
- **bubble** — a bright pocket fully enclosed by the sheath (a hole in the
  myelin). Bubbles are **not** myelin: they are excluded from `A_myelin` and
  highlighted, because they are exactly the malformation we want to surface.

## How it works

1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber region = myelin closed enough to **seal broken rings**, then
   hole-filled — this isolates each axon's bright body from the background even
   when the surrounding ring is incomplete (the malformed case)
4. axon bodies = bright bodies inside fibers passing area / solidity /
   brightness; intra-axonal granules filled in
5. myelin = dark band contiguous with an axon, within a thickness cap; a band
   shared by touching fibers is split by nearest axon
6. bubbles = enclosed holes in (axon ∪ myelin); excluded from myelin
7. g per axon from the area formula above

The g-ratio is **dimensionless**, so no spatial calibration is needed; the
sample images' scale bars are not used.

## Status

Working prototype. Validated on the three sample micrographs in
`data/samples/` — see `outputs/` for the generated side-by-side results. All
axons (including the **malformed central axon in `sample_01`**) are detected;
per-axon g-ratios land in the expected textbook range (~0.75–0.83 for these
moderately myelinated fibers).

**Open issues / next steps.**
- *Malformed-axon boundary.* Where the ring is badly broken (left side of the
  central `sample_01` axon), the bright axoplasm merges with extracellular space
  through the gap, so the sealed-ring boundary over-extends. The axon is
  detected and bordered, but its boundary there is approximate — this is the
  inherently hard region and the next target (axon-boundary refinement,
  interactive seeding, or an ML segmenter such as AxonDeepSeg).
- *Gap-fill scale.* `myelin_close` decides which gaps are "normal inter-lamellar
  spacing" (filled, counted as myelin) vs "malformation" (left open, excluded).
  This threshold directly affects g for loosely-myelinated axons and is a
  modelling choice worth calibrating against expert tracing.

## Layout

```
gratio/pipeline.py   core: segment(), render(), analyze_image(), DEFAULTS
analyze.py           CLI
data/samples/        sample EM micrographs (+ README)
outputs/             example overlays + CSVs
docs/reference/      distilled notes + figures from the MyelTracer paper
```
