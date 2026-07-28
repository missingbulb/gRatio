# Growth — discover local packs (per repo)

A weekly reflection on **this repo's own** captured knowledge: knowing the Claudinite packs already available to it, notice when project-specific knowledge is worth organizing into a **new local pack** — and author it. A local operation: it writes only the repo's **own** `.claudinite/local/packs/`, landing through a PR **a human reviews** (unlike [growth-extract](../growth-extract/task.md), which auto-merges; the shared canon stays human-gated too — lifting a local pack up is the central promote task's job). Finding nothing new worth a pack is a perfectly good, common outcome.

You run under the executor, dispatched by a `ready-for-agent` issue. There is no windowed Context to bind — the opportunity is standing (knowledge that was never organized into a pack, not a recent change), so examine the repo as it is.

The task's declared outcome ceiling is **`open-pr`**: it opens a PR and **never arms auto-merge**. Extract auto-merges because it adds prose or a rule to territory a local pack already owns; a **new pack** ships new `.mjs` conformance checks that run at every Stop and in CI the moment it merges — a check can break CI, so it's reviewed, exactly as the sibling [prose-to-checks-sweep](../prose-to-checks-sweep/task.md) is.

## Conventions used in this doc

- **GitHub access is MCP-only** (`mcp__github__*`) for issue/PR work; read the repo's own tree from the working checkout (local git), never a cross-repo clone.
- **The repo's local packs** are everything under `.claudinite/local/packs/` (the legacy `.claudinite/local_packs/` accepted during the rename window) — the repo's own packs.
- **The available canon packs** are the read-only mounted shelf under `.claudinite/shared/packs/` — what Claudinite already homes for this repo. Knowing the shelf is how you avoid re-creating locally what the canon already covers.

## The pipeline

### 1. Manifest the repo's own stack

Catalogue what this project is built on and how it ships — grounded in its files (dependency/build manifests, lockfiles, toolchain/config, CI and release workflows, packaging/signing scripts, source structure, docs), citing the concrete evidence. Do **not** yet consult the pack shelf or decide anything about packs — this step only observes.

**Never infer from "projects like this usually…"; if the repo doesn't show it, it is not in the manifest.** If something is present but appears vestigial or aspirational (declared but unused), include it and say so. Be **comprehensive over concise**: a later step filters and decides, so a true item you omit is lost, while an over-included one is cheaply dropped. When unsure whether something rises to an entry, include it with the `?` flag.

Catalogue across **three axes**. Put each item under the single axis that fits best; when it genuinely spans two, place it under the primary and cross-note the other.

- **Technologies** — languages and their versions, runtimes, frameworks, build systems, and the major libraries that shape how you write and build here (the load-bearing ones, not every transitive dependency).
- **External services / APIs** the project integrates with.
- **Deployment / distribution mechanisms** — how it ships and to where.

For **each** item report: **name**; **axis**; **evidence** (the file(s), and what they show); **what it is in this repo** (one line); **prominence** — one of `core` (the project is built on it), `supporting` (used but peripheral), `vestigial` (present but apparently unused); and a **`?` flag** if you are uncertain the item is real or correctly characterised. Prominence is a factual read of how central the item is *in this repo* — **not** a judgment about whether it deserves any downstream treatment. Output the manifest as Markdown grouped under the three axis headings, one bullet per item with the fields labelled.

### 2. Find the gap — what is pack-worthy but unhomed

Now hold the manifest against two things: the **available canon packs** (`.claudinite/shared/packs/`) and the repo's **existing local packs**. A candidate for a new **local** pack is a technology or domain that:

- the repo genuinely uses (not `vestigial`), and carries real, reusable working knowledge for — a build/config gotcha, a domain rule, a project-specific procedure that recurs; **and**
- **no canon pack already homes** — a technology is **homed**, so drop it, when any pack owns it, **a stub pack included** (if the canon covers it, the repo should just *declare that canon pack*, not re-create it locally — note that as the action instead); **and**
- the repo's **existing local packs don't already capture** (if a local pack owns that territory, a new rule belongs in it — that's [growth-extract](../growth-extract/task.md)'s job, not a new pack).

What remains is project-specific knowledge that deserves its own local pack: a domain the project works in, or a technology the canon doesn't home, with enough captured knowledge to justify a pack rather than a loose rule.

### 3. Author the local pack — distilled from the repo's real usage

For each candidate, author a populated pack under `.claudinite/local/packs/<name>/`, distilled from **how this project actually works** — never from imagination. Apply the [generate-project-instructions](../../skills/generate-project-instructions/SKILL.md) method (don't re-derive it): descend the promotion ladder ([engine/checks/DESIGN.md](../../../../engine/checks/DESIGN.md)) — a rule a deterministic check can carry becomes the **check plus a see-it-fail fixture** (fires on a violating input, quiet on a clean one), a procedure with a nameable trigger becomes a skill, and only signature-less judgment lands as `RULES.md` prose. Ground and cite every rule in the project's real files. **Never pad** with speculative best-practice rules the evidence doesn't demonstrate; a rule you can't ground, you don't write — a smaller honest pack beats a padded one. And **never open an empty stub to fill later**. Write the pack files (`RULES.md`, `pack.mjs`, `README.md`), register it, and **declare it** in the repo's `.claudinite-checks.json` so it actually activates.

### 4. Open the PR for review

Land the new pack (and its declaration) through a single PR on a per-run-unique branch (see [the git-github-advanced skill](../../../git-github/skills/git-github-advanced/SKILL.md)) — title `Claudinite growth: discover local pack <name>`, and **put the issue reference in the commit message**: `Refs #<n>` for this task's tracking issue (below), in the commit itself, not only the PR body, so the `task-lifecycle` gate passes. **Never arm auto-merge** — the reviewer is the point. A new check must still ship green (see it fail on a violating fixture, pass on a clean one) so CI stays green and the reviewer has something mergeable; a rule that can't be made a confident check lands as prose instead.

## Tracking

The standing log is the issue titled exactly **`Claudinite tracker: Discover Local Packs`** in this repo. Find it **by that exact title, never a fuzzy match or a hard-coded number**; create it already closed if missing. **Never open, close, or reopen it** — its state carries no meaning, only the log does. Log each run as a **dated comment**: the pack authored (technology/domain + the rungs its rules landed on), or "nothing new worth a local pack this run", and any "should declare canon pack X instead" note. For a candidate you found nothing groundable for, name it and why.

## What this task must never do

- **Never touch the shared canon or another repo** — it writes only this repo's own `.claudinite/local/packs/`.
- **Never re-create locally what a canon pack already homes** — declare the canon pack instead, and note it.
- **Never author from imagination or pad, and never open an empty stub** — every rule traces to the project's real usage; a pack may be small, it may not be invented.
- **Never add a rule to a territory an existing local pack already owns** — that is growth-extract's job; this task is for *new* packs.
- **Never conflate steps 1 and 2** — the manifest step catalogues and never consults the pack shelf; the gap step is where the shelf and the pack decision come in.
- **Never arm auto-merge** — a new pack's checks reach every session and every CI run in this repo; the reviewer is what stands between a wrong check and a red repo.
- **Run on `opus`** — judging pack-worthiness and authoring a pack (checks and fixtures included) is heavy judgment; a reviewer is a backstop, not a substitute for getting it right. This task declares `agent_model: opus`.
