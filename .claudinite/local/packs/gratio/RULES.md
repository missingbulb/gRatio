# gratio — the measurement invariants

This project's own pack: what is specific to measuring a myelin g-ratio from EM
cross-sections here, and to nothing the canon packs already home. The working
loop (show every step, ground truth annotated never invented, numbered
iterations, spikes vs. main path) is the declared `research-project` pack's — it
is not repeated here. Four rules of this pack are deterministic checks
(`README.md` lists them); what follows is the judgment that has no static
signature.

## Myelin rules stay scale-free and g-ratio-prior-free

`g = sqrt(A_axon / (A_axon + A_myelin))` is dimensionless, so nothing in the
measurement may depend on a magnification. Cap a myelin band by the axon's
**own measured ring thickness**, never by a pixel constant and never by a
fraction of the axon radius — a radius fraction bakes a g-ratio prior into a
g-ratio measurement, which is the one error the number cannot survive
(R20 in `docs/reference/user_masks.md`). The one-parameter shape of that
mistake — an absolute ceiling expressed as a fraction of axon radius,
shipped as everyone's default — is a check (`gratio-myelin-band-scale-free`
below); the broader judgment of what counts as "derived from the image, not
a pixel count" for any new parameter stays prose.

## Recall is the hard constraint, IoU is the objective

A missed axon does not merely lose one fibre: its myelin merges into a
neighbour's and corrupts *that* fibre's g. Tune for detection recall 1.0 with no
false positives first; only then maximise IoU. A change that trades a detection
for boundary accuracy is a regression however good the IoU delta looks.

## Borders look hand-traced

Deliverable borders are smooth, roughly-closed shapes — not pixel staircases,
and not strict ovals fitted over a real, irregular boundary. A smoothing
tolerance that rounds off genuine shape (the elongated tadpole axons) is too
strong even when it scores well.

## Show `report.py`, and write the R-note

Present results with `python report.py` — the `[original | result | GT]` panels
plus per-neuron accuracy, recall, and predicted-vs-GT g — never the raw
`analyze.py` overlay. Every change that lands gets a numbered **R-note** in
`docs/reference/user_masks.md` recording what was wrong, what was tried, and
what was **rejected**; that rejection log is what stops the next session
re-walking a dead end. Cross-domain applicability goes to
`docs/reference/neurobiology_applications.md`, never into the algorithm body.
