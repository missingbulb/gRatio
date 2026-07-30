// tidy-repo task: tidy-prs — the read-only PR third of the tidy sweep
// (per-project-scheduling DESIGN §6). One weekly full sweep over every open PR:
// which should stay open, which are closeable. Recommends; never closes. Worker:
// task.md. Issues and branches are separate tasks — one dimension per task, each
// with its own trigger, scope, and tracker, so there is no ordering barrier.
//
// WEEKLY, and full every time it runs — but it only runs when a PR actually moved
// in the window. A PR verdict is a standing recommendation for a human, not a
// same-day alert, so re-deriving the whole picture once a week beats a daily partial
// one — and "weekly" is a frequency DECLARATION, never a gate trick inside a daily
// task (DESIGN §3). What "full" does not mean is unconditional: an untouched set of
// open PRs yields last week's verdicts again, so the sweep is gated on newness even
// though its scope stays full.
//
// Self-contained (imports nothing): the whole contract is this default export.

export default {
  id: 'tidy-prs',
  frequency: 'weekly',                      // the weekly anchor (DESIGN §2); the full sweep is the declaration
  precondition_signals: ['prs'],            // the open set is the scope; `touched` is the gate
  agent_model: 'sonnet',                    // superseded / already-in-main are judgment calls on the diff
  expected_outcome: 'none',                 // assess-only: never closes, merges, or comments on a PR; writes only its tracker
  agent_instructions: 'task.md',
  agent_execution_timeout: 900,             // a full sweep, but one cheap read-only verdict per PR

  // Two gates, in order. Is there anything open to assess — a repo with no open PRs
  // stays silent. Then: did any open PR get opened or updated in the window. If none
  // did, the picture is the one the tracker already holds and another pass would
  // rewrite it with itself. When one did move, scope is still the FULL open set: a
  // PR verdict is relative to the others (superseded-by), so the mover cannot be
  // judged alone. `touched` counts the newly OPENED ones too — the collector derives
  // it from the open listing's `updated_at`, which a new PR carries.
  precondition(signals) {
    const open = (signals.prs?.open ?? []).map((p) => p.number);
    if (!open.length) return { run: false, reason: 'no open PRs' };

    const touched = signals.prs?.touched ?? [];
    if (!touched.length) {
      return { run: false, reason: `no PR opened or updated in the window — the standing picture over ${open.length} open PR(s) is unchanged` };
    }

    return {
      run: true,
      reason: `${touched.length} PR(s) moved in the window — full sweep over ${open.length} open PR(s)`,
      context: [`PRs to assess (read-only — recommend closes, never close): ${open.map((n) => `#${n}`).join(', ')}.`],
    };
  },
};
