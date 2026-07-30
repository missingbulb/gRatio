// tidy-repo task: tidy-issues — the ACTING third of the tidy sweep
// (per-project-scheduling DESIGN §6). Triages the issues the window touched, and
// re-checks every open issue when the default branch moved substantively (a real
// commit can implement an old issue without the issue itself being touched).
// Worker: task.md. Branches and PRs are separate tasks: one dimension per task,
// each with its own trigger, scope, and tracker — no ordering barrier between them.
//
// Self-contained (imports nothing): the whole contract is this default export.

export default {
  id: 'tidy-issues',
  frequency: 'daily',                       // the 04:00 slot (DESIGN §2) — the one tidy dimension that ACTS, so latency matters
  precondition_signals: ['issues', 'commits'],
  agent_model: 'sonnet',                    // "implemented in main" is a judgment call against main's current content
  expected_outcome: 'none',                 // writes ISSUES only (the triage actions + its own tracker) — never a PR
  agent_instructions: 'task.md',
  agent_execution_timeout: 900,             // one dimension over a bounded issue list

  // ONE trigger, and one widener. The trigger is a touched issue: if no issue was
  // filed, commented on, labelled, or reopened in the window, this task does not
  // run — the existing pile got the same triage last time it moved, and re-deriving
  // it costs an agent run per day to rewrite the tracker with itself.
  //
  // A substantive default-branch move WIDENS an already-triggered run to every open
  // issue, because a real commit can implement an issue the issue itself never
  // recorded — but it no longer wakes the task by itself. On any repo whose `main`
  // moves most days that widening was firing daily, which is a full re-triage of
  // every open issue every day: exactly the "went over the existing ones with
  // nothing new" this gate exists to prevent. A housekeeping-only move (a nightly
  // baseline commit, a bot bump) implements nothing, so it does not widen at all.
  precondition(signals) {
    const substantive = signals.commits?.substantiveChange === true;
    const open = (signals.issues?.open ?? []).map((i) => i.number);
    const touched = signals.issues?.touched ?? [];

    // The scheduler's issues signal already hides the dispatch issues and the
    // standing trackers, so neither can ever be triaged as project work — nor can
    // either of them count as the touch that triggers a run.
    if (!touched.length) return { run: false, reason: 'no issues touched in the window' };

    const scope = substantive ? open : touched;
    return {
      run: true,
      reason: substantive
        ? `issues touched, and main moved substantively — re-check all ${scope.length} open issue(s) against it`
        : 'issues touched in the window',
      context: [`Issues to triage: ${scope.map((n) => `#${n}`).join(', ')}.`],
    };
  },
};
