// tidy-repo task: tidy-branches — the read-only branch third of the tidy sweep
// (per-project-scheduling DESIGN §6). One weekly full sweep over the repo's open
// branches: which carry genuine unmerged work, which are safe to delete. Recommends;
// never deletes. Worker: task.md. Issues and PRs are separate tasks — one dimension
// per task, each with its own trigger, scope, and tracker, so there is no ordering
// barrier.
//
// WEEKLY, and full every time. The `branches` signal carries NAMES only, so there is
// no windowed subset to narrow to — the whole set is the only scope this dimension
// has. Branch cruft also accumulates on a weekly clock, not a daily one, and the
// verdict is a standing recommendation for a human rather than a same-day alert. So
// the full sweep is a frequency DECLARATION, never a gate trick inside a daily task
// (DESIGN §3).
//
// Self-contained (imports nothing): the whole contract is this default export.

// Branches the tidy review must never assess. Beyond the default branch, the orphan
// `conversation-logs` branch is a grow_with_claudinite artifact (the captured-transcript
// stream, not project work) — it shares no history with main, so single-branch-status
// would flag it "orphaned" for a human on every run. It is infrastructure the tidy
// sweep ignores altogether. Kept as a bare literal, not an import: the pack-independence
// barrier forbids tidy-repo from reaching into grow_with_claudinite, and the name is a
// fixed, well-known one. The stable maintenance branch is likewise never a tidy target —
// it is Claudinite's own standing delivery branch, not project work.
const IGNORED_BRANCHES = new Set(['conversation-logs', 'claudinite/maintenance']);

// A precondition has no repo handle, so it cannot look up the actual default branch
// name to drop it from the candidate set — and the `branches` signal carries every
// open branch, the default included. Presuming the conventional default names here
// keeps a repo whose only branch is its default from firing this task at all, which is
// the whole point of the gate. The worker (task.md) remains the authority that never
// assesses the repo's real default branch, so a repo whose default is unconventionally
// named is still safe — its default just also becomes a (cheap, read-only) candidate.
const PRESUMED_DEFAULT = new Set(['main', 'master']);

export default {
  id: 'tidy-branches',
  frequency: 'weekly',                      // the weekly anchor (DESIGN §2); the full sweep is the declaration
  precondition_signals: ['branches'],       // names only — the assessable set IS the scope
  agent_model: 'sonnet',                    // superseded / orphaned / already-in-main are judgment calls on content
  expected_outcome: 'none',                 // assess-only: never deletes, pushes, or merges; writes only its tracker
  agent_instructions: 'task.md',
  agent_execution_timeout: 600,             // one cheap diff-and-merge-base read per branch

  // The only gate a full sweep needs: is there a branch worth assessing. A repo
  // carrying nothing but its default branch (and the infra branches) stays silent.
  precondition(signals) {
    const branches = (signals.branches?.names ?? [])
      .filter((b) => !IGNORED_BRANCHES.has(b) && !PRESUMED_DEFAULT.has(b));
    if (!branches.length) return { run: false, reason: 'no branches to assess beyond the default and the infra branches' };

    return {
      run: true,
      reason: `weekly full sweep over ${branches.length} branch(es)`,
      context: [`Branches to assess (read-only — recommend deletions, never delete): ${branches.join(', ')}.`],
    };
  },
};
