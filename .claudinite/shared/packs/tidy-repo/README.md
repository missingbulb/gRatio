# tidy-repo

The repo tidy-up as a composable pack: the nightly PR/branch/issue sweep, contributed to the fleet
maintenance plan the same way any pack contributes checks and skills. Declaring `tidy-repo` enrolls a
repo in the sweep; removing it is a durable opt-out (baselining never re-adds it).

**Declared pack** — no fingerprint. `bootstrap --init` seeds it into every new repo, and the one-time
`tidy-repo-seed` baseline migration seeds the existing fleet. Carries **no conformance checks** — its
work is a maintenance task, not checks. Its policy (`RULES.md`): assess PRs and branches read-only, act
only on issues.

## Maintenance tasks

One task per dimension. Each is triggered by the only thing that changes its answers, scoped to
exactly those objects, and reconciles **its own** standing tracker — so no task waits on another and
a dimension with nothing to do stays silent:

| Task | frequency | Runs when | Scope | Acts? | model |
|---|---|---|---|---|---|
| `tidy-issues` | daily | an issue was touched, or `main` moved substantively | the touched issues — **all** open ones on a substantive move | **yes** — close / label / comment | `sonnet` |
| `tidy-prs` | weekly | any PR is open | every open PR (a full sweep) | no — recommends closes | `sonnet` |
| `tidy-branches` | weekly | any branch beyond the default and the infra branches exists | every such branch (a full sweep) | no — recommends deletions | `sonnet` |

Each applies its per-object skill (`single-issue-triage` / `single-pr-status` /
`single-branch-status`) across the targets the precondition hands it, then rewrites its tracker
(`Claudinite tracker: Tidy Issues` / `Tidy PRs` / `Tidy Branches`) from those verdicts.

**Where the "full run" lives.** For issues it is signal-triggered: a substantive default-branch move
widens scope to every open issue, because that move is what can make an old issue implemented. For
PRs and branches it is the **frequency declaration** — weekly, full every time (a branch verdict has
no windowed subset to narrow to, and both are standing recommendations for a human rather than
same-day alerts). Never a `fullSweep` flag inside a daily task: weekly is a declaration, not a gate
trick (per-project-scheduling DESIGN §3).
