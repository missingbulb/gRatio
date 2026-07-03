# Working process — iterate on the algorithm, and show every step

This is the cadence the owner wants for algorithmic work on this project. It is
not optional polish: **the visual, show-as-you-go loop is the deliverable style.**
Follow it whenever you change segmentation, extraction, or ground truth.

## The loop

1. **Reproduce & diagnose — visually.** Start from the actual micrographs. Render
   the current behaviour and *look* at it before theorising. If a decision hinges
   on a measurable fact (a colour split, a threshold, an over-reach), write a
   throwaway diagnostic and measure it — don't guess.
2. **Prototype in the scratchpad.** Build the change as a standalone script first.
   Do **not** touch tracked code yet.
3. **Show a comparison in the chat.** Surface a rendered **[ original | result ]**
   side-by-side (and **[ … | ground truth ]** where relevant) with `SendUserFile`
   (`display: "render"`). The picture leads; numbers (IoU, g) come *after* it, as
   confirmation — never instead of it.
4. **Get a read, then commit to the approach.** Only once the visual result is
   right do you wire it into the repo. Ambiguous call, or a choice that's the
   owner's to make? Ask one targeted question. Otherwise proceed on a sensible
   default and say what you chose.
5. **Wire it in fully** (see *Definition of done* below).
6. **Record it as an R-note.** Append to the numbered R-notes in
   `user_masks.md`: what was wrong, what changed, the score/g delta, and **what
   you tried and rejected**. Rejected approaches are as valuable as accepted ones.

## Show, don't just tell

- Every algorithmic change is presented as a rendered comparison against the
  original — and against the GT when scoring is involved. Reach for
  `render_comparison()` / the GT review render, not a wall of metrics.
- Render style (owner guideline): thin **1 px, semi-transparent** white line for
  the axon, thin 1 px semi-transparent **myelin-coloured** line for the myelin
  outer edge, over a faint per-neuron fill. Detail: `gt_from_masks.md` §5.
- Put throwaway renders/diagnostics in the scratchpad; only the final artifact
  and the code that regenerates it get committed.

## Diagnose before deciding

Cheap, disposable diagnostics beat argument. Examples that earned their keep here:
a saturated-pixel **hue histogram** + per-hue **spatial map** to prove the
per-neuron fills separate from the pen (before trusting the extraction); a
**cap/param sweep** to show a single radial cap can't fit a sheath whose true
thickness varies around the perimeter (so *don't* keep tuning it). Show the
diagnostic when it explains the choice; otherwise just keep it in scratchpad.

## Respect the invariants (or the change gets reverted)

These are hard constraints, not preferences (full text in `CLAUDE.md` →
*Design principles*):
- **No single-sample special-casing.** If a fix only helps one sample, say so and
  drop it — or generalise it. (See the R24 audit.)
- **Myelin rules stay scale-free and g-ratio-prior-free.**
- **Recall is the hard constraint:** 1.0 with no false positives first, then
  maximise IoU.

## Definition of done for an accepted change

- **Source** updated — never the generated artifacts (the `native/*_gt_*.png`,
  `outputs/*` are regenerated, not hand-edited).
- Artifacts **regenerated** (`build_ground_truth.py` / `analyze.py` /
  `evaluate_segmentation.py`).
- `python -m pytest -q` **green**; the `evaluate_segmentation.py` score deltas
  **reported** (per-sample axon / myelin / fibre IoU, detection P/R).
- **Committed** with a clear message and **pushed** (the owner works across
  sessions off `main`/the task branch — leave it in a runnable, pushed state).
- **Learnings cached** so the next session doesn't re-derive them: an R-note in
  `user_masks.md`, and a pointer/update in `CLAUDE.md` or the relevant
  `docs/reference/` file if the map or procedure changed.

## Interaction cadence

Show progress proactively and keep the owner in the loop with pictures. Ask a
question only when a decision is genuinely the owner's or the request is
ambiguous — not to confirm work you can verify yourself. When you finish a unit
of work, leave it committed and pushed so it can be reviewed (or resumed) from a
fresh session.
