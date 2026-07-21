# CLAUDE.md — session warm-up

Read this first. It caches the things you'd otherwise have to reverse-engineer
by reading the whole codebase each session. Deep detail lives in
`docs/reference/`; this is the map and the muscle memory.

## What this project is

Computes the myelin **g-ratio** from EM cross-sections of axons, using an
**area-based** definition (robust to malformed / non-hermetic myelin):

```
g = sqrt( A_axon / (A_axon + A_myelin) )      # < 1; = radius ratio for a perfect annulus
```

`A_axon` = axon interior area, `A_myelin` = actual myelin material area. Areas
are direction-independent, so malformed myelin correctly lowers the sheath.
Dimensionless → no spatial calibration; scale bars are ignored.

## How to work on this — the iterate-and-show loop (read this)

The owner's preferred way of working, and the deliverable *style*, not optional
polish. Full procedure: **`docs/reference/working_process.md`**. In short:

1. **Diagnose visually first** — render current behaviour and *look*; measure any
   fact a decision hinges on with a throwaway diagnostic (don't guess).
2. **Prototype in the scratchpad** — don't touch tracked code yet.
3. **Show a `[ original | result ]` (and `| ground truth`) comparison in the
   chat** (`SendUserFile`, `display: render`). Picture leads; IoU/g numbers
   confirm *after*, never instead.
4. **Get a read, then wire it in fully** — source (not generated artifacts) →
   regenerate → `pytest -q` green + report `evaluate_segmentation.py` deltas →
   commit & push → record an **R-note** in `user_masks.md` (incl. what you tried
   and *rejected*).

Respect the invariants below (single-sample special-casing, scale-free myelin,
recall = the hard constraint) or the change gets reverted.

## Environment (a fresh container has NONE of these)

```bash
pip install -r requirements.txt        # opencv-python-headless, numpy, scipy
pip install -r requirements-dev.txt    # + pytest
pip install pymupdf                    # only if processing an annotation PDF (see below)
```

- **PDF rendering:** poppler/`pdftoppm` is NOT installed. Use **PyMuPDF**
  (`import fitz`) to render annotation PDFs, never `pdftoppm`.
- Newer opencv/numpy/scipy than the pins work fine.

## Repo map

| path | what |
|------|------|
| `gratio/pipeline.py` | **the pipeline**: `segment()`, `render()`, `render_comparison()`, `analyze_image()`, `DEFAULTS`. Big file; the tuned params live in `DEFAULTS`. |
| `gratio/mask_extract.py` | turn hand-annotated crops into axon/fibre/myelin label masks. Auto-detects two annotation schemes (red-boundary vs per-neuron-fill). |
| `gratio/gt_register.py` | template-match a crop onto its raw micrograph → warp GT masks into native pixels. |
| `gratio/evaluate.py` | IoU/Dice + detection precision/recall of a segmentation vs GT. |
| `gratio/reference.py` | trusted g-ratio straight from AxonDeepSeg SEM masks (validation baseline). |
| `analyze.py` | CLI: run the pipeline → `outputs/<stem>_gratio.{png,csv}`. |
| `extract_masks.py` | run mask extraction on the annotated crops (self-checks axon counts). |
| `build_ground_truth.py` | register annotations → write `data/samples/masks/native/`. |
| `evaluate_segmentation.py` | segment raw + score vs native GT → `outputs/eval/`. |
| `validate_external.py` | segment external images + compare mean g to a **published** g (mask-free) → `outputs/external/`. |
| `data/external/` | external corpus (see `docs/reference/external_datasets.md`). `macaque_cc/` = 8 CC-BY TEM images + `fetch.py`. |
| `gratio/phase1_*.py`, `phase2.py` | older research spikes, NOT the main path. "The pipeline" = `gratio.segment`. |

## How to run

```bash
python analyze.py data/samples/*.png -o outputs/   # the pipeline; side-by-side + CSV per image
python report.py                                   # SHOW THIS: [original|result|GT] + per-neuron metrics
python build_ground_truth.py                       # (re)build ground truth from the masks
python evaluate_segmentation.py                    # score pipeline vs ground truth (masks)
python data/external/macaque_cc/fetch.py           # fetch external macaque TEM set (CC-BY, once)
python validate_external.py                         # mean g vs PUBLISHED g on the external set
python -m pytest -q                                # synthetic + GT + evaluation regression tests
```

**Two validation tiers — don't confuse them.** The three `data/samples/` have
hand-drawn **masks**, so they score *segmentation* (IoU/recall + per-neuron g) via
`evaluate_segmentation.py` / `report.py`. External sets like `macaque_cc` have a
**published g but no masks**, so they score only the *g-ratio number* via
`validate_external.py` — never wire a mask-free set into the IoU harness
(fabricating masks breaks "GT is annotated, never invented"). See
`docs/reference/external_datasets.md` and R34 in `user_masks.md`.

When presenting results to the owner, run `report.py` (thin/transparent 3-panel
figures + per-neuron accuracy/recall + g-ratio pred-vs-GT + timing), **not** the
raw `analyze.py` overlay. Format spec: `docs/reference/working_process.md`.

## The three samples (`data/samples/`)

| file | size | notes |
|------|------|-------|
| `sample_01.png` | 803×604 | malformed cluster: 4 axons + 5 orange non-myelin pockets; left myelin broken/non-hermetic. |
| `sample_02.png` | 871×844 | single healthy axon, thick concentric myelin (the clean parity case). |
| `sample_03.png` | 482×505 | 5-axon touching cluster, thin myelin. |

Current pipeline g-ratios (axon-id order): s01 ≈ 0.67/0.64/0.60/0.75, s02 ≈ 0.70
(lamella-trimmed; 0.69 pre-trim), s03 ≈ 0.82/0.68/0.72/0.85/0.65. Segmentation vs GT
means ≈ axon 0.94 / myelin 0.86 / fibre 0.96, detection 1.00/1.00 (means after
R31/R32 + the single-neuron lamella trim R34; see user_masks.md).
Phase-3 omit on s01 ≈ IoU 0.64, recall 0.69, precision 0.90.

## Ground truth — how it works (READ before touching it)

The masks under `data/samples/masks/native/*_gt_*.png` are **generated, not
hand-edited**. Source of truth = the hand-annotated `data/samples/masks/<stem>_masked.png`
crop. To fix GT, fix the crop (or the extraction) and regenerate — never edit the
native PNGs (they get overwritten). Full procedure:
**`docs/reference/gt_from_masks.md`**.

Two annotation schemes, auto-detected from the ink:
- **red-boundary** (samples 1–2): purple loop = axon, red loop = fibre outer,
  orange = omit; fibres via red-ridge watershed.
- **per-neuron-fill** (sample 3, current best practice, **no red**): purple loop
  = axon; each neuron's myelin is a **distinct translucent colour fill** whose
  outer edge is the myelin boundary. Dropping the red line was a deliberate fix —
  a separate red outer line could disagree with the painted fill.

Gotcha: translucent fills overlap the pen in *hue* but separate by *saturation*
(pen S ≈ 230, fills S ≈ 90). Handwritten `#N` are open purple strokes below
`MIN_REGION_FRAC` → auto-dropped; numbering is positional, digits are not read.

## Design principles (owner directives — violating these gets reverted)

- **No single-sample special-casing.** Every rule must generalise across samples
  (see the R24 audit in `user_masks.md`). Don't key logic on a stem.
- **Myelin rules must be scale-free and g-ratio-prior-free.** Cap the band by the
  axon's *own measured ring thickness*, never by a pixel constant or a fraction
  of the axon radius (that bakes a g-ratio into a g-ratio measurement). See R20.
- **Recall is the hard constraint.** A missed axon merges its myelin into a
  neighbour and corrupts that fibre — false negatives are unacceptable. Tuning
  targets recall = 1.0, no false positives, then maximises IoU.
- Borders are **smooth, roughly-closed** shapes (hand-tracing look), not pixel
  staircases and not strict ovals.
- **Record cross-domain applicability out-of-band.** When a sub-phase plausibly
  applies to another neurobiology problem (e.g. the lamella tracer → membrane
  reconstruction / myelin-compaction readouts), note it as a **pointer** in
  `docs/reference/neurobiology_applications.md` — a direction, need not be certain.
  **Keep it out of the algorithm body**: code and inline comments stay strictly
  about the g-ratio task and its `A-*` assumptions. Add an entry whenever you build
  or substantially change a sub-phase.

## Where the deep rationale lives

- `docs/reference/working_process.md` — **how to iterate here**: the diagnose →
  prototype → show → wire-in loop and the definition of done.
- `docs/reference/continuation.md` — resume state, how-to-run, tuned params & why.
- `docs/reference/user_masks.md` — the full method narrative + the numbered
  **R-notes** (R19–R30): every fix, what was wrong, what was tried and rejected.
- `docs/reference/requirements.md` — the owner's requirements.
- `docs/reference/assumptions.md` — modelling assumptions (A-MYELIN-DENSE, etc.).
- `docs/reference/gt_from_masks.md` — how to make GT from a masked PDF.
- `docs/reference/myeltracer_notes.md` — relation to the MyelTracer reference.
- `docs/reference/neurobiology_applications.md` — what we're building + **pointers**
  to where individual sub-phases might apply to other neurobiology problems (the
  out-of-band home for that speculation; see the Design-principles rule).
- `docs/reference/lamella_continuation.md` — the lamella-tracing outer-boundary
  refinement (`gratio/lamella.py`, single-neuron images): method, evidence, standing.

## Known open items

- Malformed-axon inner boundary (sample_01 #2 arc, sample_03 #5 inner) needs a
  local, not global, refinement.
- Orange **omit** / non-myelin pockets are now subtracted from A_myelin
  (**Phase 3, R32**: `detect_nonmyelin`, A-NONMYELIN-BRIGHT). Residual: two faint/
  thin sample_01 pockets (a dim outer sliver, a thin edge-bay) are left in — not
  recoverable without gutting sample_02's clean myelin.
- Isolated fibre (sample_02) outer bound rests on a geometric cap, not evidence
  of an outer membrane; a per-side (ridge-terminated) outer boundary is the next
  tool. See the "Residual" / "Known limits" sections of `user_masks.md`.
- **Scale transfer to wide fields.** The pipeline is tuned for the zoomed 1–5
  axon sample view (`min_axon_frac=0.02`), so on dense wide fields like
  `macaque_cc` it detects 0 axons full-frame and only the largest 2–3 in a crop
  (`validate_external.py`: crops mean |Δg| ≈ 0.16). A scale-aware / multi-scale
  detection pass is the unlock for the external corpus (R34).

@.claudinite/shared/CLAUDE.md

> Claudinite self-check: if the `@.claudinite/shared/CLAUDE.md` import above did not resolve (no `.claudinite/shared/CLAUDE.md` in this checkout), the Claudinite harness is **not active** this session — a broken or partial checkout. Treat it as not loaded and confirm with the user before substantive work.
