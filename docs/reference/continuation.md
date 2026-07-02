# Continuation guide — picking this up in a new session

Everything needed to resume is committed. Start here.

## Where things stand

Raw-data axon/myelin segmentation validated against the owner's hand masks.
Current agreement (`evaluate_segmentation.py`, means over the 3 TEM samples):

| metric | value |
|--------|-------|
| axon IoU   | 0.93 |
| myelin IoU | 0.83 |
| fibre IoU  | 0.94 |
| detection precision / recall | **1.00 / 1.00** |

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

## Pipeline shape (`gratio/pipeline.py`, `segment()`)

1. optional **scale-bar removal** (`_remove_scalebar`, gated: only in clean background).
2. bilateral filter; **myelin threshold** (`myelin_percentile`) seals rings, isolates axon compartments.
3. **axon detection**: compartments passing area/solidity/brightness (`min_axon_frac` etc.).
4. **myelin assignment**: dark material touching an axon, capped at `myelin_thickness_mult` × the axon's own measured ring thickness (median distance-to-axon of its dark material); shared bands split by nearest axon.
5. **inner border** refined per fibre by an Otsu **peel** (`axon_otsu_bias`) + smoothing (`axon_smooth_frac`).
6. **fibre outer** smoothed (`fiber_smooth_frac`, open+close); **bubbles** = bright interior gaps excluded from myelin.
7. **final border refit** as least-squares smooth curves (`border_smooth_tol`, `border_min_radius`).

## The parameters that were tuned against the masks (why they exist)

| param | value | purpose / requirement |
|-------|-------|-----------------------|
| `myelin_percentile` / `myelin_fill_percentile` | 28 / 42 | decouple axon-separation threshold from the myelin-band threshold; the fill % is raised to capture lighter lamellae (~20-33% of GT myelin is brighter than the separation %) without spawning false axons — R10/R11/**R21** |
| `min_axon_frac` | 0.02 | size floor that culls false-positive background pockets while keeping every real axon — R11 |
| `myelin_thickness_mult` (+`_isolated`) | 3.0 / 1.8 | outer myelin cap = this × the axon's **own measured ring thickness**; scale-free (no pixel constant), independent of axon radius (no g-ratio circularity). Isolated axons ramp to the tighter 1.8 (`isolation_ramp`) — R20/R21/**R22/R24** |
| `fiber_vacuole_close_frac` | 1.0 | wrap the fibre outer boundary over edge vacuoles by closing it with a kernel = this × the axon's own band thickness; one scale-free rule for every fibre (replaced the single-sample R19 enclosure heuristic) — **R24** |
| `axon_otsu_bias` | 10 | per-fibre Otsu peel places the axolemma at the true inner-myelin edge — R13 |
| `axon_smooth_frac` | 0.6 | smooth the axon border into a simple curve — R13 |
| `fiber_smooth_frac` | 0.2 | smooth the fibre outer envelope, remove spikes — R15 |
| `border_smooth_tol` / `border_min_radius` | 2.0 / 6.0 | final Bézier-style curve refit (no shrink; protects tiny axons) — R14 |
| `remove_scalebar` | True | detect + inpaint the "200 nm" ruler, but only in clean background — R22/R12 |

Note: the remaining px values (`speckle_min`, `close_fiber`, `myelin_close`,
`border_*`, `vacuole_*`) are still **calibrated to these images' magnification**;
revisit them for data at a different scale (see F5). The outer-myelin cap
(`myelin_thickness_mult`) is no longer among them — it is measured in-image.

## Open items (see requirements.md for the full list)

- **R19** — sample_01 #2: outer myelin border still cut *before* its bubbles;
  needs a surgical intramyelin-vacuole enclosure (bright pockets *surrounded by
  myelin*, so it won't disturb sample_02's extracellular bright bits). A prior
  global close/enclosure attempt is documented as rejected because it re-spiked
  sample_02.
- sample_01 **#3/#4** inner-axon marking.
- **F1** exclude orange omit regions from myelin area.
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
```
