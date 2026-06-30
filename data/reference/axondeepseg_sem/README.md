# AxonDeepSeg SEM — ground-truth validation set

Real scanning-electron-microscopy (SEM) cross-sections of **rat spinal cord**
with **manual axon + myelin segmentation masks**, used as the trusted baseline
for *regular* (healthy) myelinated axons with known g-ratios.

## Source & license

- Repository: https://github.com/axondeepseg/data_axondeepseg_sem
- Zenodo DOI: 10.5281/zenodo.5498378
- License: **MIT** (see `LICENSE_axondeepseg_sem.txt`)
- Authors: Zaimi, Antonsanti, Bourget, Duval, Foias, Herman, Husein, Nami,
  Perone, Saliani, Wabartha, Collin, Cohen-Adad.
- Paper: Zaimi et al. (2018), *AxonDeepSeg: automatic axon and myelin
  segmentation from microscopy data using convolutional neural networks*,
  Scientific Reports 8:3816.

A 6-sample subset (one per rat across several animals) is mirrored here. Pixel
size is 0.18 µm/px (see each `*.json`). Note SEM contrast is **inverted** vs. our
TEM samples: here **myelin is bright**, axoplasm mid-grey, background dark.

## Files

For each sample `sub-ratN_sample-XXX`:

| file | content |
|------|---------|
| `*.png` | raw SEM image |
| `*_mask.png` | manual mask — `0` background, `127` myelin, `255` axon |
| `*.json` | acquisition metadata (incl. `PixelSize`) |
| `*_gratio_truth.csv` | per-axon ground-truth g-ratio (computed from the mask) |

## Ground-truth g-ratio (computed via `gratio.reference.gratio_from_mask`)

`g = sqrt(axon_area / (axon_area + myelin_area))` per axon, myelin assigned to
its nearest axon. Axons < 200 px dropped as specks.

| sample | n axons | mean g | median | sd |
|--------|--------:|-------:|-------:|---:|
| sub-rat1_sample-data1  | 531 | 0.678 | 0.678 | 0.057 |
| sub-rat2_sample-data5  | 248 | 0.615 | 0.614 | 0.072 |
| sub-rat3_sample-data9  | 215 | 0.689 | 0.698 | 0.078 |
| sub-rat4_sample-data12 | 199 | 0.647 | 0.660 | 0.095 |
| sub-rat6_sample-data15 | 230 | 0.640 | 0.640 | 0.061 |
| sub-rat8_sample-V915   | 219 | 0.637 | 0.640 | 0.077 |
| **all** | **1642** | **0.655** | **0.660** | **0.075** |

These are textbook-normal healthy g-ratios (~0.6–0.7), and are pinned by the
tests in `tests/test_reference.py`.
