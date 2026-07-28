// grow_with_claudinite task: conversation-extract — the conversation-side sibling
// of growth-extract (per-project-scheduling DESIGN §6). Mines the repo's captured
// conversation logs (the orphan `conversation-logs` branch) for durable lessons,
// posts a short summary of the exchange behind each extracted rule on its issue,
// and prunes logs past the entry's retention. Worker: task.md.
//
// Self-contained (imports nothing): the whole contract is this default export.

export default {
  id: 'conversation-extract',
  frequency: 'daily-1h',           // the 03:00 slot, alongside growth-extract (DESIGN §2)
  precondition_signals: ['commits', 'conversationLogs'],
  agent_model: 'opus',                   // deciding what clears the lesson bar is the heaviest judgment, and its PR auto-merges without a human gate
  expected_outcome: 'merged-pr',            // lessons ride an auto-merging PR; the retention prune is a push to the non-default logs branch (outside the taxonomy)
  agent_instructions: 'task.md',
  agent_execution_timeout: 1800,            // mining logs + a retention prune — generous bound, extreme protection

  // Two independent reasons to run, so the age-based prune fires on quiet repos
  // too (the old weekly-full crutch retires — a log ages out on wall time, not on
  // the repo changing, DESIGN §6):
  //   (a) a substantive merge — a fresh capture now sits on the logs branch;
  //   (b) a log on the branch is ACTUALLY past retention — there is aged material
  //       to give a final hindsight pass and prune, regardless of activity.
  //
  // (b) tests the age, not just "a branch exists and retention is configured":
  // that pair is true on every capturing repo every day, which dispatched an opus
  // agent daily to find nothing prunable. The prune's trigger is the same fact the
  // prune acts on — the oldest log being older than retention.
  precondition(signals) {
    const substantive = signals.commits?.substantiveChange === true;
    const logs = signals.conversationLogs ?? {};
    const retention = logs.retentionDays;
    const oldest = logs.oldestLogAgeDays;
    const configured = logs.present === true && typeof retention === 'number';
    const aged = configured && typeof oldest === 'number' && oldest > retention;

    if (substantive) {
      return { run: true, reason: 'substantive merge — extract any freshly captured conversation logs (+ retention prune)' };
    }
    if (aged) {
      return { run: true, reason: `oldest log ${oldest.toFixed(1)}d old vs retention ${retention}d — run the age-based retention prune` };
    }
    if (configured) {
      return { run: false, reason: `no substantive merge and no log older than retention ${retention}d — nothing to prune` };
    }
    return { run: false, reason: logs.present ? 'no substantive merge and retention unset — nothing to prune' : 'no fresh captures and no logs branch' };
  },
};
