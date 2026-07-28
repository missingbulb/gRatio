# tidy-prs worker

The **assess-only** PR third of the repo tidy-up: one weekly pass over every open PR, then record the
picture. You run under the executor, dispatched by a `ready-for-agent` issue; its **Context section is
binding scope** — it lists the PRs to assess. Work only those; don't enumerate the repo yourself. GitHub
access is **MCP-only** (`mcp__github__*`).

The task's declared outcome ceiling is **`none`**, and this dimension is read-only besides: **never close,
merge, comment on, or push to a PR.** You recommend; a human acts. The only thing you write is this task's
own tracker issue.

## 1. Assess each PR

For each PR in the Context list, run the [single-pr-status](../../skills/single-pr-status/SKILL.md) skill
for its verdict — judged by its commits and diff, never its title. Collect:

- one line each for the PRs that should **stay open** (`#N — why it's live`);
- the rest collapsed into one `Closeable: #a, #b — merged/superseded/stale` line.

## 2. Reconcile this task's tracker

One standing tracker issue per repo, titled exactly `Claudinite tracker: Tidy PRs` — found by that **exact
title, never a fuzzy match**; create it **already closed** if absent (never a fresh issue per run, never a
bare number that can dangle). Each dimension keeps its **own** tracker, so three tasks never race to
rewrite one body.

Touch it two ways each run:

- **Rewrite the issue body** to today's **dated** snapshot: the stay-open PRs with their reasons, and the
  closeable ones. The body is the live picture — it replaces last week's, it doesn't accumulate.
- **Add a dated comment** with today's status, so the body's snapshots leave a per-run trail.

Keep both short. **Never open, close, or reopen the tracker** — its state carries no meaning. The tracker
only *records* the recommendations; nothing here acts on a PR.

`model: sonnet` — superseded / already-in-`main` are judgment calls; the reconcile is mechanical aggregation.
