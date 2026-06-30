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

Each input produces `<name>_gratio.png` (axon interior in cyan, myelin in red,
g-ratio drawn at each axon centroid) and `<name>_gratio.csv` (per-axon
`g_ratio`, `axon_area_px`, `myelin_area_px`, centroid, equivalent radius,
solidity).

Programmatic use:

```python
import cv2
from gratio import segment, render
gray = cv2.cvtColor(cv2.imread("img.png"), cv2.COLOR_BGR2GRAY)
seg = segment(gray)
for a in seg["axons"]:
    print(a["id"], a["g"])
overlay = render(gray, seg)
```

## How it works

1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber detection: close lamellar gaps → fill holes → lumens = filled holes
4. keep lumens by area / convex-hull solidity / brightness (axoplasm is bright)
5. per-axon myelin = actual dark pixels in that fiber's sheath, with thin
   inter-lamellar gaps closed (large malformation gaps left open); a sheath
   shared by touching fibers is split by nearest lumen
6. g per axon from the area formula above

The g-ratio is **dimensionless**, so no spatial calibration is needed; the
sample images' scale bars are not used.

## Status

Working prototype. Validated on the three sample micrographs in
`data/samples/` — see `outputs/` for the generated overlays. Per-axon g-ratios
land in the expected textbook range (~0.75–0.83 for these moderately myelinated
fibers).

**Known limitation.** Lumen detection currently relies on the myelin ring being
closed enough to enclose a hole. Severely broken / malformed rings — e.g. the
large central axon in `sample_01` — let the lumen leak into the background and
are **not yet detected**. Handling those (axon-first detection, interactive
seeding, or an ML segmenter such as AxonDeepSeg) is the next iteration, and is
the main reason the area-of-actual-myelin metric matters.

## Layout

```
gratio/pipeline.py   core: segment(), render(), analyze_image(), DEFAULTS
analyze.py           CLI
data/samples/        sample EM micrographs (+ README)
outputs/             example overlays + CSVs
docs/reference/      distilled notes + figures from the MyelTracer paper
```
