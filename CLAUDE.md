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
| `gratio/phase1_*.py`, `phase2.py` | older research spikes, NOT the main path. "The pipeline" = `gratio.segment`. |

## How to run

```bash
python analyze.py data/samples/*.png -o outputs/   # the pipeline; side-by-side + CSV per image
python build_ground_truth.py                       # (re)build ground truth from the masks
python evaluate_segmentation.py                    # score pipeline vs ground truth
python -m pytest -q                                # synthetic + GT + evaluation regression tests
```

## The three samples (`data/samples/`)

| file | size | notes |
|------|------|-------|
| `sample_01.png` | 803×604 | malformed cluster: 4 axons + 4 orange omit regions; left myelin broken/non-hermetic. |
| `sample_02.png` | 871×844 | single healthy axon, thick concentric myelin (the clean parity case). |
| `sample_03.png` | 482×505 | 5-axon touching cluster, thin myelin. |

Current pipeline g-ratios: s01 ≈ 0.66/0.63/0.58/0.73, s02 ≈ 0.68, s03 ≈
0.68/0.82/0.72/0.65/0.84. Segmentation vs GT means ≈ axon 0.93 / myelin 0.85 /
fibre 0.95, detection 1.00/1.00.

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

## Where the deep rationale lives

- `docs/reference/continuation.md` — resume state, how-to-run, tuned params & why.
- `docs/reference/user_masks.md` — the full method narrative + the numbered
  **R-notes** (R19–R30): every fix, what was wrong, what was tried and rejected.
- `docs/reference/requirements.md` — the owner's requirements.
- `docs/reference/assumptions.md` — modelling assumptions (A-MYELIN-DENSE, etc.).
- `docs/reference/gt_from_masks.md` — how to make GT from a masked PDF.
- `docs/reference/myeltracer_notes.md` — relation to the MyelTracer reference.

## Git

Develop on the branch named in the task (e.g. `claude/sample-three-ground-truth-nhvtbw`);
create it from `main` if missing. Commit with clear messages; push with
`git push -u origin <branch>`. Do **not** open a PR unless asked.

## Known open items

- Malformed-axon inner boundary (sample_01 #2 arc, sample_03 #5 inner) needs a
  local, not global, refinement.
- Orange **omit** regions are detected but not yet subtracted from A_myelin.
- Isolated fibre (sample_02) outer bound rests on a geometric cap, not evidence
  of an outer membrane; a per-side (ridge-terminated) outer boundary is the next
  tool. See the "Residual" / "Known limits" sections of `user_masks.md`.
