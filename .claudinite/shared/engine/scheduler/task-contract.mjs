// The task declaration contract (per-project-scheduling DESIGN §1) — the single
// source of truth for what a `tasks/<name>/task.mjs` default export must carry.
// Both the author-time `task-declaration-shape` check and the executor-side
// `validate-dispatch` validate against this one function, so the accepted shape
// can never drift between the two surfaces.

import { FREQUENCIES } from './slots.mjs';
import { MODEL_FAMILIES } from './model-map.mjs';

// A declared timeout is always a whole number of seconds, > 0.
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

// A preprocessing command must stay inside its own task directory — no absolute
// path and no `..` traversal in the command string — the same containment the
// worker-file rule gives agent_instructions (agent-preprocessing DESIGN §2).
const escapesTaskDir = (cmd) => /(^|\s)\//.test(cmd) || cmd.includes('..');

// The write ceiling a task declares (DESIGN §1, §4). A declared MAXIMUM, not a
// promise: `none` may never open a PR, `open-pr` may open but never merge,
// `merged-pr` may arm auto-merge. "No change" is always legal.
export const OUTCOMES = ['none', 'open-pr', 'merged-pr'];

// The executor-session repo scope a task needs (per-project-scheduling split):
//   'self'  — the task touches only its own repo; a project-only executor session
//             is all it needs. This is the default, and almost every task's scope.
//   'fleet' — the task reaches across the owner's other repos (e.g. growth-promote
//             reads every member's local packs), so its dispatch goes to a
//             SEPARATE, broader-scoped executor. Isolating this to the few tasks
//             that truly need it keeps the fleet-wide session grant off every
//             ordinary project's executor. The scheduler routes a fleet task's
//             dispatch to the `ready-for-agent-fleet` label so a distinct executor
//             routine (with the owner's repos in its sources) runs it.
export const SESSION_SCOPES = ['self', 'fleet'];

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
    return [{ what: 'task.mjs does not default-export a declaration object', fix: 'export default { id, frequency, precondition_signals, agent_model, expected_outcome, agent_instructions, precondition }' }];
  }
  const problems = [];
  const bad = (what, fix) => problems.push({ what, fix });

  if (typeof decl.id !== 'string' || decl.id.trim() === '') {
    bad('the task has no string "id"', 'give the task an "id" matching its directory name');
  }
  if (!FREQUENCIES.includes(decl.frequency)) {
    bad(`"frequency" ${JSON.stringify(decl.frequency)} is not a legal frequency`, `set one of: ${FREQUENCIES.join(', ')}`);
  }
  if (!Array.isArray(decl.precondition_signals) || !decl.precondition_signals.every((s) => SIGNAL_NAMES.includes(s))) {
    bad(`"precondition_signals" must be an array of known signal names`, `use only: ${SIGNAL_NAMES.join(', ')}`);
  }
  if (!MODEL_FAMILIES.includes(decl.agent_model)) {
    bad(`"agent_model" ${JSON.stringify(decl.agent_model)} is not a legal model family`, `set one of: ${MODEL_FAMILIES.join(', ')}`);
  }
  if (!OUTCOMES.includes(decl.expected_outcome)) {
    bad(`"expected_outcome" ${JSON.stringify(decl.expected_outcome)} is not a legal outcome ceiling`, `set one of: ${OUTCOMES.join(', ')}`);
  }
  if (typeof decl.agent_instructions !== 'string' || decl.agent_instructions.trim() === '') {
    bad('the task has no string "agent_instructions"', 'point "agent_instructions" at the worker file beside task.mjs (e.g. "task.md")');
  }
  if (typeof decl.precondition !== 'function') {
    bad('"precondition" is not a function', 'export a precondition(signals, config) that returns { run, reason, context? }');
  }

  // session_scope — OPTIONAL, defaults to 'self'. Only a task that reaches other
  // repos declares 'fleet' (routed to the fleet executor). A bad value would
  // silently mis-route the dispatch, so it is validated when present.
  if (decl.session_scope !== undefined && !SESSION_SCOPES.includes(decl.session_scope)) {
    bad(`"session_scope" ${JSON.stringify(decl.session_scope)} is not a legal session scope`, `omit it (defaults to "self") or set one of: ${SESSION_SCOPES.join(', ')}`);
  }

  // Preprocessing (agent-preprocessing DESIGN §2) — OPTIONAL. A command the
  // scheduler runs as a subprocess before the agent. When present it must be a
  // non-empty, task-local command AND carry a positive-integer
  // agent_preprocessing_timeout — the hard kill that bounds the subprocess.
  if (decl.agent_preprocessing !== undefined) {
    if (typeof decl.agent_preprocessing !== 'string' || decl.agent_preprocessing.trim() === '') {
      bad('"agent_preprocessing" is present but not a non-empty string', 'set it to a command whose executable is a script beside task.mjs, e.g. "node prepare.mjs"');
    } else if (escapesTaskDir(decl.agent_preprocessing)) {
      bad('"agent_preprocessing" reaches outside the task directory (absolute path or "..")', 'reference a sibling script only, e.g. "node prepare.mjs"');
    }
    if (!isPositiveInt(decl.agent_preprocessing_timeout)) {
      bad('"agent_preprocessing" is set but "agent_preprocessing_timeout" is not a positive integer', 'add "agent_preprocessing_timeout": the seconds after which the subprocess is killed and the task fails');
    }
  }

  // The repo Actions secrets this task needs configured (DESIGN §9). Purely
  // DECLARATIVE — like a pack's adoption `questions`, its job is to drive the ask
  // (adoption interactively, the scheduler by owner issue), not to gate anything
  // here. So the only shape asserted is "a list of names"; whether the repo has
  // actually configured them is a fact about the repo, answered where the secrets
  // bundle is readable, never at author time.
  if (decl.required_secrets !== undefined
      && !(Array.isArray(decl.required_secrets) && decl.required_secrets.every((s) => typeof s === 'string' && s.trim() !== ''))) {
    bad('"required_secrets" is not an array of secret names', 'list the repo Actions secret names this task needs, e.g. ["SOME_API_KEY"]');
  }

  // Execution bound (agent-preprocessing DESIGN §2, §6) — an agentic task MUST
  // declare a positive-integer agent_execution_timeout. There is always a bound
  // on an agentic run; enforcement is best-effort (the executor surfaces the
  // value to the subagent). A `none` task runs no agent, so it needs none.
  if (MODEL_FAMILIES.includes(decl.agent_model) && decl.agent_model !== 'none' && !isPositiveInt(decl.agent_execution_timeout)) {
    bad('an agentic task (agent_model !== "none") declares no positive-integer "agent_execution_timeout"', 'add "agent_execution_timeout": the seconds bounding the agentic run — generous; extreme protection, not a scheduling knob');
  }

  // An agentless task (agent_model: none) runs no agent, so its ONLY work is
  // preprocessing — a `none` task with no agent_preprocessing does nothing
  // (DESIGN §4, retiring the in-process inline path). Require the command.
  if (decl.agent_model === 'none' && decl.agent_preprocessing === undefined) {
    bad('an agentless task (agent_model: "none") declares no "agent_preprocessing"', 'add "agent_preprocessing" (a none task does its work in that subprocess) — or give the task an agent_model');
  }

  return problems;
}
