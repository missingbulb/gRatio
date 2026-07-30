import growthConfig from './config-check.mjs';
import dedupIntegrity from './dedup-integrity.mjs';

// Opt into the growth lifecycle: a repo declaring grow_with_claudinite contributes its
// hard-won lessons up to the Claudinite canon and prunes them back out once the canon
// owns them. This pack carries the REPO-side stages — extract, dedup, the weekly local
// pack discovery, and the prose-to-checks sweep — as scheduled tasks under this pack's
// own `tasks/`, discovered by the scheduler's filesystem scan
// (engine/scheduler/discover.mjs), so none of them is declared here. The central
// promote stage — lifting portable lessons up into the shared canon — is a home-only
// duty that runs canon-side, outside this pack; its precondition targets exactly the
// members that declare THIS pack, minus any member whose entry sets config.promote:
// false (the promotion opt-out; extraction and dedup stay local either way).
//
// The pack also owns the CONVERSATION lifecycle: capture-log.mjs pushes a session's
// conversation onto the orphan conversation-logs branch (in-session — it needs the
// live transcript), driven by TWO events: merge-to-main's capture step, with the
// issue the merge closed, and session-end.mjs, with --issue 0, invoked by the
// engine's SessionEnd hook runner. The second is best-effort and captures what the
// first structurally cannot — sessions that never merge, and the post-merge tail of
// the ones that do; it is safe to double-write because capture deltas on the session
// id. The conversation-extract task (tasks/conversation-extract/) then mines those
// pushed logs with growth-extract's access model — the logs branch is in the repo, so
// reading it, committing lessons to local packs, and pruning aged logs are plain local
// git; only posting the short summary behind each extracted rule on its issue uses the
// GitHub MCP tools — pruning logs past config.retention_days.
//
// And it owns the SKILL-USAGE metric the promotion ladder's skill-vs-prose call was
// missing: usage-fold (tasks/usage-fold/) counts skill loads and their activity
// denominators out of those same captured logs into a small tracked aggregate.
// Fleet-wide aggregation is NOT here — the canon knows mechanisms, never repos; that
// is the sheepdog pack's job, in the fleet-enforcer repo.
//
// growth-discover-packs is the weekly LOCAL pack-discovery reflection: the repo
// manifests its own stack, notices project-specific knowledge no canon pack homes,
// and authors a local pack for it under its own `.claudinite/local/packs/`.
//
// A declared pack (no fingerprint), seeded like tidy-repo: --init seeds it into every
// new repo, the one-time grow-with-claudinite-seed migration seeds the existing fleet,
// and baselining never re-adds it — so removing it is a durable opt-out.
//
// No adoption question over config.retention_days — the value stays unset (hidden)
// by default, which is fail-safe (capture-only, the prune deletes nothing) rather
// than something every adopter must weigh in on. A project that wants the prune
// active sets retention_days itself.
export default {
  id: 'grow_with_claudinite',
  ruleRoutingGuidance: {
    belongs: 'rules and tasks for capturing lessons into local packs — extraction, dedup, conversation logs, skill-usage folding',
    excludes: 'repo housekeeping of issues, PRs and branches — that is tidy-repo; cross-repo fleet sweeps are sheepdog',
  },
  badge: 'badge.svg',
  detect: null,
  marker: null,
  seededByDefault: true,
  prose: null,
  worldRules: [growthConfig],
  workRules: [dedupIntegrity],
  skills: [
    'adopt-claudinite',
    'adopt-pack',
    'generate-project-instructions',
    'prose-to-checks',
    'unattended-agents',
  ],
};
