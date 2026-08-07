# gratio — the measurement invariants

This project's own pack: what is specific to measuring a myelin g-ratio from EM
cross-sections here, and to nothing the canon packs already home. The working
loop (show every step, ground truth annotated never invented, numbered
iterations, spikes vs. main path) is the declared `research-project` pack's — it
is not repeated here. Five rules of this pack are deterministic checks
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

## Give `pytest` an explicit timeout

`python -m pytest -q` green is this repo's definition of done
(`docs/reference/working_process.md`), and the suite takes about **two minutes** —
52 tests, `124.73s` self-reported, measured 2026-07-28 — because the regression
tests re-run the real segmentation over every sample and rebuild the ground
truth. That is *past* the 120s an agent shell allows a command by default, so the
run gets pushed to the background mid-suite and the obvious recovery is to start
it over: one green result cost **274s** of wall clock instead of ~130s, with two
suites running at once for part of it.

So run the suite as its own Bash call with an explicit timeout of at least 300s,
and do the `pip install -r requirements.txt -r requirements-dev.txt` (a fresh
container has neither) as a *separate, earlier* call — chaining the install in
front of the suite is what pushes the pair over the default. If a suite does end
up backgrounded, wait on the one that is already running rather than launching a
second.

## There is no PR CI here, so arming auto-merge will always fail

The only workflow, `claudinite-scheduler.yml`, triggers on `schedule` and
`workflow_dispatch` — nothing in `.github/workflows` runs on `pull_request`, so no
PR in this repo ever gets a check run and `enable_pr_auto_merge` cannot be armed.
Expect that; it is the standing shape of the repo, not a fault to route around.

**Do not treat the failed arm as a gap to close by hand.** Canon decides what
happens next, and it does not need help: `deliveryAction` in
`packs/basics/tasks/baselining/worker.mjs` reads `auto-merge` + no PR CI as
`merge`, on the reasoning that GitHub's auto-merge is a queue for checks and a
repo with no checks has nothing to queue behind — an armed-and-waiting PR there
just sits open forever. Read that function rather than restating it here; if this
repo ever gains a `pull_request`-triggered workflow the same call starts
returning `arm` instead, and this section is obsolete.

What is *not* delegated to canon is the procedural half. On 2026-07-26 a run was
explicitly instructed to arm auto-merge rather than merge; when the arm failed it
squash-merged its own PR #24 anyway, and its dispatch converged to `needs-human`
(#18). The merge destination turned out to match what canon later encoded — the
cost came from improvising past an explicit instruction without stopping to
report it. When the instruction you were given and the outcome you can reach
disagree, say so and stop; that is the reportable result, whichever way the
delivery question is eventually settled.
