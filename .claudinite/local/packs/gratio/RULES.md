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

## Auto-merge is off; stop at the PR

`enable_pr_auto_merge` cannot be armed in this repo — GitHub answers *"Auto-merge
is not enabled for this repository"* (Settings → General → Pull Requests → Allow
auto-merge is unchecked), and there is no CI workflow to gate on either: the only
workflow, `claudinite-scheduler.yml`, is a cron shim that produces no check runs,
so `get_check_runs` on any PR here returns `total_count: 0`.

A routine told to "land this through an auto-merging PR" therefore **cannot**, and
the failure looks like a one-command gap that squash-merging your own PR would
close. Don't. That is exactly what happened on 2026-07-26: the run squash-merged
its own PR #24 with zero checks and no review, tripped the merge-without-review
classifier, and its dispatch converged to `needs-human` instead of done — the
merge cost more than the unlanded change would have. Observed again 2026-07-29,
so treat it as the standing state, not a blip.

The correct outcome is an **open PR plus a plain statement that auto-merge could
not be armed and why** — an unmerged PR is a complete, honest result for a
`merged-pr` ceiling, and the owner enabling the repo setting is the only real
fix. Verify before assuming: if a future run's `enable_pr_auto_merge` succeeds,
the setting was turned on and this section should go.

There is also no repo-*settings* write tool on this GitHub MCP surface — only
per-PR `enable_pr_auto_merge`, which itself presupposes the repository setting is
already on. An instruction like "enable auto-merge in repo settings" is therefore
not actionable by any session here beyond naming the exact path
(Settings → General → Pull Requests → Allow auto-merge); don't burn a `ToolSearch`
pass hunting for a repo-settings tool that doesn't exist (four queries, ~24s,
2026-07-29 on issue #37).

## On `LGTM`: read the recipe, skip the main sync

The `merge-to-main` skill is not mounted in this repo: `.claudinite-checks.json`
declares `basics`, `barriers`, `research-project`, `tidy-repo`,
`grow_with_claudinite`, `local/gratio` — never `git-github` — so
`Skill({skill:"merge-to-main"})` always answers *"Unknown skill:
merge-to-main"* (hit on issues #32 and #37, 2026-07-28/29). The owner's `LGTM`
still means that recipe; until `git-github` is declared, read it directly from
`.claudinite/shared/packs/git-github/skills/merge-to-main/SKILL.md` rather than
invoking the Skill tool.

That recipe's step 5, syncing local `main` after the MCP merge
(`git checkout main && git pull origin main`), buys nothing here and should be
skipped: `capture-log.mjs` writes through git plumbing against the fetched
remote tip, never the local checkout, so nothing downstream reads a synced
`main`. Switching off the session's own branch to run it is also expensive and
unreliable — measured 9s/147s/81s/40s of wall clock across four runs, with one
(issue #37) denied twice by the auto-mode classifier and abandoned for zero
benefit. Go straight from `merge_pull_request` to `capture-log.mjs --issue <n>`.
