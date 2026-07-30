// The usage fold's SECOND source: the scheduler's own Actions runs
// (skill-usage-metrics DESIGN §4.2). Every scheduler run prints one machine-readable
// record per due task saying what it did with it — dispatched an agent, ran it as
// deterministic preprocessing only, skipped it on its precondition, failed it, or
// deferred it. This module reads those records back out of the run logs.
//
// It lives in this task's folder because nothing else uses it, and it holds no
// counting logic: it turns "runs since the watermark" into `[{ date, pack, task,
// outcome }]`, and fold-usage.mjs does the arithmetic.
//
// FORWARD-ONLY, past a watermark — unlike the capture files, which the fold
// re-reads from scratch every night. The reason is the source, not the taste: the
// logs branch is local git (one tree read plus one blob read, no budget to spend),
// while these are paged REST reads over a rate-limited API, two calls per run, and
// re-reading a 10-day window every night would cost ~20x the calls for an identical
// answer. So each fold reads only what is new and the aggregate carries how far it
// got. The cost is stated where the trade is made (fold-usage.mjs `foldTaskRuns`):
// a counting bug fixed later applies from the fix forward, it does not heal history.
//
// FAIL-SOFT. Every failure here — an unreadable ledger, a log that 404s, a run whose
// jobs cannot be listed — degrades this ONE source to "nothing new this run" and
// leaves the watermark where it was, so the next fold retries the same runs. The
// skill and check counts do not depend on it and must not be lost with it.

import { SCHEDULER_WORKFLOW_FILE } from '../../../../engine/scheduler/signals/gh.mjs';
import { parseTaskRuns } from '../../../../engine/scheduler/run-record.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

// How many runs one fold will pull logs for. An hourly scheduler files ~24 runs a
// day, so this is ~10 days of catch-up in a single pass at two API calls each —
// enough to absorb a long fold outage, bounded so a pathological backlog cannot eat
// the run's whole rate budget in one go. A truncated pass advances the watermark to
// the last run it read, so the next fold continues from there; the caller LOGS the
// remainder rather than leaving a silent cap.
export const MAX_RUNS_PER_FOLD = 240;

// How far back the FIRST fold looks when the aggregate carries no run watermark yet.
// Deliberately short: there is no history to reconstruct here, only a series to
// start, and a repo adopting this should not spend hundreds of API calls back-filling
// days whose numbers nobody will read.
export const FIRST_FOLD_LOOKBACK_DAYS = 2;

// A tiny REST reader. Separate from the scheduler's `makeGh` because that one parses
// JSON and the job-log endpoint answers with a redirect to plain text; `fetchImpl` is
// injected so the tests drive both shapes without a network.
export function makeReader({ token = process.env.GITHUB_TOKEN, api = API, fetchImpl = fetch } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'claudinite-usage-fold',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return {
    async json(path) {
      const res = await fetchImpl(`${api}${path}`, { headers });
      if (res.status !== 200) return null;
      try { return await res.json(); } catch { return null; }
    },
    async text(path) {
      const res = await fetchImpl(`${api}${path}`, { headers });
      if (res.status !== 200) return null;
      try { return await res.text(); } catch { return null; }
    },
  };
}

export const lookbackFrom = (nowIso, days = FIRST_FOLD_LOOKBACK_DAYS) =>
  new Date(new Date(nowIso).getTime() - days * 86400000).toISOString();

// The scheduler runs to read this fold: completed runs started strictly after the
// watermark, oldest first.
//
// Only COMPLETED runs — an in-progress run's log is still being written, and the
// fold itself runs inside one (its own). That is safe against a gap because the
// workflow serializes on a concurrency group: a prior run has finished before the
// current one starts, so "completed and newer than the watermark" cannot skip a run
// that was still running when an earlier fold looked.
export async function schedulerRuns(reader, repo, { since, workflow = SCHEDULER_WORKFLOW_FILE, maxPages = 5 }) {
  const runs = [];
  for (let page = 1; page <= maxPages; page++) {
    const path = `/repos/${repo}/actions/workflows/${workflow}/runs`
      + `?status=completed&per_page=100&page=${page}&created=%3E%3D${encodeURIComponent(String(since).slice(0, 10))}`;
    const json = await reader.json(path);
    const batch = json?.workflow_runs;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const run of batch) {
      const at = run.run_started_at || run.created_at;
      if (!at || !run.id) continue;
      if (at <= since) continue;           // already folded (the `created` filter is day-grained)
      runs.push({ id: run.id, startedAt: at });
    }
    if (batch.length < 100) break;
  }
  // The API answers newest-first; fold oldest-first so a truncated pass leaves a
  // watermark the next fold can continue from.
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id - b.id));
}

// One run's whole log text — every job's, concatenated. Two calls: list the jobs,
// then read each one's log. A job whose log cannot be read contributes nothing
// rather than sinking the run.
export async function runLogText(reader, repo, runId) {
  const json = await reader.json(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const texts = [];
  for (const job of jobs) {
    if (!job?.id) continue;
    const text = await reader.text(`/repos/${repo}/actions/jobs/${job.id}/logs`);
    if (text) texts.push(text);
  }
  return texts.join('\n');
}

// The whole read: `{ records, watermark, remaining }`.
//   records   — [{ date, pack, task, outcome }], the date being the run's UTC start
//               day, which is the day the work was scheduled for.
//   watermark — the new `runsFoldedThrough`, or the old one when nothing was read.
//   remaining — runs left unread because of the per-fold cap (0 normally). The
//               caller logs it; a cap that truncates silently reads as "covered
//               everything" when it did not.
export async function readTaskRuns({ reader, repo, since, now, max = MAX_RUNS_PER_FOLD }) {
  const from = since || lookbackFrom(now);
  let runs;
  try {
    runs = await schedulerRuns(reader, repo, { since: from });
  } catch {
    return { records: [], watermark: since, remaining: 0, error: 'the scheduler run ledger could not be read' };
  }
  const remaining = Math.max(0, runs.length - max);
  const records = [];
  let watermark = since;
  for (const run of runs.slice(0, max)) {
    let text = '';
    try { text = await runLogText(reader, repo, run.id); } catch { text = ''; }
    const date = run.startedAt.slice(0, 10);
    for (const rec of parseTaskRuns(text)) records.push({ date, ...rec });
    // Advance past a run whose log held no records too: an idle hour (nothing due)
    // legitimately prints none, and re-reading it every night forever would be the
    // one way this stays expensive.
    watermark = run.startedAt;
  }
  return { records, watermark, remaining };
}
