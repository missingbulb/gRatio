// tidy-repo task: tidy-prs — the read-only PR third of the tidy sweep
// (per-project-scheduling DESIGN §6). One weekly full sweep over every open PR:
// which should stay open, which are closeable. Recommends; never closes. Worker:
// task.md. Issues and branches are separate tasks — one dimension per task, each
// with its own trigger, scope, and tracker, so there is no ordering barrier.
//
// WEEKLY, and full every time: a PR verdict is a standing recommendation for a
// human, not a same-day alert, so re-deriving the whole picture once a week beats
// a daily partial one — and "weekly" is a frequency DECLARATION, never a gate trick
// inside a daily task (DESIGN §3).
//
// Self-contained (imports nothing): the whole contract is this default export.

export default {
  id: 'tidy-prs',
  frequency: 'weekly',                      // the weekly anchor (DESIGN §2); the full sweep is the declaration
  precondition_signals: ['prs'],            // the open set IS the scope — no window narrowing to do
  agent_model: 'sonnet',                    // superseded / already-in-main are judgment calls on the diff
  expected_outcome: 'none',                 // assess-only: never closes, merges, or comments on a PR; writes only its tracker
  agent_instructions: 'task.md',
  agent_execution_timeout: 900,             // a full sweep, but one cheap read-only verdict per PR

  // The only gate a full sweep needs: is there anything open to assess. A repo with
  // no open PRs stays silent.
  precondition(signals) {
    const open = (signals.prs?.open ?? []).map((p) => p.number);
    if (!open.length) return { run: false, reason: 'no open PRs' };

    return {
      run: true,
      reason: `weekly full sweep over ${open.length} open PR(s)`,
      context: [`PRs to assess (read-only — recommend closes, never close): ${open.map((n) => `#${n}`).join(', ')}.`],
    };
  },
};
