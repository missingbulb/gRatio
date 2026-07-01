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
with a white (inner) border, the myelin band with a coloured (outer) border —
both **smooth, roughly-closed shapes**, not pixel-following outlines —
**bubbles** (holes / missing myelin in the sheath) are filled red, and the
g-ratio is printed at the axon centroid. Use `--overlay-only` to skip the
side-by-side.

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

Each fiber is a set of contiguous bodies with **smooth, roughly-closed borders**
(not strict ovals, and not intricate pixel-following outlines):

- **axon** — a smoothed bright body (the axoplasm); its border is the inner
  border of the myelin.
- **myelin** — a smoothed band around the axon, of bounded thickness; a band
  shared by touching fibers is split by nearest axon, so neighbours are not
  confused.
- **bubble** — a *significant* bright hole in the band (a vacuole, or a stretch
  of missing / non-hermetic myelin). Bubbles are **not** myelin: they are
  excluded from `A_myelin` and highlighted, because they are exactly the
  malformation we want to surface.

## How it works

1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber region = myelin closed enough to **seal broken rings**, then
   hole-filled — this isolates each axon's bright body from the background even
   when the surrounding ring is incomplete (the malformed case)
4. axon bodies = bright bodies inside fibers passing area / solidity / brightness
5. myelin = dark band touching an axon, within a thickness cap; a band shared by
   touching fibers is split by nearest axon
6. smooth the axon body and the (axon ∪ myelin) region into roughly-closed shapes
7. bubbles = significant bright holes in the smoothed annulus; excluded from myelin
8. g per axon from the area formula above

The g-ratio is **dimensionless**, so no spatial calibration is needed; the
sample images' scale bars are not used.

## Status

Working prototype, validated against **hand-drawn ground-truth masks** of the
three sample micrographs. The segmentation runs on the raw grayscale images and
is scored by mask overlap (IoU) — current means: **axon 0.93 / myelin 0.76 /
fibre 0.90, detection recall & precision 1.00** (baseline before tuning was
0.74 / 0.51 / 0.80, recall 0.80). Run `python evaluate_segmentation.py`.

New to the project? Read these first:

- [`docs/reference/requirements.md`](docs/reference/requirements.md) — the
  project owner's requirements, gathered from the working sessions.
- [`docs/reference/continuation.md`](docs/reference/continuation.md) — how to
  resume: current state, how to run, the tuned parameters and why, open items.
- [`docs/reference/user_masks.md`](docs/reference/user_masks.md) — full method
  narrative, per-sample results, and the ground-truth registration.

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

## Validation & tests

A baseline of **regular** axons with **known** g-ratios is mirrored in
`data/reference/axondeepseg_sem/` — real SEM cross-sections of rat spinal cord
with manual axon/myelin masks (AxonDeepSeg, MIT). `gratio/reference.py` computes
the trusted per-axon g-ratio directly from those masks
(`g = sqrt(axon_area / (axon_area + myelin_area))`); across 1642 axons the mean
is **0.655** (per-sample 0.61–0.69), i.e. textbook-normal.

```bash
pip install -r requirements-dev.txt
python -m pytest -q          # synthetic exact-answer + real ground-truth regression tests
```

Tests cover (a) synthetic perfect annuli where `g = r_in/r_out` exactly, and
(b) regression on the real ground-truth distribution. The image **pipeline** is
not yet benchmarked against this ground truth — that is the next step, and note
the SEM data has **inverted contrast** (bright myelin) vs. the TEM samples.

## Layout

```
gratio/pipeline.py            core: segment(), render(), analyze_image(), DEFAULTS
gratio/reference.py           ground-truth g-ratio from segmentation masks
analyze.py                    CLI
data/samples/                 sample TEM micrographs (the user's images)
data/reference/axondeepseg_sem/  regular-axon SEM images + masks + ground-truth g
outputs/                      example overlays + CSVs
tests/                        synthetic + ground-truth regression tests
docs/reference/               distilled notes + figures from the MyelTracer paper
```
