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
| `tidy-issues` | daily | an issue was touched in the window | the touched issues — **all** open ones when `main` also moved substantively | **yes** — close / label / comment | `sonnet` |
| `tidy-prs` | weekly | an open PR was opened or updated in the window | every open PR (a full sweep) | no — recommends closes | `sonnet` |
| `tidy-branches` | weekly | a branch beyond the default and the infra branches was created or moved in the window | every such branch (a full sweep) | no — recommends deletions | `sonnet` |

Each applies its per-object skill (`single-issue-triage` / `single-pr-status` /
`single-branch-status`) across the targets the precondition hands it, then rewrites its tracker
(`Claudinite tracker: Tidy Issues` / `Tidy PRs` / `Tidy Branches`) from those verdicts.

**Nothing new, no run.** Every dimension is gated on *its own* objects moving in the window: no issue
touched, no `tidy-issues`; no open PR opened or updated, no `tidy-prs`; no branch created or pushed,
no `tidy-branches`. The verdicts over an unmoved set are the ones already in the tracker, so a re-run
rewrites the body with itself and spends an agent to do it. What does **not** count as movement: a
`main` that advanced (that widens an already-triggered issue run, but never wakes one — on an active
repo it is true most days), a PR that merged, and a push to the default or infra branches.

**Where the "full run" lives.** Scope is never narrowed to the movers, because a verdict is relative to
the rest — superseded-by, already-in-`main`, implemented-by-a-commit all need the others in view. So
newness is the **gate** and the full set is the **scope**. For issues the widening to every open issue
is signal-triggered on a substantive default-branch move, because that move is what can make an old
issue implemented. For PRs and branches "full" is the **frequency declaration** — weekly, and full
whenever it runs. Never a `fullSweep` flag inside a daily task: weekly is a declaration, not a gate
trick (per-project-scheduling DESIGN §3).
