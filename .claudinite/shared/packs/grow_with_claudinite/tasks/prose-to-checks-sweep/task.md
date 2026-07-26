# Prose-to-checks — sweep this repo's pack prose

Mine the **existing** prose of this repo's packs — each pack's `RULES.md` / `SKILL.md` — for always-testable rules that were never converted to checks, and convert the strongest ones. Where [growth-extract](../growth-extract/task.md) descends the ladder for each *new* lesson, this task works the *backlog*: standing prose that was always mechanizable but never converted.

You run under the executor, dispatched by a `ready-for-agent` issue whose **Context section is binding scope**: it names the **pack paths** to sweep. Work only those paths — a consuming repo's own local packs by default; Claudinite also its core `packs/`. **Never** edit a read-only mounted canon pack under `.claudinite/shared/`.

The task's declared outcome ceiling is **`open-pr`**: convert prose to checks in a single owner-approved PR (a check can break CI or misfire, so it is reviewed, not auto-merged).

## The method lives in the skill

The conversion method — how to spot an always-testable rule in prose, judge convertibility, author the check plus its **see-it-fail** fixture, and decide what stays prose — is owned by the [**prose-to-checks** skill](../../skills/prose-to-checks/SKILL.md). Follow it; don't re-derive it here. This worker only frames the unattended run around it.

## What a run does

1. **Pick convertible prose** under the Context's pack paths — rules that are *always testable* (a deterministic condition a check could assert) and that no existing check already covers. Prefer the strongest, clearest candidates; converting one or two solid rules well beats churning many shakily.
2. **Convert per the skill** — author the rule module in its owning pack, register it in that pack's `pack.mjs`, and add a **fixture test that fires on a violating input and stays quiet on a clean one** (see-it-fail is mandatory — a check that can't be made confident is left as prose, never shipped broken). Trim the now-redundant prose to rationale.
3. **Open a PR** — one PR for the run's conversions on a per-run-unique branch, its commit referencing the tracking issue so the `task-lifecycle` gate passes. Keep the repo's offline test suite green before opening.
4. **Log to the tracker** — the standing log is the issue titled exactly **`Claudinite tracker: Prose to Checks`** in this repo. Find it **by that exact title, never a fuzzy match or a hard-coded number**; create it already closed if missing. **Never open, close, or reopen it**. Log each run as a **dated comment**: the prose converted and the check id it became, or "nothing convertible this run".

## What this task must never do

- **Never ship a check that can't be made confident** — the see-it-fail fixture is the gate; an unprovable rule stays prose.
- **Never convert a rule an existing check already covers** — dedupe against the check set first.
- **Never touch a pack path outside the Context**, and **never edit a mounted canon pack** under `.claudinite/shared/` — a consumer improves only its own local packs.
- **Run on `opus`** — judging convertibility and authoring checks + fixtures is heavy judgment; this task declares `agent_model: opus`.
