# tidy-repo — the repo tidy-up policy

The PR/branch/issue sweep, active wherever this pack is declared. The repo's own scheduler runs the
pack's three maintenance tasks — `tidy-issues`, `tidy-prs`, `tidy-branches`, one per dimension; this is
the policy they follow. The per-object **method** lives in the pack's skills
([single-branch-status](skills/single-branch-status/SKILL.md),
[single-pr-status](skills/single-pr-status/SKILL.md),
[single-issue-triage](skills/single-issue-triage/SKILL.md)).

The one rule that shapes everything: **assess PRs and branches read-only; act only on issues.**

- **Branches, PRs — assess only.** Report which should stay and which are safe to close/delete;
  **never** delete, push, merge, or close them. Judge by *content* (the landed-status test), never a
  ref's auto-generated name.
- **Issues — act.** Take the first applicable action: close-if-implemented / needs-decision / blocked
  / quick-win / leave. "Implemented in `main`" means the issue's actual ask is true of `main`'s
  content **now** — confirm it there and cite it; when you can't, comment, don't close. Every action
  defaults to the reversible option (comment / leave) when the check is inconclusive.

Each task applies its single-object skill across the targets its precondition hands it, then rewrites
**its own** standing tracker from the verdicts it gathered (one issue per dimension per repo, body
rewritten to today's state, a dated comment per run). One tracker per task, never a shared one: the
three tasks are independent and may run at once, so nothing races to rewrite one body.
