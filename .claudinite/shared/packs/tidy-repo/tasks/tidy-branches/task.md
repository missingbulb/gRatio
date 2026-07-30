# tidy-branches worker

The **assess-only** branch third of the repo tidy-up: a weekly pass over the repo's open branches — run
only when a branch was actually created or pushed in the window — then record the picture. You run under
the executor, dispatched by a `ready-for-agent` issue; its **Context section is binding scope** — it lists
the branches to assess. Work only those; don't enumerate the repo yourself. GitHub access is **MCP-only**
(`mcp__github__*`).

The task's declared outcome ceiling is **`none`**, and this dimension is read-only besides: **never delete,
push, or merge a branch**, and never open or merge a PR. You recommend; a human acts. The only thing you
write is this task's own tracker issue.

**Never assess the repo's own default branch.** The Context already excludes the known infra branches (the
orphan `conversation-logs` log stream and the `claudinite/maintenance` delivery branch) and the conventional
default names, but a precondition cannot look up the real default branch by name — that exclusion is your
responsibility here.

## 1. Assess each branch

For each branch in the Context list, run the
[single-branch-status](../../skills/single-branch-status/SKILL.md) skill for its verdict — judged by
**content**, never the ref's auto-generated name. Collect:

- one line each for the branches carrying **genuine unmerged work** (`` `branch` — what it carries``);
- the rest collapsed into one `Safe to delete: N — a, b, c` line;
- any **orphaned** branch flagged for a human.

## 2. Reconcile this task's tracker

One standing tracker issue per repo, titled exactly `Claudinite tracker: Tidy Branches` — found by that
**exact title, never a fuzzy match**; create it **already closed** if absent (never a fresh issue per run,
never a bare number that can dangle). Each dimension keeps its **own** tracker, so three tasks never race
to rewrite one body.

Touch it two ways each run:

- **Rewrite the issue body** to today's **dated** snapshot: the branches carrying genuine unmerged work, the
  safe-to-delete count and names, and anything orphaned. The body is the live picture — it replaces last
  week's, it doesn't accumulate.
- **Add a dated comment** with today's status, so the body's snapshots leave a per-run trail.

Keep both short. **Never open, close, or reopen the tracker** — its state carries no meaning. The tracker
only *records* the recommendations; nothing here touches a branch.

`model: sonnet` — superseded / orphaned are judgment calls; the reconcile is mechanical aggregation.
