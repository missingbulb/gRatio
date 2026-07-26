// grow_with_claudinite task: prose-to-checks-sweep — mine a repo's EXISTING pack
// prose for always-testable rules the conversion missed and convert the strongest
// ones (per-project-scheduling redesign). A per-repo task: every repo declaring the
// growth pack sweeps its OWN packs. Which pack paths it works is a config setting,
// `pack_paths`, defaulting to the repo's own local packs; Claudinite itself sets it
// to ALSO include its core `packs/` (projects are not expected to improve core canon
// packs — only Claudinite does). The method is owned by the prose-to-checks skill.
//
// Self-contained (imports nothing): the whole contract is this default export.

// The repo's own capture surface — a consumer improves only its LOCAL packs.
const DEFAULT_PACK_PATHS = ['.claudinite/local/packs'];

export default {
  id: 'prose-to-checks-sweep',
  frequency: 'daily',                    // works the standing backlog a slice at a time
  precondition_signals: [],              // the backlog is standing prose, not a windowed signal
  agent_model: 'opus',                   // judging convertibility and authoring checks + fixtures is heavy judgment
  expected_outcome: 'open-pr',           // converts prose to checks in an owner-approved PR (a check can break CI, so it's reviewed)
  agent_instructions: 'task.md',
  agent_execution_timeout: 2700,         // reading the packs + authoring a check with fixtures — generous bound

  // Fires daily. The pack paths to sweep come from this pack entry's `pack_paths`
  // config (default: the repo's own local packs); the canon overrides it to add its
  // core `packs/`. The worker works whatever convertible prose remains under those
  // paths and no-ops cheaply when the backlog is dry.
  precondition(_signals, config) {
    const paths = Array.isArray(config?.pack_paths) && config.pack_paths.length ? config.pack_paths : DEFAULT_PACK_PATHS;
    return {
      run: true,
      reason: `daily prose-to-checks backlog sweep over ${paths.join(', ')} (no-ops cheaply when dry)`,
      context: [`Pack paths to sweep (work ONLY these; never a read-only mounted canon pack under .claudinite/shared/): ${paths.join(', ')}.`],
    };
  },
};
