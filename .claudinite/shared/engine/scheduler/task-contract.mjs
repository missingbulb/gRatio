// The task declaration contract (per-project-scheduling DESIGN §1) — the single
// source of truth for what a `tasks/<name>/task.mjs` default export must carry.
// Both the author-time `task-declaration-shape` check and the executor-side
// `validate-dispatch` validate against this one function, so the accepted shape
// can never drift between the two surfaces.

import { FREQUENCIES } from './slots.mjs';
import { MODEL_FAMILIES } from './model-map.mjs';

// The write ceiling a task declares (DESIGN §1, §4). A declared MAXIMUM, not a
// promise: `none` may never open a PR, `open-pr` may open but never merge,
// `merged-pr` may arm auto-merge. "No change" is always legal.
export const OUTCOMES = ['none', 'open-pr', 'merged-pr'];

// The signal-collector vocabulary (DESIGN §3.3). A task collects only the union
// of what its due tasks declare. `fleet` is canon-only (consumers cannot declare
// it) — that restriction is enforced where signals are collected, not here; the
// shape check only asserts a declared name is a real collector.
export const SIGNAL_NAMES = [
  'commits', 'prs', 'issues', 'branches', 'release',
  'localPacks', 'sharedMount', 'conversationLogs', 'stamp', 'fleet',
];

// Validate one task declaration. Returns an array of `{ what, fix }` problems —
// empty means the declaration is well-formed. Pure: no I/O, no imports of the
// task itself; the caller supplies the already-loaded default export.
export function validateTaskDeclaration(decl) {
  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    return [{ what: 'task.mjs does not default-export a declaration object', fix: 'export default { id, frequency, signals, model, outcome, worker, precondition }' }];
  }
  const problems = [];
  const bad = (what, fix) => problems.push({ what, fix });

  if (typeof decl.id !== 'string' || decl.id.trim() === '') {
    bad('the task has no string "id"', 'give the task an "id" matching its directory name');
  }
  if (!FREQUENCIES.includes(decl.frequency)) {
    bad(`"frequency" ${JSON.stringify(decl.frequency)} is not a legal frequency`, `set one of: ${FREQUENCIES.join(', ')}`);
  }
  if (!Array.isArray(decl.signals) || !decl.signals.every((s) => SIGNAL_NAMES.includes(s))) {
    bad(`"signals" must be an array of known signal names`, `use only: ${SIGNAL_NAMES.join(', ')}`);
  }
  if (!MODEL_FAMILIES.includes(decl.model)) {
    bad(`"model" ${JSON.stringify(decl.model)} is not a legal model family`, `set one of: ${MODEL_FAMILIES.join(', ')}`);
  }
  if (!OUTCOMES.includes(decl.outcome)) {
    bad(`"outcome" ${JSON.stringify(decl.outcome)} is not a legal outcome ceiling`, `set one of: ${OUTCOMES.join(', ')}`);
  }
  if (typeof decl.worker !== 'string' || decl.worker.trim() === '') {
    bad('the task has no string "worker"', 'point "worker" at the worker file beside task.mjs (e.g. "task.md")');
  }
  if (typeof decl.precondition !== 'function') {
    bad('"precondition" is not a function', 'export a precondition(signals, config) that returns { run, reason, context? }');
  }
  return problems;
}
