---
name: adopt-pack
description: Add one or more packs to an already-adopted Claudinite member — declare, run each pack's adoption interview, re-vendor, scaffold, land. Use when asked to adopt, add, enable, or declare a pack (e.g. product-wiki, executable-requirements) on a repo that already runs Claudinite.
---

Adding a pack to a repo that already runs Claudinite. Whole-repo bootstrap and the on-demand
refresh are [adopt-claudinite](../adopt-claudinite/SKILL.md); this is the narrower act of turning
one or more packs on. The declaration is authoritative — declaring is the project's call — so the
work is: declare, answer what the pack asks, materialize its content, satisfy what it now demands.

## 1. Declare

Add each chosen pack's id to `packs` in `.claudinite-checks.json`. A pack that only makes sense
alongside another names it in `requires`; `resolveDeclaredPacks` pulls that closure in when the
declaration is written, so you declare what you *chose* and its dependencies follow (e.g.
`spec-driven-product` pulls `executable-requirements`). An unknown pack name — or an unknown
property on an entry — is a blocking **settings** error, not a conformance finding; fix the name.

## 2. Interview — the part that is easy to skip and must not be

A pack that needs the project's intent before it can provide value declares `questions` on its
manifest (see [packs/README.md](../../../README.md) and the machinery in
[../adopt-claudinite/interview.mjs](../adopt-claudinite/interview.mjs)). For **every** newly
declared pack that asks questions:

- Where a question says the repo may already hold the answer (a product brief, an existing
  requirements doc, the issue tracker), **read that first and confirm** rather than asking cold.
- Otherwise ask the owner directly (`AskUserQuestion`), one question at a time, at the point of
  adoption — the owner is present by construction here.
- Record each answer **verbatim** on that pack's entry as `answers: { "<question-id>": "<text>" }`.
  `"n/a — none wanted"` is a valid answer and stops the asking. Where the question carries a
  `distill` note, derive the entry's `config` from the answer (e.g. `executable-requirements`'s
  spec path → `config.spec`).

## 3. Re-vendor

The new packs' prose, checks, and skills must land under the tracked `.claudinite/shared/` mount.
Fetch a fresh canon to scratch and run its `vendoring/apply-vendor-set.mjs --target . --ref <sha>`
against the checkout — the same whole-set convergence the on-demand refresh uses (adopt-claudinite,
[bootstrap.md](../../../../bootstrap.md) Parts 1 and 4). It rebuilds `shared/` from the new vendor
set and advances the stamp; sessions never fetch.

## 4. Scaffold what the pack now demands

A newly active pack may require structure the repo doesn't have yet — deliberately, so the
declaration is a statement of intent that its own findings then guide you to satisfy. Run the
world sweep and let each finding name the file: e.g. `product-wiki` wants its index and the
reviewed `product-requirements/` sink before the isolation wall has anything to guard. Scaffold
per the pack's own README template; the pack's rules are the checklist.

## 5. Land

World and work checks green (`.claudinite/shared/engine/checks/check_the_world.mjs`; the Stop hook
carries the work checks). Commit referencing the task's issue, push, open one PR. Content a pack
seeds through this flow — a `product-wiki` wiki's first researched, cited pages — rides the same
review gate as any other change; it is never pushed straight to the default branch.
