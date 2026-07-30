// The usage-fold preprocessing entry point — the script the scheduler runs as
// `node worker.mjs` (cwd = this task dir, bounded by agent_preprocessing_timeout).
// The whole task: no agent, no dispatch issue.
//
// It holds NO counting logic. The counting and folding are `fold-usage.mjs`, its
// SIBLING in this task folder — nothing outside this task uses them, so that is
// where they live and where their tests point. This file is the I/O shell:
//
//   1. fetch the orphan `conversation-logs` branch (plain local git — the branch is
//      in this repo, so one tree read plus one blob read per file beats any REST
//      round-trip, and there is no rate budget to spend);
//   2. count each capture file still in the raw retention window;
//   3. read the scheduler's own task-run records from its Actions logs, past the
//      `runsFoldedThrough` watermark (read-task-runs.mjs) — the second source, and
//      the only one that sees a task that never opened a session at all;
//   4. fold: day rows recomputed from scratch, task rows appended once, week rows
//      advanced past the `foldedThrough` watermark (skill-usage-metrics DESIGN §5);
//   5. deliver the regenerated `.claudinite/local/usage.GENERATED.json` on an
//      auto-merging PR — and open NOTHING when the recompute is byte-identical.
//
// The aggregate lives under `.claudinite/local/` because that is the repo-owned area
// the vendoring refresh never touches; the mount root itself is read-only canon.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deliverGenerated, baseTip, readAt, remoteUrl } from '../../../../engine/scheduler/deliver-generated.mjs';
import { countEntries, foldUsage, mountedSkillNames } from './fold-usage.mjs';
import { makeReader, readTaskRuns } from './read-task-runs.mjs';

const BRANCH = 'conversation-logs';
export const USAGE_PATH = '.claudinite/local/usage.GENERATED.json';
const PR_BRANCH_PREFIX = 'claudinite/usage-fold';

const slotId = process.env.CLAUDINITE_SLOT_ID || '';
const log = (s) => console.log(`usage-fold${slotId ? ` [${slotId}]` : ''}: ${s}`);

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8',
  // A capture blob easily tops the default 1 MiB buffer — a long session's log then
  // dies mid-read and the day it lands in silently under-counts.
  maxBuffer: 256 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// --- the raw window -----------------------------------------------------------

// The capture filename standard (packs/grow_with_claudinite/README.md). Issue `0`
// means "no associated issue" — a SessionEnd capture. Exported for the tests.
export function parseLogName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z(?:-\d+)?--issue-(\d+)--(.+)\.jsonl$/.exec(name);
  return m ? { date: m[1], issue: Number(m[4]), sessionId: m[5] } : null;
}

export function parseEntries(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a partial trailing write — skip the line */ }
  }
  return out;
}

// Fetch the logs branch and return its capture files. Returns null when the branch
// does not exist — a repo that has never captured has nothing to fold, which is a
// clean no-op rather than a failure.
function logFiles(root, remote) {
  if (!git(root, ['ls-remote', '--heads', remote, BRANCH]).trim()) return null;
  git(root, ['fetch', '--quiet', remote, BRANCH]);
  const tip = git(root, ['rev-parse', 'FETCH_HEAD']).trim();
  const names = git(root, ['ls-tree', '--name-only', tip]).split('\n').filter(Boolean);
  return { tip, names: names.filter((n) => parseLogName(n) !== null).sort() };
}

// --- the GENERATED-file contract ----------------------------------------------

// A GENERATED file wants a `merge=ours` .gitattributes entry, so a conflicting merge
// resolves by re-running the generator instead of by hand (the canon's
// GENERATED-file discipline, and the `generated-merge-driver` check that enforces
// it). Declared alongside the file it is about, on the first fold; returns null when
// it is already declared. Exported for the tests.
export const MERGE_ATTR = 'usage.GENERATED.json merge=ours';
export function withMergeAttribute(current) {
  const text = current ?? '';
  if (text.split('\n').some((l) => l.trim() === MERGE_ATTR)) return null;
  return (text && !text.endsWith('\n') ? `${text}\n` : text) + `${MERGE_ATTR}\n`;
}

// --- main ---------------------------------------------------------------------

export async function main() {
  const root = process.env.CLAUDINITE_REPO_ROOT || process.cwd();
  const repo = process.env.CLAUDINITE_REPO || process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const base = process.env.CLAUDINITE_DEFAULT_BRANCH || 'main';
  if (!repo) throw new Error('CLAUDINITE_REPO / GITHUB_REPOSITORY is not set (owner/repo)');
  if (!token) throw new Error('GITHUB_TOKEN is not set — the fold cannot read the logs branch or deliver its PR');
  const remote = remoteUrl(repo, token);

  // No logs branch is no longer "nothing to do": the capture-derived half of the
  // aggregate is empty, but the scheduler's own run records are a separate source
  // that exists as soon as the repo has a scheduler — and a repo whose sessions are
  // all unattended is exactly the one whose task invocations are worth counting.
  const found = logFiles(root, remote);
  if (found === null) log(`no ${BRANCH} branch — nothing captured yet; folding the scheduler's task runs only`);

  let config = {};
  try { config = JSON.parse(readFileSync(join(root, '.claudinite-checks.json'), 'utf8')); } catch { /* no declaration */ }
  const mounted = await mountedSkillNames(root, config);

  const files = (found?.names ?? []).map((name) => ({
    ...parseLogName(name),
    counts: countEntries(parseEntries(git(root, ['show', `${found.tip}:${name}`])), mounted),
  }));

  // Prior state comes from the BASE TIP, never the working tree: the checkout may be
  // sitting on another task's branch, and the base is the only authority on what has
  // already been folded. A fold PR still open when the next run fires is rebuilt from
  // the base — days recompute statelessly and the watermark advances from the same
  // place, so nothing is ever counted twice.
  const baseSha = baseTip(root, remote, base);
  let prior = {};
  try { prior = JSON.parse(readAt(root, baseSha, USAGE_PATH) ?? '{}'); } catch { /* unparsable → refold */ }

  // The second source: what the scheduler itself did with each task, read from its
  // own run logs past the aggregate's run watermark (read-task-runs.mjs). Fail-soft
  // and independent — a ledger this fold cannot read costs the task rows this run
  // and nothing else, because the skill and check counts come from the logs branch
  // that was already read above.
  const now = new Date().toISOString();
  const taskRuns = await readTaskRuns({
    reader: makeReader({ token }), repo, since: prior.runsFoldedThrough ?? null, now,
  });
  if (taskRuns.error) log(`${taskRuns.error} — task-invocation rows unchanged this run`);
  if (taskRuns.remaining) log(`${taskRuns.remaining} scheduler run(s) past this fold's cap — the next fold continues from the watermark`);

  const today = now.slice(0, 10);
  const text = `${JSON.stringify(foldUsage({
    files, prior, today, taskRuns: taskRuns.records, runsFoldedThrough: taskRuns.watermark,
  }), null, 2)}\n`;
  const attributes = withMergeAttribute(readAt(root, baseSha, '.gitattributes'));

  if (readAt(root, baseSha, USAGE_PATH) === text && attributes === null) {
    log(`${files.length} capture file(s) folded — recompute is byte-identical, nothing to deliver`);
    return;
  }

  const pr = await deliverGenerated({
    root, repo, base, token, stamp: today, branchPrefix: PR_BRANCH_PREFIX,
    files: { [USAGE_PATH]: text, ...(attributes !== null ? { '.gitattributes': attributes } : {}) },
    message: 'Claudinite: fold skill-usage metrics',
    title: 'Claudinite: skill-usage fold',
    body: [
      `Regenerated \`${USAGE_PATH}\` from this repo's captured conversation logs and`,
      "the scheduler's own run records.",
      '',
      'Day rows are recomputed from scratch every run from the logs still inside the',
      'retention window; week rows are appended once, past the `foldedThrough` watermark.',
      'Task-invocation rows are appended once past the `runsFoldedThrough` watermark —',
      'the scheduler runs they come from are a rate-limited REST read, not a local branch.',
      'A byte-identical recompute opens no PR at all. Machine-written — never hand-edit it.',
    ].join('\n'),
  });
  log(`${files.length} capture file(s) and ${taskRuns.records.length} task-run record(s) folded — `
    + `${pr.reused ? 'updated' : 'opened'} PR ${pr.number !== null ? `#${pr.number}` : `on ${pr.branch}`}`);
}

// Run only when invoked directly (the scheduler's `node worker.mjs`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`usage-fold failed: ${e.message}`); process.exit(1); });
}
