// The git/GitHub domain pack: the procedures and owner commands for the
// git/GitHub side of the task lifecycle, bundled as skills
// (skills/git-github-advanced, skills/merge-to-main). No prose and no checks of
// its own (the lifecycle checks stay in basics for now); universal reach comes
// from basics naming it in `requires`, so the closure materializes it into
// every declaration — never seeded directly (#385).
export default {
  id: 'git-github',
  ruleRoutingGuidance: {
    belongs: 'git and GitHub procedure: commit layering, branch and merge mechanics, squash-merge recovery, PR and merge-to-main commands',
    excludes: 'the issue-branch-PR lifecycle rules themselves — basics; workflow YAML and Actions runtime behaviour — github-actions',
  },
  badge: 'badge.svg',
  detect: null,
  marker: null,
  prose: null,
  worldRules: [],
  skills: [
    'git-github-advanced',
    'merge-to-main',
  ],
};
