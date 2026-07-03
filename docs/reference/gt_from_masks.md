# Generating ground truth from hand-annotated masks

How to turn a hand-annotated **masked image** (delivered as a PDF/PowerPoint of
the sample micrographs with ink drawn on top) into **registered ground-truth
masks** that a raw-data segmentation can be scored against. This is the
procedure distilled from the working sessions — follow it whenever a new or
corrected annotation arrives.

## 0. What "ground truth" is here

The native GT masks under `data/samples/masks/native/*_gt_*.png` are **generated
artifacts, not hand-edited files**. The chain is:

```
masked crop (your ink)          data/samples/masks/<stem>_masked.png
   │  gratio/mask_extract.extract()      colour ink -> axon/fibre/myelin labels
   │  gratio/gt_register.register()      align that crop onto the raw micrograph
   ▼  build_ground_truth.py
native GT masks                 data/samples/masks/native/<stem>_gt_{axon,fiber,myelin}.png
   │  gratio/evaluate.py (evaluate_segmentation.py)
   ▼
IoU / detection scores vs the raw-data pipeline
```

**Never hand-edit the `native/*_gt_*.png` files** — `build_ground_truth.py`
overwrites them. Fix the *source* (the `_masked.png` crop, or the extraction
code) and regenerate.

## 1. Annotation schemes (auto-detected)

`extract()` picks the scheme from the ink itself — no per-sample flags.

### red-boundary scheme (samples 1–2)
- **purple** loop  → axon boundary (interior = axon area)
- **red** loop     → myelin **outer** boundary (interior = whole fibre)
- **orange** loop  → non-myelin pocket to **omit** (Phase 3): the closed loops are
  filled into `omit_labels`, warped to `_gt_omit.png`, and subtracted from the
  myelin GT (`myelin = fibre − axon − omit`). Saturated-orange pen gated, so a
  translucent fill is never read as one; the handwritten `#N` glyphs drop out below
  `OMIT_MIN_REGION_FRAC`.
- Fibres = marker-controlled watershed: each axon is a seed, an "outside" seed
  floods extracellular space, the red line is a ridge. Myelin = fibre − axon.

### per-neuron-fill scheme (sample 3 — the current best practice)
- **purple** loop         → axon boundary (inner)
- **translucent colour fill** → that neuron's myelin; the fill's **outer edge is
  the myelin outer boundary**. Each neuron gets a **distinct hue**.
- **No red line.** Removing it was the key fix: a separate red outer line can
  disagree with the painted fill and corrupt the band. With per-neuron fills the
  myelin comes straight from the colour the user painted, and distinct hues split
  shared walls with zero ambiguity ("which bit belongs to which axon").

Detection rule: if a **saturated red line** (`_red_line_mask`, S ≥ 150) covers
≥ `MIN_REGION_FRAC` of the image → red-boundary scheme; else → per-neuron-fill.

## 2. Colour separation — the one real gotcha

The translucent fills **overlap in hue** with the purple/red pen (navy fill vs
purple pen; coral fill vs red pen). They separate cleanly by **saturation**,
because the pen is drawn hard and the fills are translucent:

| ink                     | hue (OpenCV H, 0–179) | saturation |
|-------------------------|-----------------------|-----------:|
| purple **pen** (axon)   | 140–150               | ~230 (high)|
| red **pen** (old outer) | 0–10 / 170–180        | ~180 (high)|
| per-neuron **fills**    | distinct per neuron   | ~90–110    |

So: gate the **axon pen** with `S ≥ PURPLE_LINE_MIN_SAT (150)`; gate **fills**
with `FILL_SAT = (45, 165)`. Handwritten `#N` labels are the same purple ink but
are open strokes below `MIN_REGION_FRAC` → dropped automatically. Numbering is
positional (reading order); the handwritten digits are **not** read.

Verify separability on any new palette with a hue histogram of saturated pixels
and a per-hue spatial map (see `scratchpad` scripts `s03_clusters.png` in the
session that added this) before trusting the extraction.

## 3. Rendering a masked PDF into per-sample crops

Poppler (`pdftoppm`) is usually **not** installed; use **PyMuPDF** (`pip install
pymupdf`). The raw micrographs are embedded images placed on the page; locate
each by `page.get_image_rects(xref)` and render that page region (with a little
padding to catch ink drawn outside the frame) at ~4× zoom:

```python
import fitz
doc = fitz.open("annotations.pdf"); page = doc[0]
for stem, xref in placements.items():          # xref of each raw image
    r = page.get_image_rects(xref)[0]
    clip = fitz.Rect(r.x0-14, r.y0-14, r.x1+14, r.y1+14) & page.rect
    page.get_pixmap(matrix=fitz.Matrix(4, 4), clip=clip).save(f"{stem}_masked.png")
```

Match embedded-image dimensions to the samples to identify them (sample_01
803×604, sample_02 871×844, sample_03 482×505). Save the chosen crop to
`data/samples/masks/<stem>_masked.png`.

## 4. Extract → register → build

```bash
python extract_masks.py         # sanity: per-sample axon counts, review overlays -> outputs/masks/
python build_ground_truth.py    # register onto raw, write native GT + <stem>_gt_check.png
python evaluate_segmentation.py  # score the raw-data pipeline against the new GT
python -m pytest -q             # extraction + evaluation regression tests
```

Registration (`gt_register.register`) recovers the (scale, offset) that places
the raw image inside the crop by multi-scale template matching (normalised
correlation; expect score ≈ 0.78–0.90). Inspect two review images:
`outputs/masks/<stem>_extract.png` (did the ink parse right?) and
`data/samples/masks/native/<stem>_gt_check.png` (did it land on the raw image? —
green = axon, red = fibre).

## 5. Review render (per the owner's guideline)

For a human-facing GT figure, draw on the **clean raw** micrograph:
- **1 px, semi-transparent white** line at the axon boundary,
- **1 px, semi-transparent** line in **each neuron's own myelin colour** at the
  myelin outer boundary,
- over a **faint** per-neuron fill.

Colour each neuron's line by the median hue of its fill (boosted S,V) so the
figure echoes the annotation. Render on the clean raw (not the crop) so the
handwritten numbers don't show. Reference implementation:
`render_gt()` in the session scratchpad `make_gt2.py`.

## 6. If you change the number of axons or omit pockets

Update the pinned counts or the self-check and tests fail:
- axons: `EXPECTED` in `extract_masks.py`, `EXPECTED_AXONS` in
  `tests/test_mask_extract.py` (currently `sample_01: 4`, `sample_02: 1`,
  `sample_03: 5`).
- omit pockets: `EXPECTED_OMITS` in `tests/test_nonmyelin.py` (currently
  `sample_01: 5`, `sample_02: 0`, `sample_03: 0`).

## Dependencies

`opencv-python-headless`, `numpy`, `scipy` (runtime); `pymupdf` (PDF rendering,
not in requirements — install ad hoc); `pytest` (tests). A fresh container has
none of these preinstalled.
