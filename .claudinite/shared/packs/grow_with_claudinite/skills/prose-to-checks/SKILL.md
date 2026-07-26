---
name: prose-to-checks
description: Mine a repo's existing pack prose (RULES.md, SKILL.md) for always-testable rules that were never converted to checks, and convert the strongest ones. Use when auditing packs for convertible rules, or when the growth prose-to-checks sweep runs.
---

# Convert existing prose to checks

A completeness-critic over a repo's own packs. The growth *extract* stage converts each **new**
lesson down the promotion ladder; this pass sweeps the **existing** prose backlog for rules that
are always-testable but still live only as prose — and converts them, so the packs keep shedding
context over time instead of only at the moment a rule is first learned. It runs as
grow_with_claudinite's daily `prose-to-checks-sweep` task, and on demand.

## Scope — the pack paths you were given

Work only the **pack paths configured for this repo** (the task passes them in its Context): a
consuming repo's own **local packs** (`.claudinite/local/packs/`) by default — projects don't
improve core canon packs — while **Claudinite itself** also sweeps its core `packs/`. Read the
prose under those paths (each pack's `RULES.md`, and any `SKILL.md` beside them). Never edit a
read-only mounted canon pack under `.claudinite/shared/`.

## What to look for — the check-the-world test

For each rule, ask the one question from
[engine/checks/DESIGN.md](../../../../engine/checks/DESIGN.md): **does it constrain a *static
signature in the repo artifact* — something a post-hoc scan could observe?**

- **Yes → a conversion candidate.** A dangling-reference rule, a filename convention, a workflow
  or manifest shape, a "these two files must agree" invariant, a forbidden pattern in code.
- **No → leave it.** In-flight process (leaves no artifact — "see the test fail first"),
  judgment ("name by scope"), or knowledge whose failure is only visible at runtime (jsdom
  diverging from Chrome). These are why the rule is prose; don't force them.

The check-the-world rule from DESIGN holds: if a rule is always-testable, it was never really
part of the on-demand skill — it belongs in a pack as a check.

## How to convert one

Follow the extract stage's check-authoring discipline (the local promotion ladder in
[extracting-lessons.md](../../extracting-lessons.md)). For each candidate:

1. **Author the check** in the owning pack (`<pack>/<rule>.mjs`, listed in its `pack.mjs`) — the
   failure message *is* the rule (what / why / fix / `doc:` pointer back to the prose).
2. **Write the fixture first and see it fail** — a violating fixture must find, a clean one must
   not (the test lives beside the pack's other tests). A conversion with no proving fixture
   doesn't ship.
3. **Ship at real severity, fail-fast** — blocking for a defect, advisory only when the rule is
   directional by kind.
4. **Trim the prose** to rationale — the check owns enforcement now; leaving both pays twice and
   springs the drift trap.

**Before writing a rule off as un-checkable, try parsing the file's structure instead of grepping
its text.** Grep finds the pattern anywhere; parsing finds it in the one spot the rule means —
which kills the false alarm. (Example: `Authorization` is only wrong inside a CloudFront policy's
*own* header list, not elsewhere in the template.) Parse only as much as you need, and hold the
check to the same fixture bar.

When even a scoped parser can't make detection confident, **leave the prose and log the
candidate** to a tagged conversion-backlog issue rather than shipping a shaky check.

## Bounds

- **One PR, bounded surface** — the new rule module, its `pack.mjs` line, its fixture, and the
  trimmed prose. Don't "improve" unrelated rules while you're in there.
- **Never delete a rule you didn't convert** — trimming prose is only for a rule a *landed* check
  now enforces.
- Run the suite and the sweep green before opening the PR; open it for the owner's approval,
  never a direct push to `main`.
