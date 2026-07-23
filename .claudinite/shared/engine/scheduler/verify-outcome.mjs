// Post-hoc enforcement of a task's declared outcome ceiling (per-project-scheduling
// DESIGN §1, §5.5). The executor runs this in code AFTER the subagent finishes:
// the outcome is a ceiling enforced, not merely requested in prose, so a `none`
// task that opened a PR — or an `open-pr` task that merged one — fails the run
// and converges to needs-human. "No change" is always legal.
//
// Pushes to non-default branches (e.g. the conversation-logs prune) are outside
// the PR taxonomy (DESIGN §1) and are not judged here — the caller passes only
// what the task did to PULL REQUESTS.

import { OUTCOMES } from './task-contract.mjs';

// Verify what a task actually did against its declared ceiling.
//   outcome    — the task's declared ceiling ('none' | 'open-pr' | 'merged-pr')
//   openedPr   — did the run open a pull request?
//   mergedPr   — did the run merge (or arm auto-merge on) a pull request?
// Returns { ok, violation } — violation is null when within the ceiling.
export function verifyOutcome({ outcome, openedPr = false, mergedPr = false }) {
  if (!OUTCOMES.includes(outcome)) {
    return { ok: false, violation: `unknown outcome ceiling "${outcome}"` };
  }
  // Merging implies a PR exists; treat a merge as also having opened one so a
  // caller that only reports mergedPr is still judged correctly.
  const opened = openedPr || mergedPr;

  if (outcome === 'none' && opened) {
    return { ok: false, violation: 'a "none" task must not open or merge a pull request' };
  }
  if (outcome === 'open-pr' && mergedPr) {
    return { ok: false, violation: 'an "open-pr" task must not merge a pull request' };
  }
  return { ok: true, violation: null };
}
