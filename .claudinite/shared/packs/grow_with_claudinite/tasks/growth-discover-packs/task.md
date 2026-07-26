# Growth — discover local packs (per repo)

A weekly reflection on **this repo's own** captured knowledge: knowing the Claudinite packs already available to it, notice when project-specific knowledge is worth organizing into a **new local pack** — and author it. A local operation: it writes only the repo's **own** `.claudinite/local/packs/`, landing through a PR that **auto-merges once the repo's checks pass** (like [growth-extract](../growth-extract/task.md); the shared canon stays human-gated — lifting a local pack up is the central promote task's job). Finding nothing new worth a pack is a perfectly good, common outcome.

You run under the executor, dispatched by a `ready-for-agent` issue. There is no windowed Context to bind — the opportunity is standing (knowledge that was never organized into a pack, not a recent change), so examine the repo as it is.

The task's declared outcome ceiling is **`merged-pr`**: it opens a PR and arms auto-merge (no human review — daily/weekly local capture never piles up as review requests). It writes only the repo's own local packs.

## Conventions used in this doc

- **GitHub access is MCP-only** (`mcp__github__*`) for issue/PR work; read the repo's own tree from the working checkout (local git), never a cross-repo clone.
- **The repo's local packs** are everything under `.claudinite/local/packs/` (the legacy `.claudinite/local_packs/` accepted during the rename window) — the repo's own packs.
- **The available canon packs** are the read-only mounted shelf under `.claudinite/shared/packs/` — what Claudinite already homes for this repo. Knowing the shelf is how you avoid re-creating locally what the canon already covers.

## The pipeline

### 1. Manifest the repo's own stack

Catalogue what this project is built on and how it ships — grounded in its files (dependency/build manifests, lockfiles, toolchain/config, CI and release workflows, packaging/signing scripts, source structure, docs), citing the concrete evidence. Do **not** yet consult the pack shelf or decide anything about packs — this step only observes. Note technologies, external services/APIs, and deployment/distribution mechanisms, each with a prominence read (`core` / `supporting` / `vestigial`).

### 2. Find the gap — what is pack-worthy but unhomed

Now hold the manifest against two things: the **available canon packs** (`.claudinite/shared/packs/`) and the repo's **existing local packs**. A candidate for a new **local** pack is a technology or domain that:

- the repo genuinely uses (not `vestigial`), and carries real, reusable working knowledge for — a build/config gotcha, a domain rule, a project-specific procedure that recurs; **and**
- **no canon pack already homes** (if the canon covers it, the repo should just *declare that canon pack*, not re-create it locally — note that as the action instead); **and**
- the repo's **existing local packs don't already capture** (if a local pack owns that territory, a new rule belongs in it — that's [growth-extract](../growth-extract/task.md)'s job, not a new pack).

What remains is project-specific knowledge that deserves its own local pack: a domain the project works in, or a technology the canon doesn't home, with enough captured knowledge to justify a pack rather than a loose rule.

### 3. Author the local pack — distilled from the repo's real usage

For each candidate, author a populated pack under `.claudinite/local/packs/<name>/`, distilled from **how this project actually works** — never from imagination. Apply the [generate-project-instructions](../../skills/generate-project-instructions/SKILL.md) method (don't re-derive it): descend the promotion ladder — a rule a deterministic check can carry becomes the **check plus a see-it-fail fixture** (fires on a violating input, quiet on a clean one), a procedure with a nameable trigger becomes a skill, and only signature-less judgment lands as `RULES.md` prose. Ground and cite every rule in the project's real files; **never pad**, and **never open an empty stub to fill later**. Write the pack files (`RULES.md`, `pack.mjs`, `README.md`), register it, and **declare it** in the repo's `.claudinite-checks.json` so it actually activates.

### 4. Open the auto-merging PR

Land the new pack (and its declaration) through a single PR on a per-run-unique branch — title `Claudinite growth: discover local pack <name>`, its commit referencing the tracking issue so the `task-lifecycle` gate passes — and **arm auto-merge**. A new check must ship green (see it fail on a violating fixture, pass on a clean one) so CI stays green and the PR can merge; a rule that can't be made a confident check lands as prose instead.

## Tracking

The standing log is the issue titled exactly **`Claudinite tracker: Discover Local Packs`** in this repo. Find it **by that exact title, never a fuzzy match or a hard-coded number**; create it already closed if missing. **Never open, close, or reopen it** — its state carries no meaning, only the log does. Log each run as a **dated comment**: the pack authored (technology/domain + the rungs its rules landed on), or "nothing new worth a local pack this run", and any "should declare canon pack X instead" note.

## What this task must never do

- **Never touch the shared canon or another repo** — it writes only this repo's own `.claudinite/local/packs/`.
- **Never re-create locally what a canon pack already homes** — declare the canon pack instead, and note it.
- **Never author from imagination or pad, and never open an empty stub** — every rule traces to the project's real usage; a pack may be small, it may not be invented.
- **Never add a rule to a territory an existing local pack already owns** — that is growth-extract's job; this task is for *new* packs.
- **Run on `opus`** — judging pack-worthiness and authoring a pack is heavy judgment, the more so because the PR auto-merges with no human review; this task declares `agent_model: opus`.
