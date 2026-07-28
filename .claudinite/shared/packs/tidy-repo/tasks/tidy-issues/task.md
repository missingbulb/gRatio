# tidy-issues worker

The **acting** third of the repo tidy-up: triage the issues in scope, then record what you did. You run
under the executor, dispatched by a `ready-for-agent` issue; its **Context section is binding scope** — it
lists the issues to triage. Work only those; don't enumerate the repo yourself. GitHub access is
**MCP-only** (`mcp__github__*`).

The task's declared outcome ceiling is **`none`**: this task writes **issues only** (its triage actions and
its own tracker). It never opens, closes, merges, or comments on a PR, never touches a branch, and never
pushes — those dimensions belong to `tidy-prs` and `tidy-branches`, which are assess-only.

## 1. Triage each issue

For each issue in the Context list, run the [single-issue-triage](../../skills/single-issue-triage/SKILL.md)
skill. The skill owns the action ladder and the safeguards: "implemented in `main`" means the issue's actual
ask is true of `main`'s content **now** — verified there and cited, never inferred — and when the check is
inconclusive it **comments, doesn't close**. Collect what each triage did.

## 2. Reconcile this task's tracker

One standing tracker issue per repo, titled exactly `Claudinite tracker: Tidy Issues` — found by that
**exact title, never a fuzzy match**; create it **already closed** if absent (never a fresh issue per run,
never a bare number that can dangle). Each dimension keeps its **own** tracker, so three tasks never race
to rewrite one body.

Touch it two ways each run:

- **Rewrite the issue body** to today's **dated** snapshot: the actions taken this run and anything left
  for a human. The body is the live picture — it replaces yesterday's, it doesn't accumulate.
- **Add a dated comment** with today's status, so the body's snapshots leave a per-run trail.

Keep both short. **Never open, close, or reopen the tracker** — its state carries no meaning (the body is
the live picture; the state is just however it was created).

## 3. Retire the legacy tracker (transitional, one line of work)

Repos tidied before the split carry a single combined tracker titled exactly `Claudinite tracker: Repo
Tidy`. If it exists and its body doesn't already say so, rewrite the body to one line pointing at the three
per-dimension trackers (`Tidy Issues`, `Tidy PRs`, `Tidy Branches`) and stop there — nothing else to do on
it, and never open, close, or reopen it. Already pointing at them ⇒ skip. Absent ⇒ skip; never create it.

`model: sonnet` — the implemented-in-`main` call is judgment; the reconcile is mechanical aggregation.
