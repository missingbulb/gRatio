// The scheduler entrypoint's orchestration core (per-project-scheduling DESIGN
// §3). The vendored hourly Action runs this: decide due slots from the run
// ledger, discover active tasks, collect only the signals the due tasks declare,
// run each precondition, and either dispatch agent work as a `ready-for-agent`
// issue or (for `model: none`) run the worker inline.
//
// This module is the DECISION core, kept injectable so it tests with fakes: the
// GitHub I/O (the Actions run-ledger read for `lastSuccess`, the signal
// collectors, the issue search/create) is supplied by the thin CLI shell around
// `planRun`. The "should this run" verdict is always code here — never the
// shell's judgment (the same split the fleet planner uses).

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dueSlots } from './slots.mjs';
import { planDispatch, dispatchTitle, dispatchBody, DISPATCH_PREFIX, READY_LABEL } from './dispatch.mjs';
import { isAgentless } from './model-map.mjs';

// The due tasks, each paired with the slot it runs under. Union the discovered
// tasks' frequencies, ask slots which are due (run-ledger math), then map due
// frequencies back to their tasks. A task whose frequency isn't due drops out.
export function computeDueTaskSlots(tasks, schedule, now, lastSuccess) {
  const frequencies = [...new Set(tasks.map((t) => t.decl.frequency))];
  const due = new Map(dueSlots(frequencies, schedule, now, lastSuccess).map((d) => [d.frequency, d]));
  const out = [];
  for (const task of tasks) {
    const slot = due.get(task.decl.frequency);
    if (slot) out.push({ task, slotId: slot.slotId, slotTime: slot.slotTime });
  }
  return out;
}

// The union of signal names the due tasks declare — the scheduler collects only
// these, so a non-daily slot never pays for daily tasks' signals (DESIGN §3.3).
export function signalsUnion(dueTaskSlots) {
  const names = new Set();
  for (const { task } of dueTaskSlots) for (const name of task.decl.signals) names.add(name);
  return [...names];
}

// The signal-collection lookback: the widest due task's period plus 1h slack
// (DESIGN §3.3). Stateless fixed lookback — overlap is absorbed by dedupe.
const FREQUENCY_MS = {
  hourly: 3600e3, 'daily-2h': 86400e3, 'daily-1h': 86400e3, daily: 86400e3,
  'daily+1h': 86400e3, weekly: 7 * 86400e3, monthly: 31 * 86400e3,
};
export function windowStart(dueTaskSlots, now) {
  const widest = Math.max(0, ...dueTaskSlots.map(({ task }) => FREQUENCY_MS[task.decl.frequency] ?? 86400e3));
  return new Date(new Date(now).getTime() - widest - 3600e3).toISOString();
}

// Run one task's precondition in isolation (DESIGN §3.4). A throwing
// precondition converges to a skip with the error recorded — it never sinks the
// rest of the run; the CLI escalates a thrown precondition to a workflow-failure
// issue separately.
export function runPrecondition(task, signals, packConfig) {
  try {
    const v = task.decl.precondition(signals, packConfig) ?? {};
    return {
      run: v.run === true,
      reason: v.reason ?? '',
      context: Array.isArray(v.context) ? v.context : [],
    };
  } catch (e) {
    return { run: false, reason: `precondition threw: ${e.message}`, context: [], error: e.message };
  }
}

// A human-readable job-summary line per evaluated task — the observability the
// old plan.json gave (DESIGN §3.6).
export function renderSummary(evaluations) {
  return evaluations.map((e) => {
    const verb = !e.run ? 'skip' : e.inline ? 'run-inline' : e.dispatch?.action ?? 'run';
    return `- ${e.pack}/${e.task} [${e.slotId}] ${verb} — ${e.reason || e.dispatch?.reason || ''}`.trimEnd();
  }).join('\n');
}

// Orchestrate one scheduler run into a set of decisions — the reusable core the
// CLI wraps with real GitHub I/O. Injected seams:
//   collectSignals(names) -> signals object (the declared union, collected once)
//   packConfigFor(packId) -> that pack's entry config from .claudinite-checks.json
//   existingIssuesFor(pack, task) -> the task family's issues [{number,title,state}]
// Returns `{ evaluations }`: one record per due task with its precondition
// verdict and, when it runs, either an inline marker (model: none) or a
// dispatch decision (planDispatch).
export async function planRun({
  tasks, schedule, now, lastSuccess,
  collectSignals, packConfigFor = () => ({}), existingIssuesFor = async () => [],
}) {
  const dueList = computeDueTaskSlots(tasks, schedule, now, lastSuccess);
  const signals = await collectSignals(signalsUnion(dueList));

  const evaluations = [];
  for (const { task, slotId } of dueList) {
    const pre = runPrecondition(task, signals, packConfigFor(task.pack));
    const rec = {
      pack: task.pack, task: task.id, slotId,
      model: task.decl.model, outcome: task.decl.outcome,
      run: pre.run, reason: pre.reason, context: pre.context,
    };
    if (pre.error) rec.error = pre.error;
    if (pre.run) {
      if (isAgentless(task.decl.model)) {
        // model: none — the worker is code the scheduler runs inline; no issue.
        rec.inline = true;
      } else {
        const existing = await existingIssuesFor(task.pack, task.id);
        rec.dispatch = planDispatch({ existing, pack: task.pack, task: task.id, slotId });
      }
    }
    evaluations.push(rec);
  }
  return { evaluations };
}

// --- CLI: the thin I/O shell the vendored workflow invokes -------------------
// Wires the run-ledger read, signal collectors, and issue I/O around planRun,
// then acts on each decision (file a labeled dispatch issue, or run an inline
// worker) and prints the job summary. All GitHub access here is the Action's
// GITHUB_TOKEN — the one sanctioned non-MCP surface (DESIGN §10).

// The task family's issues (state=all) via the search API, filtered to exact
// prefix — the input planDispatch's exactly-once / at-most-one-open guards read.
async function existingIssuesViaSearch(gh, repo, pack, task) {
  const q = encodeURIComponent(`repo:${repo} in:title "${DISPATCH_PREFIX} ${pack}/${task}"`);
  const { status, json } = await gh(`/search/issues?q=${q}&per_page=100`);
  if (status !== 200 || !Array.isArray(json?.items)) return [];
  const prefix = `${DISPATCH_PREFIX} ${pack}/${task} `;
  return json.items
    .filter((i) => `${(i.title ?? '').trim()} `.startsWith(prefix))
    .map((i) => ({ number: i.number, title: i.title, state: i.state }));
}

async function main() {
  const { makeGh, lastSuccessTime, actionRepoContext } = await import('./signals/gh.mjs');
  const { collectSignals } = await import('./signals/index.mjs');
  const { discoverTasks } = await import('./discover.mjs');
  const { loadConfig } = await import('../checks/helpers/repo-context.mjs');

  const root = process.cwd();
  const { repo, defaultBranch } = actionRepoContext();
  if (!repo) { console.error('GITHUB_REPOSITORY not set — not in an Actions context'); process.exit(1); }
  const gh = makeGh();
  const config = loadConfig(root);

  const { tasks, errors } = await discoverTasks(root, config);
  for (const e of errors) console.log(`! ${e.what}`);

  const now = new Date();
  const lastSuccess = await lastSuccessTime(gh, repo);
  const schedule = config.schedule;

  const due = computeDueTaskSlots(tasks, schedule, now, lastSuccess);
  const sinceIso = windowStart(due, now);
  const ctx = {
    repo, defaultBranch, now: now.toISOString(), sinceIso, config,
    activePacks: config.packs,
  };
  const packConfigFor = (packId) => config.packConfig?.[packId] ?? {};

  const { evaluations } = await planRun({
    tasks, schedule, now, lastSuccess,
    collectSignals: (names) => collectSignals(gh, ctx, names),
    packConfigFor,
    existingIssuesFor: (pack, task) => existingIssuesViaSearch(gh, repo, pack, task),
  });

  for (const rec of evaluations) {
    if (!rec.run) continue;
    const taskObj = tasks.find((t) => t.pack === rec.pack && t.id === rec.task);
    if (rec.inline) {
      // model: none — run the worker module inline (it may itself dispatch a workflow).
      try {
        const workerUrl = pathToFileURL(join(taskObj.taskDir, taskObj.decl.worker)).href;
        const worker = (await import(workerUrl)).default;
        if (typeof worker === 'function') await worker({ gh, repo, ctx, slotId: rec.slotId });
      } catch (e) { console.log(`! inline worker ${rec.pack}/${rec.task} failed: ${e.message}`); }
      continue;
    }
    if (rec.dispatch?.action === 'create') {
      const title = dispatchTitle({ pack: rec.pack, task: rec.task, slotId: rec.slotId });
      const body = dispatchBody({ taskPath: taskObj.taskPath, pack: rec.pack, task: rec.task, slotId: rec.slotId, context: rec.context });
      const res = await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels: [READY_LABEL] } });
      if (res.status >= 300) console.log(`! failed to file dispatch issue for ${rec.pack}/${rec.task}: ${res.status}`);
    }
  }

  console.log('## Claudinite scheduler\n');
  console.log(renderSummary(evaluations) || '- no tasks due');
}

// Run only when invoked directly (the workflow's `node run.mjs`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
