// What each scheduler run DID to each due task, as one machine-readable line per
// evaluation in the run's Actions log (skill-usage-metrics DESIGN §4.2).
//
// WHY A LINE AND NOT A FILE. The scheduler is stateless by design — its only
// watermark is the Actions run ledger — and a per-run write to a tracked branch
// would be 24 commits a day of data the run already emits. The Actions log is the
// record the run already leaves, is retained by the platform, and is readable over
// one API call; so the run states its outcomes there and whatever usage aggregation
// a repo declares reads them back. This module is the SINGLE source of truth for that
// format: the renderer the scheduler prints with and the parser a reader reads with
// sit next to each other, with a round-trip test pinning them together, because a
// format written in one place and re-guessed in another is exactly the drift this
// repo bans.
//
// WHY NOT THE HUMAN SUMMARY LINE (`renderSummary`). That line is written BEFORE the
// actions run and reports what was PLANNED — an agentful task whose preprocessing
// then requested no agent still reads as its dispatch decision there. These records
// are derived AFTER the loop, from the same record the loop mutated, so they report
// what actually happened. The human summary stays what it is: prose for a person
// reading the run.
//
// The counts these produce are exact within the Actions log retention window, and
// that is worth stating next to the capture-derived counts they land beside: every
// scheduler run logs every due task, so a task's invocation counts are a CENSUS of
// scheduled work — unlike the skill and check counts, which see only the sessions
// that captured.

// The five things a scheduler run can do with a due task. One name per outcome,
// used verbatim as the counter key in the aggregate, so there is no mapping table
// between "what the run said" and "what the fold counted" to drift.
export const TASK_RUN_OUTCOMES = Object.freeze([
  // A dispatch issue was filed: an executor session runs this task with an agent.
  'agent',
  // The task ran with NO agent — an `agent_model: none` task (preprocessing is the
  // whole task), or an agentful one whose preprocessing requested no agent stage.
  'preprocess',
  // Due, but its precondition said there was nothing to do.
  'skipped',
  // Its preprocessing failed; the run converged the task to a needs-human issue.
  'failed',
  // Due and past its precondition, but no NEW agent run started: this slot was
  // already dispatched (exactly-once), or an earlier dispatch is still open
  // (at-most-one-open). Work that was wanted and did not happen this run.
  'deferred',
]);

// An empty per-task counter row — every outcome present, zeros included, so a row's
// shape never depends on which outcomes a task happened to hit.
export const emptyTaskRun = () => Object.fromEntries(TASK_RUN_OUTCOMES.map((o) => [o, 0]));

// What this run did to one evaluated task, from the record the action loop left
// behind (`planRun`'s evaluation, mutated in `main`). Pure — every field it reads
// is already on the record.
export function taskRunOutcome(rec) {
  if (!rec.run) return 'skipped';
  if (rec.preprocessResult && !rec.preprocessResult.ok) return 'failed';
  if (rec.inline) return 'preprocess';
  // Agentful. With preprocessing, the agent stage is CONDITIONAL: a task that
  // absorbed its work into the deterministic pass stays quiet, and that is a run of
  // the task, not a skip of it.
  if (rec.preprocessing && !rec.agentRequested) return 'preprocess';
  return rec.dispatch?.action === 'create' ? 'agent' : 'deferred';
}

// The line format. `v1` is the shape's version: a reader that meets a `v2` line
// knows it is looking at something it was not written for, instead of silently
// half-parsing it.
export const TASK_RUN_TAG = 'claudinite-task-run';
const VERSION = 'v1';

export const renderTaskRun = (rec) =>
  `${TASK_RUN_TAG} ${VERSION} ${rec.pack}/${rec.task} [${rec.slotId}] ${taskRunOutcome(rec)}`;

export const renderTaskRuns = (evaluations) => evaluations.map(renderTaskRun).join('\n');

// Actions stamps every log line with its own timestamp before the command's output,
// so the parse tolerates that prefix — without it, a fetched log reads as having
// printed nothing at all.
const LINE_RE = new RegExp(
  String.raw`^(?:\S+\s+)?${TASK_RUN_TAG} ${VERSION} (\S+)/(\S+) \[(\S+)\] ([a-z-]+)\s*$`,
);

// One line → `{ pack, task, slotId, outcome }`, or null for anything that is not a
// record of this version. Deliberately strict: an unknown outcome word is NOT a
// record, because counting it would mint a counter key nothing ever reads.
export function parseTaskRun(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, pack, task, slotId, outcome] = m;
  if (!TASK_RUN_OUTCOMES.includes(outcome)) return null;
  return { pack, task, slotId, outcome };
}

// Every record in one job log. The log is the whole job's output — this picks its
// own lines out of it and ignores everything else.
export function parseTaskRuns(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const rec = parseTaskRun(line);
    if (rec) out.push(rec);
  }
  return out;
}
