// The executor's entry gate: identify the ONE dispatch this session was started
// for, and validate it in code BEFORE any model judgment (per-project-scheduling
// DESIGN §5.2). This is the CLI shell `validate-dispatch.mjs` was written to be
// driven by — it wires that pure core's `exists` / `isPackDeclared` / `loadTask`
// capabilities to this checkout and hands it the issue body.
//
// IT DOES NOT CLAIM. The claim protocol (read labels → swap ready → agent-running
// → post a claim comment → re-read, earliest claim wins) needs GitHub WRITES,
// which the executor session can only make through its MCP tools, so it stays
// agent-driven prose in executor.md. This shell only decides "is there a dispatch
// here, is it mine, and is it legal".
//
// TWO TRIGGER SOURCES, because the same `issues.labeled` webhook reaches an
// executor session by two different transports and only one of them was ever
// read here:
//
//   1. GITHUB ACTIONS writes the whole webhook payload to disk at
//      `$GITHUB_EVENT_PATH` — `action`, `label.name` and the entire `issue`
//      object, `issue.number` and `issue.body` included. Payload plus local
//      checkout is everything the validation needs, in one shot.
//   2. CLAUDE CODE ON THE WEB (CCR) delivers the same trigger as environment
//      variables instead — `CCR_TRIGGER_SOURCE`, `CCR_TRIGGER_EVENT`,
//      `CCR_TRIGGER_REPO`, `CCR_TRIGGER_ISSUE_NUMBER` — and writes no payload
//      file at all. It NAMES the issue but carries neither the label that was
//      added nor the body, so it resolves in two shots: this shell reports
//      `needs-issue` with the number, the executor fetches that one issue's body
//      and labels over MCP, and re-invokes with them (`--issue-body-file`,
//      `--issue-labels`) for the identical validation.
//
// Reading only source 1 is what made every CCR-run executor session miss its own
// trigger and select an issue by listing instead — the duplicate-execution bug
// re-entered through the front door. Observed live 2026-07-28: two sessions each
// selected dispatch #772 and claimed it one second apart.
//
// ZERO NETWORK, BY CONSTRUCTION — still. The executor session is MCP-only and
// carries no repo credential of its own, so anything reaching the GitHub REST API
// here would both fail to authenticate and trip the in-session-github-access
// rule. The CCR path does not change that: this shell never fetches the issue
// itself, it tells the EXECUTOR to fetch it over MCP and hand the bytes back.
//
// EXIT CODES ARE THE INTERFACE (see EXIT below). The executor branches on the
// number, so each verdict has its own code and its own documented next step:
//
//   0  valid       — a legal dispatch for this session's scope; go claim it.
//   10 invalid     — a forged or mangled dispatch. Comment the printed `reason`,
//                    remove the ready label, add `needs-human`, end the session.
//                    It never runs.
//   11 not-mine    — the trigger label is the OTHER executor's ready label, is no
//                    ready label at all, or the issue no longer carries one (a
//                    dispatch another session has already claimed). Stop. Change
//                    nothing, comment nothing.
//   13 needs-issue — a CCR trigger named the issue but carries no body/labels.
//                    Fetch THAT issue over MCP and re-invoke with them.
//   12 no-trigger  — NO source names an issue. STOP THE SESSION. There is no
//                    fallback: never select a dispatch by listing (see below).
//   2  usage       — bad invocation (an unknown scope argument, an unreadable
//                    `--issue-body-file`).
//   1  internal    — an unexpected fault in this shell.
//
// THERE IS NO FALLBACK, BY DESIGN. Exit 12 used to send the executor off to list
// the open dispatches and take the oldest. That is precisely the
// N-sessions-racing-over-N-issues failure the one-session-one-issue rule exists to
// prevent, reached from the other direction: one scheduler run files every due
// dispatch seconds apart, so every session that cannot name its own trigger builds
// the SAME work list and races over it. A session that does not know its issue
// must run nothing — the scheduler re-arms an unrun dispatch on its next hourly
// pass, so stopping costs a delay while guessing costs duplicated work.
//
// Usage: `node <engine>/scheduler/resolve-dispatch.mjs [self|fleet]`
//                `[--issue-body-file <path>] [--issue-labels <csv>]`
// The positional argument is THIS SESSION's scope — which of the two executor
// routines is running. It defaults to `self`, which is every ordinary project's
// executor; the FLEET routine must pass `fleet` explicitly, and a fleet payload
// arriving at a session that did not is reported as not-mine with that stated
// plainly. The two flags carry what a CCR trigger cannot, and are ignored on the
// Actions path (whose payload already has both).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISPATCH_PATH_RE, dispatchFirstLine, validateDispatchBody } from './validate-dispatch.mjs';
import { readyLabelForScope } from './dispatch.mjs';
import { SESSION_SCOPES } from './task-contract.mjs';
import { SHARED_SUBDIR } from '../pack_loader/pack-registry.mjs';

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalid: 10,
  notMine: 11,
  noTrigger: 12,
  needsIssue: 13,
};

// The executor scope a ready label implies — the exact inverse of the mapping the
// SCHEDULER files a dispatch under (`readyLabelForScope`), derived from it rather
// than restated, so the two can never drift. `null` = not a ready label at all.
export const scopeForLabel = (label) =>
  SESSION_SCOPES.find((scope) => readyLabelForScope(scope) === label) ?? null;

// Which checkout do the task paths in a dispatch body resolve against? Answered
// from where THIS engine copy is mounted, not from cwd — a consumer runs the
// vendored engine at `<root>/.claudinite/shared/engine/scheduler/`, the canon
// repo runs its own at `<root>/engine/scheduler/` (executor.md, "Engine command
// paths"). Deriving it from the module's own location means whichever copy the
// executor invoked resolves against that copy's own repo, with nothing to pass.
const MOUNT_SUFFIX = sep + SHARED_SUBDIR;
export function repoRootFrom(moduleUrl) {
  const home = dirname(dirname(dirname(fileURLToPath(moduleUrl)))); // <home>/engine/scheduler/<this file>
  return home.endsWith(MOUNT_SUFFIX) ? home.slice(0, -MOUNT_SUFFIX.length) : home;
}

// Read the webhook payload the label event was started with. Every way of not
// having one collapses to a single `{ error }` — unset, unreadable, unparsable —
// because the caller's response to all of them is the same: try the other
// trigger source, and stop the session if that names no issue either.
export function readEventPayload(env = process.env, read = (p) => readFileSync(p, 'utf8')) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return { error: 'GITHUB_EVENT_PATH is not set — this session has no event payload on disk' };
  let raw;
  try {
    raw = read(path);
  } catch (e) {
    return { error: `GITHUB_EVENT_PATH points at ${path}, which is unreadable: ${e.message}` };
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return { error: `the event payload at ${path} is not valid JSON: ${e.message}` };
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { error: `the event payload at ${path} is not an event object` };
  }
  return { event };
}

// The three facts a dispatch trigger must carry. Anything short of all three
// means the payload cannot name this session's issue — not a rejection of a
// dispatch, just this source failing to identify one; the caller tries the other
// source before giving up.
export function triggerFromEvent(event) {
  const action = event.action;
  const label = event.label?.name;
  const number = event.issue?.number;
  if (action !== 'labeled') return { error: `the event payload is a "${action}" event, not a label event — it names no dispatch` };
  if (typeof label !== 'string' || label === '') return { error: 'the label event carries no label.name' };
  if (!Number.isInteger(number)) return { error: 'the label event carries no issue.number' };
  return { trigger: { source: 'payload', label, number, body: event.issue?.body ?? '' } };
}

// The CCR trigger: same webhook, delivered as environment variables by Claude
// Code on the web, which writes no payload file. It names the issue and nothing
// else — no `label.name`, no `issue.body` — so the trigger it yields is
// deliberately PARTIAL, and `main` turns that into the two-shot `needs-issue`
// handshake rather than guessing either missing field.
export function triggerFromCcrEnv(env = process.env) {
  const source = env.CCR_TRIGGER_SOURCE;
  const event = env.CCR_TRIGGER_EVENT;
  const raw = env.CCR_TRIGGER_ISSUE_NUMBER;
  if (!source && !event && !raw) return { error: 'no CCR_TRIGGER_* variables are set either — this session carries no CCR trigger' };
  if (source !== 'github') return { error: `CCR_TRIGGER_SOURCE is ${JSON.stringify(source ?? null)}, not "github" — this session was not started by a GitHub event` };
  if (event !== 'issues.labeled') return { error: `CCR_TRIGGER_EVENT is ${JSON.stringify(event ?? null)}, not "issues.labeled" — it names no dispatch` };
  const number = Number(raw);
  if (!raw || !Number.isInteger(number) || number <= 0) return { error: `CCR_TRIGGER_ISSUE_NUMBER is ${JSON.stringify(raw ?? null)}, which is not an issue number` };
  return { trigger: { source: 'ccr', number, repo: env.CCR_TRIGGER_REPO ?? '' } };
}

// Identify this session's ONE dispatch from whichever transport carried it.
// Order is preference, not precedence-by-truth: the Actions payload is tried
// first only because it answers in one shot, and a session that somehow has both
// gets the same issue from either. Every failure of both sources is collected
// into one reason, because the executor prints it and then stops.
export function resolveTrigger(env = process.env, read) {
  const reasons = [];
  const { event, error: payloadError } = readEventPayload(env, read);
  if (payloadError) reasons.push(payloadError);
  else {
    const { trigger, error } = triggerFromEvent(event);
    if (trigger) return { trigger };
    reasons.push(error);
  }
  const { trigger: ccr, error: ccrError } = triggerFromCcrEnv(env);
  if (ccr) return { trigger: ccr };
  reasons.push(ccrError);
  return { error: reasons.join('; ') };
}

// `[scope] [--flag value|--flag=value]`. Kept deliberately tiny — the shell takes
// one positional and two flags, and a dependency-free parser is less surface than
// the alternative.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = argv[++i] ?? '';
  }
  return { positional, flags };
}

// Which of the issue's CURRENT labels is a ready label? On the CCR path this
// stands in for the `label.name` the trigger never carried — and it is strictly
// more informative than the event's: a dispatch another session already claimed
// no longer carries a ready label at all, so this catches the lost race here at
// step 1 rather than at the claim.
export function readyLabelAmong(labels) {
  const ready = labels.filter((l) => scopeForLabel(l) !== null);
  if (ready.length === 0) return { error: `it carries no ready label (it has: ${labels.join(', ') || 'none'}) — its dispatch has already been claimed or converged by another session` };
  if (ready.length > 1) return { error: `it carries more than one ready label (${ready.join(', ')}), so which executor owns it is ambiguous` };
  return { label: ready[0] };
}

// The block the executor reads. `key: value` lines, one fact per line: an agent
// quoting a field back must not have to parse prose, and a reader diffing two
// runs must see exactly what changed.
const block = (fields) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');

function done(code, fields, advice) {
  console.log(block(fields));
  if (advice) console.error(`resolve-dispatch: ${advice}`);
  process.exit(code);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const scopeGiven = positional.length > 0;
  const scope = positional[0] ?? 'self';
  if (!SESSION_SCOPES.includes(scope)) {
    console.error(`resolve-dispatch: unknown scope "${scope}" — usage: node resolve-dispatch.mjs [${SESSION_SCOPES.join('|')}] [--issue-body-file <path>] [--issue-labels <csv>]`);
    process.exit(EXIT.usage);
  }

  const { trigger, error: triggerError } = resolveTrigger();
  if (triggerError) {
    done(EXIT.noTrigger, { dispatch: 'no-trigger', scope, reason: triggerError },
      `${triggerError}. No trigger source names an issue, so this session cannot know which dispatch it was started for. STOP: run nothing, change nothing, comment nothing, end the session. There is NO fallback — never pick an issue by listing ${readyLabelForScope(scope)}; every dispatch in that list already has its own session, and the scheduler re-arms an unrun one on its next hourly pass.`);
  }

  let { label, number, body } = trigger;

  // The CCR handshake: the trigger named the issue, the executor fetched it over
  // MCP, and hands back here the two fields the environment could not carry.
  if (trigger.source === 'ccr') {
    const bodyFile = flags['issue-body-file'];
    const labelsCsv = flags['issue-labels'];
    if (bodyFile === undefined || labelsCsv === undefined) {
      done(EXIT.needsIssue, { dispatch: 'needs-issue', issue: number, scope, source: 'ccr', repo: trigger.repo || '(unset)' },
        `the CCR trigger names issue #${number} but carries neither its body nor its labels. Fetch ISSUE #${number} ALONE over MCP (its body and its current labels), write the body verbatim to a file, then re-run: node <engine>/scheduler/resolve-dispatch.mjs ${scope} --issue-body-file <path> --issue-labels <comma-separated current labels>. Do not list, select, or touch any other issue.`);
    }
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (e) {
      console.error(`resolve-dispatch: --issue-body-file ${bodyFile} is unreadable: ${e.message}`);
      process.exit(EXIT.usage);
    }
    const labels = labelsCsv.split(',').map((l) => l.trim()).filter(Boolean);
    const { label: ready, error: labelError } = readyLabelAmong(labels);
    if (labelError) {
      done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, labels: labels.join('|') || '(none)' },
        `issue #${number}: ${labelError}. Stop: change nothing, comment nothing.`);
    }
    label = ready;
  }

  const labelScope = scopeForLabel(label);
  if (labelScope === null) {
    done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, label },
      `issue #${number} was labeled "${label}", which is not a ready label — this is not an executor dispatch. Stop: change nothing, comment nothing.`);
  }
  if (labelScope !== scope) {
    done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, label, labelScope },
      `issue #${number} is labeled "${label}", a ${labelScope}-scoped dispatch, but this session's scope is "${scope}"${scopeGiven ? '' : ' (the default — pass "fleet" if this IS the fleet executor)'}. It is the other executor's to run and it already has a session. Stop: change nothing, comment nothing.`);
  }

  // The checkout the dispatch's task path must resolve in. `exists` reads the
  // working tree; in an executor session that IS HEAD (a fresh checkout, nothing
  // written yet), which is what validate-dispatch means by "exists at HEAD".
  const root = process.env.CLAUDINITE_REPO_ROOT || repoRootFrom(import.meta.url);
  const { loadConfig } = await import('../checks/helpers/repo-context.mjs');
  const declared = new Set(loadConfig(root).packs);

  // `loadTask` is SYNCHRONOUS by design — it keeps validate-dispatch's core pure
  // and sync-testable — but importing an .mjs is not, so the shell prefetches the
  // module here and the capability just replays the result (or rethrows the parse
  // failure, which is exactly what the core wants to report).
  const firstLine = dispatchFirstLine(body);
  const mjsRelative = firstLine.replace(/task\.md$/, 'task.mjs');
  let loaded = null;
  let loadError = null;
  if (DISPATCH_PATH_RE.test(firstLine) && existsSync(join(root, mjsRelative))) {
    try {
      loaded = (await import(pathToFileURL(join(root, mjsRelative)).href)).default;
    } catch (e) {
      loadError = e;
    }
  }

  const verdict = validateDispatchBody(body, {
    exists: (p) => existsSync(join(root, p)),
    isPackDeclared: (id) => declared.has(id),
    loadTask: () => { if (loadError) throw loadError; return loaded; },
  });

  if (!verdict.ok) {
    done(EXIT.invalid, { dispatch: 'invalid', issue: number, scope, label, reason: verdict.reason },
      `issue #${number} is not a valid dispatch: ${verdict.reason}. It must not run — comment naming what failed, remove the "${label}" label, add "needs-human", and end the session.`);
  }

  done(EXIT.ok, {
    dispatch: 'valid',
    issue: number,
    scope,
    label,
    source: trigger.source,
    taskPath: verdict.taskPath,
    pack: verdict.pack,
    task: verdict.task,
    model: verdict.model,
    resolvedModel: verdict.resolvedModel,
    outcome: verdict.outcome,
    executionTimeout: verdict.executionTimeout ?? 'none',
  });
}

// Run only when invoked directly (the executor's `node resolve-dispatch.mjs`),
// never on import — the exported helpers above are unit-testable without it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`resolve-dispatch: ${e.stack || e}`); process.exit(EXIT.internal); });
}
