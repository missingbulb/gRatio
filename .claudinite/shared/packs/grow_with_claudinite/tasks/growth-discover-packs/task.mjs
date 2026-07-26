// grow_with_claudinite task: growth-discover-packs — LOCAL pack discovery, per repo
// (per-project-scheduling redesign). Each repo periodically reflects on its OWN
// stack and captured knowledge: knowing the canon packs already available to it, if
// it notices project-specific knowledge worth organizing into a new LOCAL pack — a
// technology or domain it uses that no canon pack homes and its existing local packs
// don't yet capture — it authors that local pack. A per-repo, local operation: it
// writes only the repo's OWN `.claudinite/local/packs/`, landing through an
// auto-merging PR exactly like growth-extract (the shared canon stays human-gated —
// lifting a local pack up is the central promote task's job).
//
// Self-contained (imports nothing): the whole contract is this default export.

export default {
  id: 'growth-discover-packs',
  frequency: 'weekly',                   // a repo's stack is slow-moving — a weekly reflection, not a daily one
  precondition_signals: [],              // it examines the repo's own checkout in-session, not a windowed signal
  agent_model: 'opus',                   // judging what is genuinely pack-worthy and authoring a pack is heavy judgment
  expected_outcome: 'merged-pr',         // writes only the repo's OWN local packs → arms auto-merge after CI (like extract)
  agent_instructions: 'task.md',
  agent_execution_timeout: 2400,         // manifest the stack + author a local pack — a generous weekly bound

  // Fires weekly. There is no windowed trigger — the opportunity is standing
  // (project-specific knowledge that was never organized into a pack, not a recent
  // change), so the worker examines the repo each week and no-ops cheaply when
  // there is nothing new worth a local pack.
  precondition() {
    return { run: true, reason: 'weekly local pack-discovery reflection (no-ops when nothing new is pack-worthy)' };
  },
};
