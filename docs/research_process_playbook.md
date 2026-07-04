# Research Project Working Procedures — a portable playbook

This document defines **how the owner wants a research project run**, as a
**bootstrap to drop into a new research project** from day one. It is written to
be project-agnostic: it carries the durable working procedures and none of the
subject matter, methods, or results of any particular study.

It is aimed at the recurring class of research it is meant for: **run an
algorithm over a set of similarly-formatted inputs, score it against
user-provided ground truth, and improve the algorithm in repeatable, reviewable
iterations.** Image analysis / computer vision is the archetypal case and the
examples lean that way, but the workflow, ground-truth discipline,
anti-overfitting stance, and session hygiene apply to research work broadly —
read "algorithm", "input", and "render" as whatever they mean for your project.

Treat it as a **default to adapt, not a contract**. When a new project needs a
rule this one doesn't have, add it; when a rule here doesn't fit, say why and
drop it. As you work a real project, replace the generic phrasing with that
project's concrete specifics (its inputs, metrics, invariants) in *that
project's own* docs — keep this bootstrap generic so it stays reusable. The one
non-negotiable is the spirit: **show the work visually, prove each change against
ground truth, never overfit the learning set, and leave the project resumable.**

---

## 1. The core loop — iterate on the algorithm, and *show* every step

This is the cadence the owner wants, and it is the **deliverable style**, not
optional polish. Follow it for every substantive algorithmic change.

1. **Reproduce & diagnose — visually, first.** Start from the actual inputs.
   Render the current behaviour and *look* at it before theorising. If a
   decision hinges on a measurable fact (a colour/intensity split, a threshold,
   an over-reach, a distribution), write a **throwaway diagnostic and measure
   it** — do not guess. Cheap, disposable diagnostics beat argument.
2. **Prototype in the scratchpad.** Build the change as a standalone script
   first. Do **not** touch tracked code yet.
3. **Show a comparison in the chat.** Surface a rendered **[ original | result ]**
   side-by-side — and **[ … | ground truth ]** wherever scoring applies —
   directly in the conversation (render it inline, don't just link a path). The
   **picture leads**; numbers (accuracy metrics, the target quantity) come
   *after* it as confirmation, **never instead of it**.
4. **Get a read, then commit to the approach.** Only once the visual result is
   right do you wire it into the tracked code. If a call is genuinely ambiguous
   or is the owner's to make, ask **one** targeted question; otherwise proceed on
   a sensible default and state what you chose.
5. **Wire it in fully** — see *Definition of done* (§5).
6. **Record it** as a numbered iteration note — what was wrong, what changed, the
   metric delta, and **what you tried and rejected** (§5).

### Show, don't just tell
- Every algorithmic change is presented as a rendered comparison against the
  original, and against ground truth when scoring is involved. Prefer a clean,
  purpose-built **results figure** over a wall of metrics.
- The presentation render is usually **not** the debug overlay. Favour a thin,
  semi-transparent style that keeps the underlying data readable (thin lines,
  mostly-transparent fills), and give a matched object the **same colour in the
  result and the ground-truth panels** so over-/under-reach is obvious at a
  glance. Tag objects with small ids that key into the metrics table.
- Throwaway renders and diagnostics live in the scratchpad; only the **final
  artifact and the code that regenerates it** get committed.

### Interaction cadence
Keep the owner in the loop with **pictures**, proactively. Ask a question only
when a decision is genuinely theirs or the request is ambiguous — not to confirm
work you can verify yourself. When you finish a unit of work, leave it committed
and pushed so it can be reviewed or resumed from a fresh session.

---

## 2. Ground truth — user-provided, annotated, **never invented**

- **The owner's annotations are the ground truth.** Every change is validated by
  agreement against them, not against your own expectation of the answer.
- **Ground truth is annotated, never fabricated.** Do not invent labels to make a
  dataset scorable. If a dataset lacks the annotation a given harness needs, it
  does not go into that harness (see §9 on validation tiers).
- **Separate source-of-truth from generated artifacts.** The hand-annotation is
  the source; the machine-usable ground-truth (registered masks, parsed labels,
  normalized tables) is **generated from it and regenerated on demand** — never
  hand-edited, because the generator overwrites it. To fix ground truth, **fix
  the source annotation (or the extraction code) and regenerate**, then re-score.
- **Make extraction deterministic and self-checking.** Same annotation → same
  derived ground truth. Pin the things a human counted (number of objects,
  number of regions) as assertions/tests so a silent extraction regression fails
  loudly.
- **Auto-detect annotation conventions from the data**, don't hard-code a
  per-input flag. When the owner uses more than one annotation scheme over time,
  detect which scheme an input uses from the ink/markup itself. Record the
  **conventions** (what each colour / mark / region means) in a durable doc; they
  are requirements, not incidental.
- **Verify the annotation actually parses before trusting a score.** Inspect two
  things: did the markup parse into the labels you expected, and did the derived
  ground truth land correctly on the raw input (registration / alignment)? Keep
  the review overlays.

---

## 3. Inputs — a small, similarly-formatted learning set

- Projects like this begin with a **small learning set of similarly-formatted
  inputs** (same modality, same acquisition regime, same annotation convention).
  That is a feature — it lets you iterate fast and look closely — and a hazard:
  it is small enough to overfit (§4).
- **State the input format explicitly** (dimensions, modality, contrast
  convention, expected content per input) so a mismatched new input is diagnosed
  fast. Keep a one-line-per-input table.
- **Name the primary target regime and what is out of scope.** A different
  regime (inverted contrast, far denser or sparser content, a different scale)
  is a *transfer* problem, not the main path — treat it as such until explicitly
  in scope.
- **Scale-awareness is a first-class concern.** An algorithm tuned for one
  input scale (e.g. a zoomed view of a few objects) often fails on another
  (a wide field of many). Know which regime you are tuned for, and measure the
  gap on the other rather than pretending it's covered.

---

## 4. Do not overfit the learning set

This is the discipline that keeps a small-set project honest. These are **hard
constraints** — a change that violates one gets reverted even if it improves a
metric.

- **No single-input special-casing.** Every rule must generalise across the set.
  If a fix only helps one input, say so and either generalise it or drop it.
  Never key logic on a specific input's identity/filename.
- **Keep decision rules free of the very prior you are trying to measure.** If
  the project measures quantity *X*, no rule may bake in an assumed value of *X*
  (that turns the measurement into an assumption). Prefer rules expressed in
  terms the input **measures for itself** over fixed constants.
- **Prefer scale-free rules over pixel/absolute constants.** Where a constant is
  unavoidably tied to the current data's scale/resolution, **isolate and label
  it** as scale-dependent so it is the first thing revisited on new-scale data.
- **Name the hard constraint the task cannot trade away**, and tune to it first.
  Some projects have a metric that is non-negotiable (e.g. a failure mode whose
  cost dominates all others); identify yours, hold it at its required level
  *first*, and optimise the softer metrics only underneath it. Make it explicit
  so a later tuning pass doesn't quietly trade it away.
- **Keep a registry of domain assumptions, each with a failure mode.** Choices
  that encode a prior about the *subject or the instrument* (not pure
  processing) are named, located in the code with an inline tag, and given an
  explicit "how it fails on mismatched data" note. When a new input looks wrong,
  the first diagnostic is *"which assumption did this input break?"* — and that is
  only fast if the assumptions are written down. Flag the thinly-supported ones
  (e.g. calibrated on a single example) honestly.
- **Guard the wins with regression tests.** An input the owner has blessed as
  "very good" must not silently regress when you tune for another. Pin its score.

---

## 5. Repeatable improvement iterations — the numbered notes, and *definition of done*

Each accepted change is recorded as a **numbered iteration note** (pick a short
tag and stick to it, e.g. `R1, R2, …`) in a running method-narrative doc. The
point is that **the next session does not re-derive what this one already
learned.**

An iteration note captures:
- **What was wrong** (the observed failure, ideally with the diagnostic that
  showed it).
- **What changed** (the rule/parameter and why, in scale-free terms where
  possible).
- **The metric delta** — before/after, per input, on the real scoring harness.
- **What you tried and rejected, and why.** Rejected approaches are as valuable
  as accepted ones; they stop the next session (or the next model) from walking
  back into the same dead end.

### Definition of done for an accepted change
- **Source updated — never the generated artifacts.** (Regenerate them.)
- **Artifacts regenerated** with the committed generators.
- **Tests green**, and the **scoring deltas reported** (per input, per metric).
- **Committed with a clear message and pushed**, so the work is reviewable and
  resumable from a fresh session / another machine.
- **Learnings cached**: the iteration note above, plus a pointer/update in the
  session warm-up doc or the relevant reference doc **if the map or procedure
  changed**.

---

## 6. Research phases, and spikes vs the main path

- **Separate work into explicit phases**, each with a bounded deliverable, and
  say which phase a piece of work belongs to. Defer the hard/advanced piece
  explicitly rather than half-building it — e.g. get an intermediate output
  trusted before building the final quantity that depends on it.
- **Distinguish research spikes from the maintained pipeline.** Exploratory
  scripts are worth keeping for reference, but the repo map must make clear what
  "the pipeline" actually is versus what was an older spike, so a new session
  doesn't mistake a dead branch for the main path.
- **Keep a "known open items" / deferred list** so the boundary between "done",
  "deferred by choice", and "not yet attempted" is never ambiguous.

---

## 7. Reading & summarizing source articles

When a paper, tool, or reference method matters to the project:

- **Write a self-contained notes file so the source never has to be re-read.**
  Capture everything algorithmically relevant: the exact method/pipeline and its
  parameters, the definitions and formulae, calibration details, and **sanity-check
  values** you can validate your own outputs against.
- **Explicitly record where your approach diverges from the reference and why.**
  The divergence is often the whole point of the project; make it legible.
- **State what you deliberately omitted** (material not relevant to the
  algorithm — e.g. procedural/experimental setup detail, incidental statistics,
  acknowledgements) and that you cross-checked against the full text — so a later
  reader trusts the summary is complete for its purpose.
- Note that upload paths for source PDFs are **session-specific and won't
  persist**; the notes file is the durable artifact, not the upload.

---

## 8. Extracting images — samples vs illustrations

- **Samples** are inputs you will run the algorithm on; **illustrations** are
  figures that explain a method or a definition. Keep the two roles distinct and
  store extracted figures alongside the notes that reference them.
- **Render documents with a library, not an assumed system binary.** The
  environment often lacks common tools (e.g. a PDF rasterizer such as poppler /
  `pdftoppm`); use an in-process library instead. Locate embedded raster images
  and render just the region you need, at a zoom high enough to read fine
  annotation, with a little padding to catch ink drawn outside the frame.
- **Verify identity when an extracted image should match an existing input**
  (e.g. an annotated crop over an original) by an exact pixel diff — so you know
  an annotation set is a labelling of the *same* data, not a new input.

---

## 9. Fetching more sample data from the outside

- **Grow the corpus from public sources that match the input regime.** Curate and
  **rank candidates by fit** = modality match × ground-truth availability × ease
  of access, and record licence and provenance for each.
- **Make ingestion a committed, repeatable fetch script**, not a manual download,
  so anyone can reproduce the corpus.
- **Respect the two validation tiers — and don't mix them:**
  - **Full ground truth** (per-item annotations) → scores the *algorithm's
    detailed output* (overlap / detection) on the real harness.
  - **Aggregate label only** (a published summary number, no per-item
    annotation) → validates the *summary quantity* the project reports, and
    nothing finer.
  Wiring an aggregate-only dataset into the detailed-overlap harness would force
  you to **fabricate annotations**, which violates §2 ("ground truth is annotated,
  never invented"). Keep a separate, mask-free validation path for those sets.
- **External data is rarely drop-in.** Expect a scale/regime gap (§3) and
  *measure* it with the appropriate tier rather than assuming the corpus is
  covered.

---

## 10. Environment limitations — stay lightweight

- **A fresh container has nothing installed.** Assume dependencies must be
  installed each session, and keep the dependency set **small and lightweight** —
  favour a compact set of core libraries over heavy frameworks (e.g. large ML
  stacks) that are slow to install and awkward to run anywhere. Prefer a
  lightweight solution that installs in seconds and runs anywhere.
- **When a heavy or learned approach is genuinely the right tool, treat it as a
  gated, isolated route** (documented, opt-in, scoped to the cases that need it)
  rather than a new baseline dependency — and prove the lightweight route is
  exhausted first.
- **Route around missing system binaries with libraries** (see §8). Document the
  exact install lines and any "install ad hoc, not in requirements" tools in the
  warm-up doc.

---

## 11. Getting — and evaluating — algorithm ideas from the owner

The owner will suggest algorithms and directions to try next. Treat these as
first-class experiments:

- **Take the suggestion seriously even when the project has declared a direction
  "exhausted."** A suggestion may belong to a *different family* than everything
  tried so far, which is exactly when it can break a wall the previous family
  couldn't. "We already tried X" rarely covers a genuinely different approach.
- **Evaluate it the same way as any change**: diagnose the wall it targets, build
  the evidence that the wall is real (or isn't), prototype, and show a comparison.
- **Document the outcome fully**, including the routes that hit a wall and *why*
  (name the specific trade-off or signal that defeated them). If the idea needs
  capabilities the environment won't allow (§10), record the concrete route to
  try when that changes, so the thread is resumable rather than lost.
- **Complementary routes are not competitors.** Two methods can attack the same
  problem from different angles; keep both documented and say how they relate.

---

## 12. Record cross-domain applicability **out-of-band**

When a sub-step of the algorithm plausibly applies to **another problem** beyond
the current task, record it as a **short pointer in a dedicated side document** —
a direction worth attention, not a validated claim, and it need not be certain to
be worth noting. **Keep this speculation out of the algorithm itself**: code and
inline comments stay strictly about the task at hand and its stated assumptions.
This keeps the core legible and honest about what it is *for* while not losing
genuinely useful observations that surface while building it. Add an entry
whenever you build or substantially change a sub-step.

---

## 13. Continuity across sessions

The owner works across many sessions and machines. Every session should end in a
**resumable** state.

- **Commit and push** finished units of work; leave the project runnable from a
  clean checkout.
- **Maintain a session warm-up doc** (the "read this first" map): what the project
  is, how to run it, where the tuned parameters and the deep rationale live, and
  the current numbers. It should let a new session skip re-reading the whole
  codebase.
- **Maintain a continuation guide**: where things stand, exact run commands, the
  tuned parameters and *why they exist*, and the open items. Keep the headline
  metrics current in it.
- **When the owner asks for a different way to do something, capture the new way
  durably — don't just do it this once.** A correction to *how* work is done (how
  results are shown, what command to run, a naming/format convention, a step to
  always take or skip) is a standing preference, not a one-off. Fold it into the
  warm-up doc — or a reference doc linked from it — so the next session reaches
  the same state without being told again. Prefer editing the doc that already
  owns that topic over adding a stray note; if the change contradicts what's
  written, replace it and say what changed. The test: *could a fresh session, with
  only the warm-up doc, reproduce this new behaviour?* If not, it isn't captured
  yet.
- Follow the repo's **branch/commit/PR conventions**: develop on the named
  branch, commit with clear messages, push; don't open a PR unless asked.

---

## 14. Reviving a prior session to **enhance this document** (not to continue the research)

This document is meant to keep improving as the owner works. Some of the owner's
process preferences live only in the **dialogue of earlier Claude Code (web)
sessions**, not in any committed file. If the owner revives such a session and
points it at this playbook, here is the instruction for that revived session:

> **Your job in this revived session is to mine our conversation for *process and
> working-style preferences*, and fold them into
> `docs/research_process_playbook.md` — NOT to continue the research task itself.**
> Re-read the whole dialogue and extract only the durable, project-agnostic
> signal about *how the owner wants research run*: how they want results shown;
> what they praised or rejected about the workflow (not just the algorithm);
> ground-truth and annotation conventions; anti-overfitting rules they insisted
> on; how they want articles summarized, images extracted, and external data
> fetched; environment constraints they flagged; and how they hand off algorithm
> ideas. For each item, strip out anything specific to this project's subject
> matter and generalise it to the class of "run a CV/analysis algorithm over
> similarly-formatted inputs, scored against user ground truth, improved in
> reviewable iterations." Then propose additions/edits to the relevant numbered
> section above (merge, don't duplicate; keep the principle-first phrasing). Show
> the owner a diff of what you'd add and confirm the wording before committing.
> **Do not run or modify the research pipeline.** If a preference contradicts what
> is already written here, surface the conflict for the owner rather than silently
> overwriting.

To make revival productive, when the owner asks for it they should say **which
session(s)** to revive (a link or a description) and, if possible, what topic the
process discussion centred on — so the revived session knows where in the
transcript to look.
