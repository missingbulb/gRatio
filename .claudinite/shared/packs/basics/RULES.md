# Working discipline

The working discipline that isn't itself a GitHub operation — general habits for how to approach a change, independent of any one project.

Start every requested change from the *problem*, not the solution — in any repository, not just this one. Before implementing, reach an explicit shared understanding with the owner of the problem the change is meant to solve **and** agreement that the requested change is the best way to solve it; a different fix, or no change at all, may serve the underlying problem better.

Open your reply to an owner comment with an explicit classification line — `Comment class: correction | feature | process-change | other` (`other` covers questions, approvals, and command phrases; a mixed comment names each part). The class decides where the change lands and what must exist before any fix.

1. **A correction** — you misunderstood something. Repair the shared understanding, then rework what the misread already touched; the artifact changes as much as the correction demands, but a correction never adds a new requirement or rule.
2. **A feature** — agree on the requirement, record it in the project's requirements document (its executable spec, where it keeps one), write the test that proves it and watch it fail, then implement until it passes.
3. **A process change** — the owner is changing *how* work is done. The change lands as durable rules in the project's local scope — its own local packs (in Claudinite itself, its packs) — routed through the mechanism promotion ladder (platform setting → hook → check → skill → prose); promoting a rule into the shared canon is the growth lifecycle's separate call, not the interactive session's. Author the assurance first — the check the future world must satisfy — execute it and watch it fail, and only then make the fixes that turn it green. When the ladder lands the rule at prose (an in-flight judgment rule no check can carry), the equivalent step is showing the corpus doesn't already cover the rule before writing it.

The two build modes share one spine: state the expectation in its durable home first, watch it fail against the current world, then change the world to satisfy it — a fix made before its assurance exists can never show it addressed what the owner actually asked for.

Before building a mechanism for a behavior, verify against a real run that it isn't already provided.

When feedback flags a misunderstanding, check whether the artifact is already correct before expanding it — if it is, say so and push back rather than editing; a misread doesn't imply the text is wrong. And size writing to its idea: "open one issue" takes a sentence, not three paragraphs.

When correcting or auditing an artifact against an authoritative source, derive the corrected version from the *source* before reading the existing draft, then diff against the old draft to surface what was actually wrong — reading the draft first anchors you to its framing and quietly carries its errors into your "fix."

Fix build/test/CI warnings rather than tolerating them, with a small, targeted fix that addresses the *cause* in the same change — a clean run makes a genuinely new warning or error stand out.

Suppressing a warning — muting it with a flag (e.g. `--disable-warning`), `eslint-disable`, swallowing it, etc. — is **not** a small fix and never the quick path: reach for it only as a deliberate, reviewed decision once the real fix has been weighed and rejected. A suppression you do keep must **carry its reason at the site**: on the suppression line, or in the comment immediately above it, saying why the fix was rejected — that inline reason *is* the review record, so no second justification is recorded elsewhere.

Before working around a finding from a vendored check, confirm the vendored copy is current — it reflects its last refresh, not upstream's head, so the fix may already exist upstream and simply not be pulled in yet.

When a warning can't be fixed with a small cause-addressing change now without hindering current work (e.g. it's waiting on an upstream release, or the real fix is a larger refactor), open a dedicated issue for it unless one is already open, then move on — resolving it (real fix, or a consciously-chosen suppression) happens in that issue's own change.

An approval — to merge, to ship, to proceed — applies only *backward*, to the work already in front of the owner when it's given, never to anything requested or done *after* it. A later follow-up, even a fix to the just-approved change, needs its own explicit approval; a chosen answer to a multiple-choice prompt isn't authorization just because an option's wording mentioned the action.

# The task lifecycle

The issue → branch → PR lifecycle every new task follows, independent of any one project. The rest of the git/GitHub procedures live in the `git-github-advanced` skill.

For every new task:

1. Create a GitHub issue describing the task before starting work.
2. Develop on a branch; reference that issue number in commit messages (e.g. `Refs #123`, `Fixes #123`, or `Closes #123`).
3. Update the issue's status (comments / close) as work progresses and when it's done.
