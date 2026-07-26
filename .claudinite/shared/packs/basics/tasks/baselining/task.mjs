// basics task: baselining — the per-repo SELF-REFRESH (per-project-scheduling
// DESIGN §6; agent-preprocessing DESIGN §7, E4). Every repo baselines ITSELF from
// its own scheduler: converge its `.claudinite/shared/` mount to the current canon
// head, converge its wiring, apply the migration notes that landed since its
// stamp, and advance the stamp — one commit on the per-cycle maintenance PR.
//
// Two stages now. The DETERMINISTIC converge is `agent_preprocessing` (worker.mjs,
// run as a subprocess Action-side BEFORE any agent) — it fetches PUBLIC canon
// directly (owner §10), so NO canon repo needs to be in the session. Most nights
// are agentless and quiet; the AGENT stage (this file's `agent_model`) runs only
// when the worker requests it — a pending AGENTIC migration note, or a converge
// the deterministic pass left non-green (owner, 2026-07-23). The scheduler files
// `ready-for-agent` iff the worker writes CLAUDINITE_REQUEST_AGENT (run.mjs
// conditional handoff, DESIGN §3); the worker and agent communicate only through
// the repository (the pushed branch, the held stamp, the pending note) — task.md.
//
// Self-contained (imports nothing) so the scheduler, executor, and a human all
// load it standalone — the whole contract lives in this default export.

export default {
  id: 'baselining',
  frequency: 'daily-2h',           // the 02:00 slot — a repo's mount is converged before anything reads it (DESIGN §2)
  precondition_signals: ['stamp', 'sharedMount'],
  agent_model: 'sonnet',                 // the RESIDUAL judgment stage — flagged notes / alignment findings; requested only when needed
  expected_outcome: 'merged-pr',            // lands on the maintenance PR; arms auto-merge where member config allows
  agent_instructions: 'task.md',

  agent_preprocessing: 'node worker.mjs',   // the deterministic converge — the scheduler runs it as a subprocess (DESIGN §3, §7)
  agent_preprocessing_timeout: 900,         // clone + converge + wiring + notes + check_the_world; generous but a hard bound
  agent_execution_timeout: 1800,            // generous: a migration-note night can be substantial; the common night runs no agent at all

  // Fire ~daily so the deterministic worker runs and decides for itself whether an
  // agent is needed. PURE over the collected signals — the worker owns the
  // converge/apply/stamp/escalate work; this only gates that the worker RUNS.
  // `canonHead` is null now (the scheduler Action no longer reads canon — the
  // worker fetches it), so the age fallback is the everyday trigger.
  precondition(signals) {
    const stamp = signals.stamp ?? {};
    const changed = signals.sharedMount?.changedPacks ?? [];

    // No stamp → no vendored mount to refresh (the canon's own repo, or a
    // pre-adoption repo): baselining self-skips. `ref` null means the same.
    if (!stamp.ref && stamp.ageDays === null) {
      return { run: false, reason: 'no vendored mount (no stamp) — nothing to self-refresh' };
    }

    // The agent's binding scope, valid whenever the worker escalates: the
    // deterministic converge already ran, so the agent does only the residual that
    // needs judgment. The worker leaves the specifics in the repo (task.md).
    const context = [
      'Preprocessing has already converged the vendored mount, wiring, and mechanical migration notes and pushed the maintenance PR.',
      'Your job is only the residual that needs judgment: apply any pending FLAGGED-agentic migration note (following its own instructions) and/or resolve any conformance finding the deterministic auto-fix could not — then advance the stamp and push to the open maintenance PR. Do not re-run the mechanical converge.',
    ];

    const staleByAge = stamp.canonHead == null && typeof stamp.ageDays === 'number' && stamp.ageDays > 1;
    const behindCanon = stamp.canonHead != null && stamp.canonHead !== stamp.ref;
    const mountMoved = changed.length > 0;

    if (behindCanon) return { run: true, reason: `mount at ${String(stamp.ref).slice(0, 7)} is behind canon head ${String(stamp.canonHead).slice(0, 7)}`, context };
    if (staleByAge) return { run: true, reason: `stamp is ${stamp.ageDays.toFixed(1)}d old — run the self-refresh`, context };
    if (mountMoved) return { run: true, reason: `vendored files changed for declared pack(s): ${changed.join(', ')}`, context };
    return { run: false, reason: 'mount is at canon head and no vendored files moved' };
  },
};
