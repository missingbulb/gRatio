// The repo tidy-up, as a composable pack: the PR/branch/issue sweep the repo's own
// scheduler runs, contributed the same way any pack contributes checks and skills.
// Declaring tidy-repo puts its scheduled task on that repo's schedule; removing it
// is a durable opt-out (baselining never re-adds it — see the tidy-repo-seed
// migration).
//
// A declared pack (no detect fingerprint): --init seeds it into every new repo's
// declaration, and the one-time tidy-repo-seed migration seeds the existing fleet.
// It carries no conformance checks — its work is the scheduled task, not checks.
//
// One task per dimension — tidy-issues (daily, acts), tidy-prs and tidy-branches
// (weekly, assess-only) — each delegating its per-object verdict to a single-object
// skill and reconciling its OWN standing tracker. Three narrow tasks, not one wide
// one: each has its own trigger and scope, none depends on another's result, so
// there is no ordering barrier and a dimension with nothing to do stays silent.
export default {
  id: 'tidy-repo',
  detect: null,
  marker: null,
  seededByDefault: true,
  prose: 'RULES.md',
  rules: [],
  // The pack's scheduled tasks live in this pack's own `tasks/<id>/`, discovered by
  // the scheduler's filesystem scan (engine/scheduler/discover.mjs), not declared here.
  //
  // The single-object worker skills those workers apply live under this pack's own
  // skills/ and mount wherever tidy-repo is declared.
};
