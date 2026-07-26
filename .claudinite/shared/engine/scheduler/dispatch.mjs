// The dispatch issue — how a due (task, slot) becomes exactly-once, bounded,
// recoverable agent work (per-project-scheduling DESIGN §4). This module is the
// PURE half: issue identity (title/body/parse) and the create / skip / suppress
// decision over the issues that already exist. A thin scheduler shell does the
// GitHub I/O (search state=all, create, label, comment) and applies the verdict
// — the "should I file this" decision is always code here, never the shell's
// judgment (the same split the fleet planner uses).
//
// All behavior-defining content (agent_model, expected_outcome, agent_instructions) is read from the
// tracked task files, never from the issue — the body only points at the task
// file and carries the precondition's binding Context (DESIGN §4).

// The labels this machinery drives. `ready-for-agent` is what the executor
// routine fires on; `needs-human` is the single triage state every anomaly
// converges to (DESIGN §4 lifecycle). Kept here as the shared source for the
// scheduler side; the executor reuses these plus `agent-running`.
export const READY_LABEL = 'ready-for-agent';
// A fleet-scoped task (session_scope: 'fleet') dispatches to a DISTINCT ready
// label so a separate, broader-scoped executor routine runs it — keeping the
// fleet-wide session grant off every ordinary project's self executor (the
// per-project-scheduling fleet/self split). Only tasks that reach other repos use
// this; today just growth-promote.
export const READY_FLEET_LABEL = 'ready-for-agent-fleet';
export const AGENT_RUNNING_LABEL = 'agent-running';
export const NEEDS_HUMAN_LABEL = 'needs-human';
export const WORKFLOW_FAILURE_LABEL = 'workflow-failure';

// The ready label a task's dispatch is filed under, from its declared
// session_scope ('self' default → READY_LABEL; 'fleet' → READY_FLEET_LABEL). The
// one place this mapping lives, so the scheduler (which files) and any reader stay
// in sync.
export const readyLabelForScope = (scope) => (scope === 'fleet' ? READY_FLEET_LABEL : READY_LABEL);

// The full label set the scheduler + executor drive, each with the colour and
// description a bootstrap one-off would have given it. The scheduler ENSURES every
// one exists (create-if-missing, idempotent) right before it dispatches — so there
// is no separate label-creation step to run or forget, and a deleted label
// self-heals on the next run. This is load-bearing, not cosmetic: GitHub does not
// create a label when you apply it (the issues API 422s on an unknown label), so
// the thing that assigns a label must guarantee it first — the
// gha/label-create-before-add principle, enforced in code here.
export const SCHEDULER_LABELS = [
  { name: READY_LABEL, color: '0e8a16', description: 'Claudinite scheduler: dispatch issue ready for the (self-scoped) executor to run' },
  { name: READY_FLEET_LABEL, color: '1d76db', description: 'Claudinite scheduler: dispatch issue ready for the FLEET-scoped executor (a task that reaches other repos)' },
  { name: AGENT_RUNNING_LABEL, color: 'fbca04', description: 'Claudinite scheduler: the executor has claimed this issue and is running it' },
  { name: NEEDS_HUMAN_LABEL, color: 'd93f0b', description: 'Claudinite scheduler: an anomaly that converged here for human triage' },
  { name: WORKFLOW_FAILURE_LABEL, color: 'b60205', description: 'Claudinite scheduler: a scheduler run or task failed' },
];

// Title: `[claudinite-task] <pack>/<task> <slot-id>` (DESIGN §4). The prefix is
// what keeps these issues invisible to the scheduler's own signals (self-trigger
// exclusion) and searchable as a family.
export const DISPATCH_PREFIX = '[claudinite-task]';

export const dispatchTitle = ({ pack, task, slotId }) => `${DISPATCH_PREFIX} ${pack}/${task} ${slotId}`;

// The (pack, task) family key — every slot's title for one task starts with
// `<key> ` (the trailing space before the slot id is load-bearing: it stops
// `foo/extract` from matching `foo/extract-more`).
export const dispatchTaskKey = ({ pack, task }) => `${DISPATCH_PREFIX} ${pack}/${task}`;

// pack and task ids are single path segments (no slash, no space); the slot id
// is the trailing non-space token.
const DISPATCH_TITLE_RE = /^\[claudinite-task\]\s+([^/\s]+)\/([^/\s]+)\s+(\S+)$/;

export function parseDispatchTitle(title) {
  const m = DISPATCH_TITLE_RE.exec(String(title ?? '').trim());
  return m ? { pack: m[1], task: m[2], slotId: m[3] } : null;
}

// Is this a scheduler dispatch issue? The self-trigger exclusion the signal
// collectors apply so the scheduler never sees its own dispatch issues as work.
export const isDispatchTitle = (title) => parseDispatchTitle(title) !== null;

// The dispatch issue body (DESIGN §4). First line is the task-file path — the
// only thing the executor reads to locate the worker; everything below is human
// framing plus the precondition's binding Context. The Context block is emitted
// only when the precondition produced lines (an empty scope has nothing to bind).
export function dispatchBody({ taskPath, pack, task, slotId, context = [] }) {
  const lines = [taskPath, ''];
  if (context.length) {
    lines.push(
      `Execute the Claudinite task above (pack \`${pack}\`, task \`${task}\`, slot \`${slotId}\`).`,
      'The Context section below is binding scope — do not re-decide it.',
      '',
      '### Context',
    );
    for (const c of context) lines.push(`- ${c}`);
  } else {
    lines.push(`Execute the Claudinite task above (pack \`${pack}\`, task \`${task}\`, slot \`${slotId}\`).`);
  }
  return lines.join('\n') + '\n';
}

// The filing decision for one due (task, slot), given `existing` — the issues
// the shell fetched for this task's family (title starts with the task key),
// each `{ number, title, state }` with state 'open' | 'closed'. Two guards
// (DESIGN §4):
//   - exactly-once per (task, slot): a state=all title match for THIS slot → skip
//     (makes double-runs and crash-retries safe).
//   - at-most-one-open per task: any OPEN family issue (any slot) suppresses a
//     new filing → an executor outage accumulates at most one issue per task.
// Otherwise: create (the shell files it labeled with `readyLabel` — the
// self/fleet ready label the task's scope resolves to, default `ready-for-agent`).
export function planDispatch({ existing = [], pack, task, slotId, readyLabel = READY_LABEL }) {
  const title = dispatchTitle({ pack, task, slotId });
  const keyPrefix = `${dispatchTaskKey({ pack, task })} `;
  const family = existing.filter((i) => `${(i.title ?? '').trim()} `.startsWith(keyPrefix));

  if (family.some((i) => (i.title ?? '').trim() === title)) {
    return { action: 'skip', reason: `dispatch issue for slot ${slotId} already exists (exactly-once)` };
  }
  const open = family.find((i) => i.state === 'open');
  if (open) {
    return { action: 'suppress', openIssue: open.number, reason: `an open dispatch issue (#${open.number}) already covers ${pack}/${task}` };
  }
  return { action: 'create', title, label: readyLabel, reason: `no dispatch issue yet for ${pack}/${task} slot ${slotId}` };
}

// The period one slot id represents, from its leading kind char (h/d/w/m). Used
// only for the stale-issue backstop's threshold; daily-family slots all span a
// day. Monthly uses 31 days so the ~2-period threshold never fires early in a
// long month.
const SLOT_PERIOD_MS = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 31 * 86400e3 };

function slotPeriodMs(slotId) {
  return SLOT_PERIOD_MS[String(slotId ?? '')[0]] ?? null;
}

// Open dispatch issues older than `factor` of their own period (DESIGN §4: ~2
// periods) — the scheduler's backstop when no executor session drains them. The
// shell adds the escalation comment + `needs-human` to each. `issue.created_at`
// is the ISO string GitHub returns; a title that doesn't parse (or an unknown
// slot kind) is never stale here.
export function staleDispatchIssues(openIssues = [], now, { factor = 2 } = {}) {
  const nowMs = new Date(now).getTime();
  return openIssues.filter((issue) => {
    const parsed = parseDispatchTitle(issue.title);
    if (!parsed) return false;
    const period = slotPeriodMs(parsed.slotId);
    if (period === null) return false;
    return nowMs - new Date(issue.created_at).getTime() > factor * period;
  });
}

// The escalation comment the shell posts on a stale dispatch issue.
export function staleEscalationComment(issue) {
  const parsed = parseDispatchTitle(issue.title);
  const which = parsed ? `${parsed.pack}/${parsed.task} (slot ${parsed.slotId})` : 'this task';
  return `This dispatch issue for ${which} has stayed open past ~2 of its scheduling periods without being executed — `
    + `no executor session ran it. Labeling \`${NEEDS_HUMAN_LABEL}\` for triage.`;
}

// --- re-arming a lost trigger ------------------------------------------------
// The label event is the executor's ONLY trigger, and a delivery can be lost: the
// routine was down or paused, or a session died before it claimed. The issue then
// sits armed forever, because the label is already applied and GitHub emits
// `labeled` only on a fresh add. So the scheduler re-arms it — remove the ready
// label, add it back — which emits a new event.
//
// This is the recovery that used to live in the executor's drain sweep, moved into
// deterministic code. The sweep had EVERY triggered session also process every
// OTHER armed issue, so one scheduler run filing N dispatches produced N sessions
// each racing over the same N issues, and the claim swap could not stop it (every
// session read the work list before any claim landed). That is the
// duplicate-execution bug: the same dispatch run two or three times over,
// duplicate tracker issues, duplicate PRs making the same changes. Recovery
// belongs here, where it is a decision in code that runs once per scheduler run.

const READY_LABELS = new Set([READY_LABEL, READY_FLEET_LABEL]);

// GitHub hands labels back as objects on the issues/search APIs and as bare
// strings in some fixtures; accept either.
const labelNames = (issue) =>
  (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

// The ready label an issue currently carries, or null. Re-arming reapplies THIS
// one, so a fleet dispatch is never re-armed as a self dispatch (which would hand
// it to an executor whose session lacks the cross-repo reach it needs).
export function readyLabelOn(issue) {
  return labelNames(issue).find((n) => READY_LABELS.has(n)) ?? null;
}

// The open dispatch issues whose trigger evidently never landed. Re-arm only an
// issue that is:
//   - a dispatch issue (parseable title) still carrying a ready label;
//   - unclaimed — no `agent-running` (a live session claims before it dispatches)
//     and not already converged to `needs-human`;
//   - uncommented — the executor comments on every exit path, so a comment means
//     some session engaged and this is not a lost event; and
//   - past `graceMs` (default 20m), comfortably beyond session spin-up, so a
//     session already on its way is never handed a rival.
// A stale issue is never re-armed: it is on its way to `needs-human`, and re-arming
// one would loop forever. That backstop is also what bounds this — an executor that
// stays down is re-armed each run until ~2 periods, then converges to triage.
// Dispatch issues left claimed by a session that died mid-run: `agent-running`
// with no activity for `idleMs` (~3h). Converging these used to be the executor's
// own step 6, which meant every concurrently-triggered session swept them and
// commented on the same issue — the duplicate-work bug in miniature. It is code
// here for the same reason the re-arm is.
//
// Scoped to `[claudinite-task]` dispatch issues deliberately (the title parse is
// what enforces it): a task may put `agent-running` on an issue IT owns — a
// request its pipeline has claimed, which stays claimed while its PR is in review,
// far longer than 3h — and only that task knows when its own claim is stale.
export function staleClaimedDispatchIssues(openIssues = [], now, { idleMs = 3 * 3600e3 } = {}) {
  const nowMs = new Date(now).getTime();
  return openIssues.filter((issue) => {
    if (!parseDispatchTitle(issue.title)) return false;
    const names = labelNames(issue);
    if (!names.includes(AGENT_RUNNING_LABEL) || names.includes(NEEDS_HUMAN_LABEL)) return false;
    return nowMs - new Date(issue.updated_at ?? issue.created_at).getTime() > idleMs;
  });
}

// The comment the shell posts when it reclaims a dead session's claim.
export function staleClaimComment(issue) {
  const parsed = parseDispatchTitle(issue.title);
  const which = parsed ? `${parsed.pack}/${parsed.task} (slot ${parsed.slotId})` : 'this task';
  return `This dispatch issue for ${which} has carried \`${AGENT_RUNNING_LABEL}\` for over 3h with no activity — `
    + `the executor session that claimed it never converged it. Labeling \`${NEEDS_HUMAN_LABEL}\` for triage.`;
}

export function rearmDispatchIssues(openIssues = [], now, { graceMs = 20 * 60e3 } = {}) {
  const nowMs = new Date(now).getTime();
  const stale = new Set(staleDispatchIssues(openIssues, now).map((i) => i.number));
  return openIssues.filter((issue) => {
    if (!parseDispatchTitle(issue.title)) return false;
    if (stale.has(issue.number)) return false;
    if (!readyLabelOn(issue)) return false;
    const names = labelNames(issue);
    if (names.includes(AGENT_RUNNING_LABEL) || names.includes(NEEDS_HUMAN_LABEL)) return false;
    if ((issue.comments ?? 0) > 0) return false;
    return nowMs - new Date(issue.created_at).getTime() > graceMs;
  });
}
