// The scheduler entrypoint's orchestration core (per-project-scheduling DESIGN
// §3). The vendored hourly Action runs this: decide due slots from the run
// ledger, discover active tasks, collect only the signals the due tasks declare,
// run each precondition, and either dispatch agent work as a `ready-for-agent`
// issue or (for `agent_model: none`) run the worker inline.
//
// This module is the DECISION core, kept injectable so it tests with fakes: the
// GitHub I/O (the Actions run-ledger read for `lastSuccess`, the signal
// collectors, the issue search/create) is supplied by the thin CLI shell around
// `planRun`. The "should this run" verdict is always code here — never the
// shell's judgment (the same split the fleet planner uses).

import { pathToFileURL } from 'node:url';
import { dueSlots, mostRecentSlot } from './slots.mjs';
import {
  planDispatch, dispatchTitle, dispatchBody, DISPATCH_PREFIX, READY_LABEL, NEEDS_HUMAN_LABEL,
  SCHEDULER_LABELS, readyLabelForScope, staleDispatchIssues, staleEscalationComment,
  rearmDispatchIssues, readyLabelOn, staleClaimedDispatchIssues, staleClaimComment,
  AGENT_RUNNING_LABEL,
} from './dispatch.mjs';
import { isAgentless } from './model-map.mjs';
import { localSignalContext } from './signals/local.mjs';
import { runPreprocessing, preprocessingFailure, agentRequestPath, clearAgentRequest, agentRequested } from './preprocess.mjs';

// The due tasks, each paired with the slot it runs under. Union the discovered
// tasks' frequencies, ask slots which are due (run-ledger math), then map due
// frequencies back to their tasks. A task whose frequency isn't due drops out.
export function computeDueTaskSlots(tasks, schedule, now, lastSuccess, forced = []) {
  const frequencies = [...new Set(tasks.map((t) => t.decl.frequency))];
  const due = new Map(dueSlots(frequencies, schedule, now, lastSuccess).map((d) => [d.frequency, d]));
  const out = [];
  for (const task of tasks) {
    const slot = due.get(task.decl.frequency);
    if (slot) { out.push({ task, slotId: slot.slotId, slotTime: slot.slotTime }); continue; }
    // A FORCED task runs under its most-recent slot even though that slot has
    // already been run. This gate is the reason forcing has to live here at all:
    // the due list is computed BEFORE any precondition, so a task whose slot has
    // passed is never looked at again — and a mid-day forced run is the only kind
    // that matters (#515). `planRun` then skips its precondition outright.
    if (forced.includes(task.id)) {
      const s = mostRecentSlot(task.decl.frequency, schedule, now);
      out.push({ task, slotId: s.id, slotTime: s.time, forced: true });
    }
  }
  return out;
}

// The verdict a forced task gets INSTEAD of its precondition. The context line
// is generic on purpose — it names the mechanism, not the task — and it is there
// because a dispatch issue's Context is the agent's binding scope: a forced
// dispatch that carried none would read as a scope of nothing, and the agent
// should know it arrived by a hand-started run rather than a met condition.
const FORCED_VERDICT = Object.freeze({
  run: true,
  reason: 'forced by FORCE_TASKS on a manual scheduler run — its precondition was not evaluated',
  context: Object.freeze(['This run was forced manually (FORCE_TASKS on a workflow_dispatch); the task\'s own precondition was not evaluated, so nothing here asserts there is work to do. Do only what the task file specifies, and converge to a no-op if there is nothing.']),
});

// The task ids a manual run forced, out of the opaque override bag. This is the
// ONE key the engine reads from that bag, and it is deliberately generic: it
// learns "run these task ids", never what any of them do. No task declaration
// mentions forcing, and no precondition is consulted for a forced task — an id
// matching no discovered task simply forces nothing.
export function forcedTaskIds(overrides = {}) {
  return String(overrides.FORCE_TASKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// The union of signal names the due tasks declare — the scheduler collects only
// these, so a non-daily slot never pays for daily tasks' signals (DESIGN §3.3).
export function signalsUnion(dueTaskSlots) {
  const names = new Set();
  for (const { task } of dueTaskSlots) for (const name of task.decl.precondition_signals) names.add(name);
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
    const forced = e.forced ? ' (forced)' : '';
    return `- ${e.pack}/${e.task} [${e.slotId}]${forced} ${verb} — ${e.reason || e.dispatch?.reason || ''}`.trimEnd();
  }).join('\n');
}

// Orchestrate one scheduler run into a set of decisions — the reusable core the
// CLI wraps with real GitHub I/O. Injected seams:
//   collectSignals(names) -> signals object (the declared union, collected once)
//   packConfigFor(packId) -> that pack's entry config from .claudinite-checks.json
//   existingIssuesFor(pack, task) -> the task family's issues [{number,title,state}]
// Returns `{ evaluations }`: one record per due task with its precondition
// verdict and, when it runs, either an inline marker (agent_model: none) or a
// dispatch decision (planDispatch).
export async function planRun({
  tasks, schedule, now, lastSuccess, overrides = {},
  collectSignals, packConfigFor = () => ({}), existingIssuesFor = async () => [],
}) {
  // `overrides` arrives as a parameter rather than out of `signals` because the
  // due list is what decides which signals get collected — the bag has to be
  // known before the collection it would otherwise be part of.
  const dueList = computeDueTaskSlots(tasks, schedule, now, lastSuccess, forcedTaskIds(overrides));
  const signals = await collectSignals(signalsUnion(dueList));

  const evaluations = [];
  for (const { task, slotId, forced } of dueList) {
    // A FORCED task does not consult its precondition at all. "Forced" is a
    // decision the operator already made, so asking the task whether it agrees is
    // both redundant and a way for the answer to be no — and a task that could
    // veto a force would need to know forcing exists, which is exactly the
    // coupling this mechanism avoids. Nothing in a task declaration mentions
    // forcing; the engine owns it end to end.
    const pre = forced ? FORCED_VERDICT : runPrecondition(task, signals, packConfigFor(task.pack));
    const rec = {
      pack: task.pack, task: task.id, slotId,
      model: task.decl.agent_model, outcome: task.decl.expected_outcome,
      run: pre.run, reason: pre.reason, context: pre.context,
    };
    if (forced) rec.forced = true;
    if (pre.error) rec.error = pre.error;
    if (pre.run) {
      // A declared agent_preprocessing runs as a subprocess BEFORE any agent
      // (DESIGN §3) — flagged here (pure) for the summary; the CLI shell executes
      // it. An agentless task is preprocessing-only; an agentful one hands off to
      // the agent after preprocessing succeeds.
      if (task.decl.agent_preprocessing) rec.preprocessing = true;
      if (isAgentless(task.decl.agent_model)) {
        // agent_model: none — no agent and no dispatch issue on success. A task with
        // no preprocessing runs the legacy inline worker; with preprocessing it is
        // the subprocess above.
        rec.inline = true;
      } else {
        const existing = await existingIssuesFor(task.pack, task.id);
        // Route the dispatch to the self or fleet ready label by the task's scope
        // (the fleet/self executor split) — the executor routine wired to that
        // label runs it.
        const readyLabel = readyLabelForScope(task.decl.session_scope);
        rec.dispatch = planDispatch({ existing, pack: task.pack, task: task.id, slotId, readyLabel });
      }
    }
    evaluations.push(rec);
  }
  return { evaluations };
}

// The opaque override bag a MANUAL run may carry (`workflow_dispatch` input →
// `CLAUDINITE_OVERRIDES`). GitHub cannot declare arbitrary named inputs, so the
// workflow takes ONE free-form string and this splits it into keys.
//
// Exactly one key is understood: `FORCE_TASKS` (see `forcedTaskIds`), and it is
// understood GENERICALLY — "run these task ids", never what any of them do. No
// task declaration mentions forcing and no precondition is consulted for a forced
// task, so the scheduler never learns what baselining is and baselining never
// learns that forcing exists. Anything else in the bag is parsed and ignored,
// which is what leaves room for a future override without a schema.
//
// `A=1,B=2`, newline-separated, or bare `A` (⇒ `'true'`). Values stay STRINGS with
// no truthiness coercion: a task compares against the literal it documents, so
// `FORCE_X=false` can never read as "the key is present, therefore on".
export function parseOverrides(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(/[,\n]/)) {
    const token = part.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) out[token] = 'true';
    else out[token.slice(0, eq).trim()] = token.slice(eq + 1).trim();
  }
  return out;
}

// The `ctx` every signal collector reads (DESIGN §3.3) — the already-resolved
// facts a collector may not go and fetch for itself, built once per run and
// handed to `collectSignals`. Exported so the construction itself is testable:
// the collectors' `ctx.X ?? null` seam makes them unit-testable with a hand-built
// ctx, which is exactly why a key nothing here populates can read as "collector
// works" forever. Assert against THIS, not a hand-built shape.
// `root` is the Action-side checkout: the manifest version, the local-pack
// presence and the configured retention are all read from it (signals/local.mjs),
// because a scheduled run already has the tree on disk and an API round-trip
// would buy nothing.
export function buildSignalContext({ root, repo, defaultBranch, now, sinceIso, config, fleet = null, packConfigFor = () => ({}) }) {
  const local = localSignalContext(root, { packIds: config.packs ?? [], packConfigFor });
  return {
    repo, defaultBranch, now, sinceIso, config,
    activePacks: config.packs, fleet,
    manifestVersion: local.manifestVersion,
    hasLocalPacks: local.hasLocalPacks,
    retentionDays: local.retentionDays,
  };
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

// Every OPEN dispatch issue in the repo, with the labels / age / comment count the
// maintenance pass reads. Separate from existingIssuesViaSearch, which is per task
// family and state=all for the filing guards; this one is repo-wide and open-only.
export async function openDispatchIssuesViaSearch(gh, repo) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${DISPATCH_PREFIX}"`);
  const { status, json } = await gh(`/search/issues?q=${q}&per_page=100`);
  if (status !== 200 || !Array.isArray(json?.items)) return [];
  return json.items.map((i) => ({
    number: i.number, title: i.title, labels: i.labels ?? [],
    created_at: i.created_at, updated_at: i.updated_at, comments: i.comments ?? 0,
  }));
}

// The per-run maintenance pass over open dispatch issues (DESIGN §4 lifecycle,
// §5 recovery). Three backstops, in this order:
//   1. STALE — open past ~2 of its own scheduling periods → escalation comment,
//      drop the ready label (so it stops being armed), add `needs-human`.
//   2. DEAD CLAIM — `agent-running` with no activity for ~3h → the session that
//      claimed it died; comment, drop `agent-running`, add `needs-human`.
//   3. RE-ARM — armed but untouched past the grace window → the trigger event was
//      lost, so remove and re-add its ready label to emit a fresh one.
// Stale wins over re-arm: rearmDispatchIssues already excludes the stale set, so an
// issue converging to triage is never re-armed back into circulation.
//
// This is the ONLY recovery path for a missed label event or a dead session. The
// executor no longer sweeps other issues — one session runs exactly the one issue
// that triggered it — so recovery had to become a decision in code here, running
// once per scheduler run, rather than agent judgment replicated across every
// concurrently-triggered session.
export async function maintainDispatchIssues(gh, repo, now, { labelsEnsured = false } = {}) {
  const open = await openDispatchIssuesViaSearch(gh, repo);
  const none = { stale: [], deadClaims: [], rearmed: [] };
  if (!open.length) return none;

  const stale = staleDispatchIssues(open, now);
  const staleNumbers = new Set(stale.map((i) => i.number));
  const deadClaims = staleClaimedDispatchIssues(open, now).filter((i) => !staleNumbers.has(i.number));
  const rearm = rearmDispatchIssues(open, now);
  if (!stale.length && !deadClaims.length && !rearm.length) return none;

  // Applying a label 422s when it does not exist, so guarantee them first — an
  // idle run never gets here, so this costs nothing on the common path.
  if (!labelsEnsured) await ensureLabels(gh, repo, SCHEDULER_LABELS);

  const escalate = async (issue, body, dropLabel) => {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: { body } });
    if (dropLabel) await gh(`/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(dropLabel)}`, { method: 'DELETE' });
    await gh(`/repos/${repo}/issues/${issue.number}/labels`, { method: 'POST', body: { labels: [NEEDS_HUMAN_LABEL] } });
  };

  for (const issue of stale) {
    await escalate(issue, staleEscalationComment(issue), readyLabelOn(issue));
    console.log(`- escalated stale dispatch #${issue.number} to ${NEEDS_HUMAN_LABEL}`);
  }

  for (const issue of deadClaims) {
    await escalate(issue, staleClaimComment(issue), AGENT_RUNNING_LABEL);
    console.log(`- reclaimed dead ${AGENT_RUNNING_LABEL} claim on #${issue.number} → ${NEEDS_HUMAN_LABEL}`);
  }

  for (const issue of rearm) {
    const ready = readyLabelOn(issue);
    const del = await gh(`/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(ready)}`, { method: 'DELETE' });
    if (del.status >= 300) { console.log(`! could not un-label #${issue.number} to re-arm it: ${del.status}`); continue; }
    const add = await gh(`/repos/${repo}/issues/${issue.number}/labels`, { method: 'POST', body: { labels: [ready] } });
    if (add.status >= 300) console.log(`! re-arm of #${issue.number} dropped its ${ready} label: ${add.status}`);
    else console.log(`- re-armed #${issue.number} (${ready}) — its trigger event never landed`);
  }

  return {
    stale: stale.map((i) => i.number),
    deadClaims: deadClaims.map((i) => i.number),
    rearmed: rearm.map((i) => i.number),
  };
}

// Ensure the dispatch labels exist before any is applied — GitHub 422s when you
// apply an unknown label (it never creates one on demand), so the scheduler, as the
// thing that assigns them, guarantees them here. Idempotent (201 created / 422 already
// exists are both success) and self-healing (a deleted label reappears next run), which
// is why no separate one-off label-creation step is needed. Exported for the run tests.
export async function ensureLabels(gh, repo, labels) {
  for (const { name, color, description } of labels) {
    const res = await gh(`/repos/${repo}/labels`, { method: 'POST', body: { name, color, description } });
    if (res.status === 201) continue;                       // created to spec — nothing further
    if (res.status === 422) {
      // The NAME is taken; that says nothing about the colour or description. A
      // label GitHub auto-created (applying an unknown name to an issue mints it
      // grey `ededed`, no description) would keep those defaults for good, because
      // POST 422s forever. So reconcile the shape, not just the existence — that
      // is what makes the self-healing claim above true for drift and not only for
      // deletion. PATCH is idempotent: an already-correct label is a no-op write.
      const fix = await gh(`/repos/${repo}/labels/${encodeURIComponent(name)}`, {
        method: 'PATCH', body: { color, description },
      });
      if (fix.status !== 200) console.log(`! could not reconcile label "${name}": ${fix.status}`);
      continue;
    }
    console.log(`! could not ensure label "${name}": ${res.status}`);
  }
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
  const schedule = config.taskScheduler;

  const due = computeDueTaskSlots(tasks, schedule, now, lastSuccess);
  const sinceIso = windowStart(due, now);

  // The fleet aggregate (canon-only, DESIGN §3.3) is expensive — a full
  // enumeration over the fleet PAT — so build it ONLY when a due task actually
  // declares the `fleet` signal, and only when FLEET_GITHUB_TOKEN is set (the
  // canon repo with the census credential). Otherwise ctx.fleet stays null and
  // the collector returns null, so a fleet task's precondition skips rather than
  // crashes. Enumeration failures are surfaced by readFleet as `{ error }`, not
  // thrown — a fleet task treats that as "no work I can prove".
  let fleet = null;
  if (signalsUnion(due).includes('fleet')) {
    const { readFleet, makeFleetGh } = await import('./signals/fleet.mjs');
    const fleetGh = makeFleetGh();
    if (fleetGh) {
      const owner = repo.split('/')[0];
      fleet = await readFleet(fleetGh, { owner, canonRepo: repo, sinceIso });
      if (fleet.error) console.log(`! fleet enumeration: ${fleet.error}`);
    } else {
      console.log('- a due task declares the `fleet` signal but FLEET_GITHUB_TOKEN is not set — skipping fleet-scoped tasks');
    }
  }

  const packConfigFor = (packId) => config.packConfig?.[packId] ?? {};

  // An override only ever arrives on a hand-started run, and it makes a task run
  // that its own precondition would have skipped — so say so in the log. An
  // unattended system that can be forced silently is one whose run history stops
  // explaining itself.
  const overrides = parseOverrides(process.env.CLAUDINITE_OVERRIDES);
  const overrideKeys = Object.keys(overrides);
  if (overrideKeys.length > 0) {
    console.log(`- manual run overrides: ${overrideKeys.map((k) => `${k}=${overrides[k]}`).join(', ')}`);
  }

  const ctx = buildSignalContext({
    root, repo, defaultBranch, now: now.toISOString(), sinceIso, config, fleet, packConfigFor,
  });

  const { evaluations } = await planRun({
    tasks, schedule, now, lastSuccess, overrides,
    collectSignals: (names) => collectSignals(gh, ctx, names),
    packConfigFor,
    existingIssuesFor: (pack, task) => existingIssuesViaSearch(gh, repo, pack, task),
  });

  // Guarantee the dispatch labels exist before we file any labeled issue — when a
  // task will dispatch OR will run preprocessing (which may converge to
  // needs-human). An idle run pays nothing.
  const labelsEnsured = evaluations.some((r) => r.run && (r.preprocessing || (!r.inline && r.dispatch?.action === 'create')));
  if (labelsEnsured) await ensureLabels(gh, repo, SCHEDULER_LABELS);

  // File the labeled hand-off issue the executor runs (READY_LABEL): first line is
  // the task path, body carries the precondition's binding Context (dispatch.mjs).
  const fileHandoff = async (rec, taskObj) => {
    const title = dispatchTitle({ pack: rec.pack, task: rec.task, slotId: rec.slotId });
    const body = dispatchBody({ taskPath: taskObj.taskPath, pack: rec.pack, task: rec.task, slotId: rec.slotId, context: rec.context });
    // The scope-resolved ready label (self vs fleet) from planDispatch — the
    // executor routine wired to it runs the task.
    const readyLabel = rec.dispatch?.label ?? READY_LABEL;
    const res = await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels: [readyLabel] } });
    if (res.status >= 300) console.log(`! failed to file dispatch issue for ${rec.pack}/${rec.task}: ${res.status}`);
  };

  // Converge a failed preprocessing run to a single open needs-human issue for the
  // family — at-most-one-open, so a repeatedly-failing task never spams issues.
  const fileNeedsHuman = async (rec, why, extra) => {
    const existing = await existingIssuesViaSearch(gh, repo, rec.pack, rec.task);
    if (existing.some((i) => i.state === 'open')) {
      console.log(`  (an open dispatch issue already covers ${rec.pack}/${rec.task} — not filing another)`);
      return;
    }
    const title = dispatchTitle({ pack: rec.pack, task: rec.task, slotId: rec.slotId });
    const body = [
      `Preprocessing for \`${rec.pack}/${rec.task}\` (slot \`${rec.slotId}\`) failed and needs human triage.`,
      '', `- ${why}`, ...extra.map((e) => `- ${e}`),
    ].join('\n') + '\n';
    const res = await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels: [NEEDS_HUMAN_LABEL] } });
    if (res.status >= 300) console.log(`! failed to file needs-human issue for ${rec.pack}/${rec.task}: ${res.status}`);
  };

  for (const rec of evaluations) {
    if (!rec.run) continue;
    const taskObj = tasks.find((t) => t.pack === rec.pack && t.id === rec.task);
    const decl = taskObj.decl;

    // Stage 1 — preprocessing (DESIGN §3): run the declared command as a subprocess
    // bounded by its timeout, before any agent. Its cwd is the task dir; the repo
    // root + slot context ride in via CLAUDINITE_* env.
    if (rec.preprocessing) {
      // A per-run signal path the worker writes to REQUEST the agent stage
      // (conditional handoff, §3). Clear any stale one first so a prior run can't
      // spuriously escalate this one.
      const requestPath = agentRequestPath(rec);
      clearAgentRequest(requestPath);
      const result = await runPreprocessing(decl.agent_preprocessing, {
        taskDir: taskObj.taskDir,
        env: {
          ...process.env,
          CLAUDINITE_REPO_ROOT: root,
          CLAUDINITE_REPO: repo,
          CLAUDINITE_DEFAULT_BRANCH: defaultBranch ?? '',
          CLAUDINITE_SLOT_ID: rec.slotId,
          CLAUDINITE_PACK: rec.pack,
          CLAUDINITE_TASK: rec.task,
          CLAUDINITE_REQUEST_AGENT: requestPath,
        },
        timeoutSeconds: decl.agent_preprocessing_timeout,
      });
      rec.preprocessResult = { ok: result.ok, timedOut: result.timedOut, code: result.code };
      if (!result.ok) {
        const why = preprocessingFailure(result);
        console.log(`! preprocessing ${rec.pack}/${rec.task} [${rec.slotId}]: ${why}`);
        const extra = result.stderr?.trim() ? [`stderr tail: ${result.stderr.trim().split('\n').slice(-3).join(' / ')}`] : [];
        await fileNeedsHuman(rec, why, extra);
        clearAgentRequest(requestPath);
        continue; // never hand off to an agent after a failed preprocessing
      }
      // Success. An agentless task is done (no issue on success, as the old inline
      // was quiet). An agentful one hands off ONLY when the worker requested the
      // agent (conditional escalation, §3): a task that absorbs its work into
      // preprocessing stays quiet on the nights nothing needs judgment.
      const requested = agentRequested(requestPath);
      clearAgentRequest(requestPath);
      rec.agentRequested = requested;
      console.log(`preprocessing ${rec.pack}/${rec.task} [${rec.slotId}]: ok${rec.inline ? '' : requested ? ' (agent requested)' : ' (no agent needed)'}`);
      if (rec.inline) continue;
      if (requested && rec.dispatch?.action === 'create') await fileHandoff(rec, taskObj);
      continue;
    }

    // No preprocessing. An agentless task with no preprocessing does nothing — the
    // contract now forbids it (agent_model:none REQUIRES agent_preprocessing, so
    // the in-process inline worker path is retired, DESIGN §4). Defensive no-op
    // should one slip past validation.
    if (rec.inline) {
      console.log(`- ${rec.pack}/${rec.task}: agentless with no preprocessing — nothing to run (contract-forbidden)`);
      continue;
    }
    // Agent task with no preprocessing → today's immediate labeled dispatch.
    if (rec.dispatch?.action === 'create') await fileHandoff(rec, taskObj);
  }

  // Maintenance over the open dispatch issues, AFTER this run's filings: the
  // issues just filed are seconds old, so the grace window keeps them out of the
  // re-arm set and only the previous cycles' leftovers are considered.
  await maintainDispatchIssues(gh, repo, now, { labelsEnsured });

  console.log('## Claudinite scheduler\n');
  console.log(renderSummary(evaluations) || '- no tasks due');
}

// Run only when invoked directly (the workflow's `node run.mjs`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
