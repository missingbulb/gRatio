// The dispatch issue — how a due (task, slot) becomes exactly-once, bounded,
// recoverable agent work (per-project-scheduling DESIGN §4). This module is the
// PURE half: issue identity (title/body/parse) and the create / skip / suppress
// decision over the issues that already exist. A thin scheduler shell does the
// GitHub I/O (search state=all, create, label, comment) and applies the verdict
// — the "should I file this" decision is always code here, never the shell's
// judgment (the same split the fleet planner uses).
//
// All behavior-defining content (model, outcome, worker) is read from the
// tracked task files, never from the issue — the body only points at the task
// file and carries the precondition's binding Context (DESIGN §4).

// The labels this machinery drives. `ready-for-agent` is what the executor
// routine fires on; `needs-human` is the single triage state every anomaly
// converges to (DESIGN §4 lifecycle). Kept here as the shared source for the
// scheduler side; the executor reuses these plus `agent-running`.
export const READY_LABEL = 'ready-for-agent';
export const NEEDS_HUMAN_LABEL = 'needs-human';

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
// Otherwise: create (the shell files it labeled `ready-for-agent`).
export function planDispatch({ existing = [], pack, task, slotId }) {
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
  return { action: 'create', title, label: READY_LABEL, reason: `no dispatch issue yet for ${pack}/${task} slot ${slotId}` };
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
    + `no executor session drained it. Labeling \`${NEEDS_HUMAN_LABEL}\` for triage.`;
}
