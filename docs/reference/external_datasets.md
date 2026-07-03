# External datasets — public EM cross-sections for the corpus

Curated sources of myelinated-axon EM cross-sections like `data/samples/`
(TEM, dark concentric myelin on a light field), for growing the corpus and for
validation. Ranked by fit = modality match × g-ratio availability × ease.

**Two ground-truth tiers — they plug into different harnesses:**

- **g-ratio labels** (a published g per image, no masks) → validate the
  *number* via `validate_external.py`. Cannot score segmentation IoU.
- **segmentation masks** (per-pixel axon/myelin) → score *segmentation* via the
  `evaluate_segmentation.py` / `report.py` path, and derive per-axon g with
  `gratio/reference.py`. This is the tier the three `data/samples/` sit in.

Do not mix them: fabricating masks for a g-labelled set to force it into the IoU
harness violates the "GT is annotated, never invented" rule (see user_masks.md).

## Tier 1 — TEM cross-sections WITH published g-ratios

### macaque_cc  ✅ ingested → `data/external/macaque_cc/`
8 TEM images of one cynomolgus macaque corpus callosum, 9.144 nm/px, ~21×28 µm,
dense myelinated axons. **Aggregate g-ratio per image** (Table 1: g_agg
0.67–0.75). **CC-BY 4.0.** Visual dead-ringer for `sample_03`. Fetched from
Europe PMC by `data/external/macaque_cc/fetch.py`.
- Paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC4510539/ (DOI 10.1016/j.dib.2015.05.019)
- Ground truth: **g-ratio labels** (image-level), no masks.

## Tier 2 — TEM/SEM cross-sections WITH masks (→ per-axon g via reference.py)

| Dataset | What | Access | License |
|---|---|---|---|
| **White Matter Microscopy DB** | The bulk source. Curated CNS+PNS white-matter EM across 7 institutions, multi-species, **SEM+TEM**, many with axon/myelin masks. What AxonDeepSeg is built on. | [osf.io/yp4qg](https://osf.io/yp4qg/) (OSF API for scripted pulls) | Free, per-dataset attribution |
| **AxonDeepSeg SEM** | 10 rat spinal-cord SEM crops + manual masks. `git clone`-able. ⚠️ SEM = *bright* myelin (inverted vs our TEM) — needs a polarity flip. | [github.com/axondeepseg/data_axondeepseg_sem](https://github.com/axondeepseg/data_axondeepseg_sem) | MIT |
| **AxonDeepSeg TEM** | Mouse-brain TEM patches, 0.01 µm/px + macaque, axon/myelin masks. Our samples' own modality. | in WMMDB / neuropoly | — |
| **AxonCallosumEM** | Whole mouse corpus callosum (Rett model), dense axon **and** myelin-sheath masks, very large. | [arXiv:2307.02464](https://arxiv.org/abs/2307.02464) | see paper |

## Tier 3 — bulk / 3D / specialized (no per-image g table)

- **gACSON** — 6 SBEM 3D volumes, rat cortex (sham + TBI); myelin-thickness & g
  morphometry. Take 2D slices. MIT: [github.com/AndreaBehan/g-ACSON](https://github.com/AndreaBehan/g-ACSON)
- **Human superficial white matter, 3D multibeam SEM** (NeuroImage 2025) —
  128,285 segmented myelinated axons. Big/3D.
- **nanotomy.org** — human MS-vs-control brain, large-scale 2D STEM, open access,
  browsable viewer (blocks scripted download).

## The scale gotcha (why external data isn't drop-in)

Our samples are *zoomed* (1–5 axons). WMMDB/macaque fields are *wide* (dozens–
hundreds of small axons). The pipeline is tuned for the zoomed view
(`min_axon_frac=0.02`), so on a full macaque field it detects **0 axons**, and
on a crop it finds only the biggest 2–3 and over-extends the myelin band. A
scale-aware / multi-scale pass is needed before these segment cleanly; until
then `validate_external.py` is the harness that gap is measured against.
