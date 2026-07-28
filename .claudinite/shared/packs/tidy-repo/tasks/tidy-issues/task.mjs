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

  // Two triggers, and they are the complete set for this dimension: an issue's
  // triage answer changes when the ISSUE moves, or when `main` moves (which can
  // implement it). So a touched issue is in scope, and a substantive default-branch
  // move widens scope to EVERY open issue — that widening is this task's full sweep,
  // triggered by the thing that changes the answer rather than by the calendar. A
  // housekeeping-only main move (a nightly baseline commit, a bot bump) implements
  // nothing, so it does not widen and a quiet-but-maintained repo isn't re-swept.
  precondition(signals) {
    const substantive = signals.commits?.substantiveChange === true;
    const open = (signals.issues?.open ?? []).map((i) => i.number);
    const touched = signals.issues?.touched ?? [];

    // The scheduler's issues signal already hides the dispatch issues and the
    // standing trackers, so neither can ever be triaged as project work.
    const scope = substantive ? open : touched;
    if (!scope.length) {
      return { run: false, reason: substantive ? 'main moved substantively but the repo has no open issues' : 'no issues touched in the window' };
    }

    return {
      run: true,
      reason: substantive
        ? `main moved substantively — re-check all ${scope.length} open issue(s) against it`
        : 'issues touched in the window',
      context: [`Issues to triage: ${scope.map((n) => `#${n}`).join(', ')}.`],
    };
  },
};
