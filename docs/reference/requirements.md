# Requirements — gathered from the working sessions

This captures the **informal requirements** the project owner gave while iterating
on the axon/myelin segmentation, so they are not lost between sessions. They are
grouped by theme; each is phrased as a durable requirement, with the owner's
intent in parentheses where useful.

## Scope & goal

- **R1.** Build a *repeatably executable* classic-CV algorithm that segments
  **axon** and **myelin** from the **raw grayscale** EM micrographs
  (`data/samples/sample_0X.png`) — not from the annotations.
- **R2.** The owner's hand-drawn masks are the **ground truth**; every change is
  validated by overlap (IoU) against them (`evaluate_segmentation.py`).
- **R3.** The **area-based g-ratio is deferred** ("too advanced for us now").
  Focus on getting the masks right; g is reported but not the target.
- **R4.** Primary target is the **three clean TEM samples**. The AxonDeepSeg SEM
  reference set is a *different regime* (inverted contrast, hundreds of tiny
  dense axons) and is out of scope except as a transfer demo.

## Mask semantics (the owner's annotation convention)

- **R5.** **purple** = the axon boundary (axolemma / inner edge of the myelin).
- **R6.** **red** = the myelin **outer** boundary. Myelin is the annulus between
  the purple and red loops.
- **R7.** **orange** = regions to **omit** — bright vacuoles / bubbles / non-myelin
  inclusions. They must be excluded from the myelin area (handled "later").
- **R8.** Enclosed regions (axons, omit regions) are **numbered by hand**.
- **R9.** Where two cells touch, the owner draws the **inter-cell separation
  line** between their myelin sheets; it is a real cue (suggested by tonal
  differences) and should be used to tell adjacent cells apart. (Simple in
  sample_03; strongly curved / hard in sample_01's bottom-left vs central cell.)

## Detection — hard constraints

- **R10.** **Perfect recall.** Every axon must be found. A missed axon merges its
  myelin into the neighbour and corrupts that fibre's measurement — false
  negatives are unacceptable.
- **R11.** **No false positives** either — no phantom axons/fibres.
- **R12.** Any preprocessing (e.g. scale-bar removal) that would cost an axon is
  unacceptable; correctness of the segmentation outranks any cosmetic clean-up.

## Axon (inner) border

- **R13.** The inner axon border should be a **simple, smooth curve** like a hand
  tracing — "as a curve it's much simpler than what you're drawing." (Repeatedly
  emphasised across samples 1 and 2.)
- **R14.** Smoothing must **not shrink** the region or erode small axons.
  Preferred direction: fit the border as a **least-squares smooth curve /
  cubic Bézier** (Schneider-style), which is area-unbiased — *implemented*.

## Myelin (outer) border

- **R15.** The myelin outer bound should be a **smooth rounded envelope**, not a
  spiky outline with **protrusions / tentacles** reaching into the extracellular
  space.
- **R16.** But do **not over-round**: rounding that trims genuine myelin and
  lowers fidelity was explicitly rejected ("a bad direction, lower quality").
  Keep the boundary accurate to the real structure.
- **R17.** **Compactness sanity check**: a fibre's myelin circumference vs. the
  area it covers should be roughly the ratio of an **oval/circle**. Tentacles
  make it wrong quickly and should be rejected.
- **R18.** **Small axons can have proportionally thick myelin** — do not clip
  their myelin with a fixed radial cap (sample_01 #1 was ~half its true width).
  *Implemented via an absolute band floor.*
- **R19.** For **malformed** fibres, the outer bound must **enclose the
  imperfections (bubbles)** — it should wrap around them, not notch inward and
  cut the border *before* the bubbles (sample_01 #2). The bubbles are then
  flagged and excluded from myelin area, but stay inside the fibre outline.

## Visualization (for review & discussion)

- **R20.** Colour **each axon a different colour**, and colour each fibre's
  **myelin** to match its axon. *Implemented (`render_labeled.py`).*
- **R21.** Put a **number at each axon centre** so specific axons can be referred
  to by number in discussion. Numbering is positional (top→bottom, left→right)
  and consistent between the prediction and ground-truth panels.

## Image artifacts

- **R22.** A burn-in **scale bar** ("200 nm", bottom-right) confuses segmentation
  (notably sample_01 #4). Either **detect & remove** it or ignore and work on
  clean images — but subject to R12 (never lose an axon). *Implemented: removed
  only when it sits in clean background; skipped when it overlaps a fibre.*

## Per-sample owner feedback (running notes)

- **sample_01** — the hard case (malformed central axon #2, broken/loose myelin,
  bubbles). Open items: #2 outer border still cut before the bubbles (R19);
  #3/#4 inner-axon marking; inter-cell separation for the bottom-left vs central
  cell (R9).
- **sample_02** — single clean axon. Axon border smoothness ✔ (R13). Myelin
  corner protrusions remain by design (R16 — accuracy over rounding).
- **sample_03** — multiple small clustered axons. Owner: "really, really good" —
  **do not regress it** when tuning.

## Deferred / future work

- **F1.** Exclude the **orange omit regions** from the myelin area (R7).
- **F2.** **Inter-cell separation** along the hand-drawn line (R9) for touching
  cells.
- **F3.** **Vector / SVG export** of the fitted Bézier borders (borders are now
  curves, so this is set up).
- **F4.** The **area g-ratio** once masks are trusted (R3).
- **F5.** A tuned **dense-SEM** regime for the AxonDeepSeg reference set (R4).
