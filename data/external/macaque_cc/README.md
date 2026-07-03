# Macaque corpus-callosum TEM — external validation set

Eight transmission-electron micrographs (TEM) of one cynomolgus macaque corpus
callosum. Same modality as `data/samples/` (dark concentric myelin on a light
field), but wider fields densely packed with myelinated axons.

| | |
|---|---|
| **Images** | 8 (`images/Segment_1..8.png`) + one sample-scale crop each (`crops/`) |
| **Modality** | TEM, dark myelin (matches our samples; **not** inverted like SEM) |
| **Native** | 3040 × 2696 px, **9.144 nm/px**, 1900×, ~21 × 28 µm field |
| **Scale bar** | burned into the pixels (`Cal: 0.009144 um/pix`); pipeline inpaints it |
| **Bit depth** | 8-bit grayscale → TIFF→PNG here is **lossless** |
| **License** | **CC-BY 4.0** (redistribution permitted with attribution) |

## What ground truth this set does — and does NOT — provide

This is the important part for how it plugs into our validation (see the R-note
in `docs/reference/user_masks.md`):

- **It HAS** a published **aggregate g-ratio per image** (`gratio_labels.csv`,
  from Table 1 of the source): `g_aggregate` and `g_mean` per segment, plus the
  myelin/fiber volume fractions the aggregate g is derived from
  (`g_agg = sqrt(1 - MVF/FVF)`, which reproduces the table to ±0.01).
- **It does NOT have** per-axon segmentation **masks**. There is no pixel-wise
  axon/myelin ground truth, so this set **cannot** feed the mask-IoU /
  detection-recall harness (`evaluate_segmentation.py`, `report.py`) the way the
  three hand-annotated `data/samples/` do. Fabricating masks to force it in
  would violate the project rule that ground truth is annotated, never invented.

So it validates the **g-ratio number** (an image-level check), which the
three-sample set barely exercises (3 images' worth of g). For per-axon IoU on
*external* data, use a **masked** source instead (AxonDeepSeg SEM/TEM, WMMDB,
AxonCallosumEM); see `docs/reference/external_datasets.md`.

## Regenerating

Images and crops are reproducible outputs of the fetcher (nothing is
hand-edited):

```bash
python data/external/macaque_cc/fetch.py          # populate images/ + crops/
python data/external/macaque_cc/fetch.py --force  # re-download & regenerate
```

## Citation / attribution (CC-BY 4.0)

> Stikov N, Perry LM, Mezer A, Rykhlevskaia E, Wandell BA, Pauly JM,
> Dougherty RF. *Quantitative analysis of the myelin g-ratio from electron
> microscopy images of the macaque corpus callosum.* Data in Brief 4:368–373
> (2015). https://doi.org/10.1016/j.dib.2015.05.019 — licensed CC-BY 4.0.
